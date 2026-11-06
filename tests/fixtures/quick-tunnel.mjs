// Opt-in acceptance only. Own process/config; never reuses the user's running tunnel or exposes the PC app.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
export async function quickTunnel(origin, directory) {
  const configPath = path.join(directory, 'cloudflared-test.yml');
  await fs.writeFile(configPath, 'no-autoupdate: true\n', { flag: 'wx' });
  const binary = process.env.LIOOPS_CLOUDFLARED || fileURLToPath(new URL('../../data/bin/cloudflared.exe', import.meta.url));
  const env = { ...process.env, NO_AUTOUPDATE: 'true' };
  for (const key of Object.keys(env)) if (key.startsWith('TUNNEL_')) delete env[key];
  const child = spawn(binary, ['tunnel', '--config', configPath, '--no-autoupdate', '--url', origin, '--protocol', 'http2'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', failure = null;
  child.stdout.on('data', data => { output = (output + data).slice(-16000); }); child.stderr.on('data', data => { output = (output + data).slice(-16000); });
  child.on('error', error => { failure = error; });
  async function close() { if (child.exitCode === null && child.pid) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  try {
    const start = Date.now(); let url;
    while (!url) {
      if (failure || child.exitCode !== null || Date.now() - start > 60000) throw new Error(`Temporary HTTPS relay tunnel could not start (exit ${child.exitCode}): ${failure?.message || output.slice(-1500)}`);
      url = output.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/)?.[0];
      if (!url) await new Promise(resolve => setTimeout(resolve, 200));
    }
    while (Date.now() - start < 90000) {
      try { const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' }); if (response.ok && (await response.json()).ok === true) return { url, close }; }
      catch { /* DNS/TLS ingress may need a few seconds to become ready. */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Temporary HTTPS relay did not become reachable');
  } catch (error) { await close(); throw error; }
}
