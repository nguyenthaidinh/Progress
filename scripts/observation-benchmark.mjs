// Measures the actual headless CLI child against isolated logs; excludes provider and browser/3D resources.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRelay } from '../relay/server.mjs';
import { randomSecret } from '../src/shared/remote/crypto.js';
import { createBrowserPair, createEncryptedRelaySource } from '../src/office/data/encrypted-relay.js';
import { createOfficeClient } from '../src/office/data/client.js';
const seconds = Number(process.argv.find(arg => arg.startsWith('--seconds='))?.slice(10) || 30);
if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 600) throw new Error('Benchmark duration must be 5-600 seconds');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lioops-observe-bench-')), project = path.join(dir, 'project'), logs = path.join(dir, 'codex'), claude = path.join(dir, 'claude');
const adminToken = randomSecret(), { server } = createRelay({ adminToken, origins: ['http://127.0.0.1:8000'] });
let child, client, log = '', metadata;
const wait = async fn => { const start = Date.now(); while (!await fn()) { if (Date.now() - start > 45000) throw new Error('Benchmark setup timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } };
try {
  for (const folder of [project, logs, claude]) await fs.mkdir(folder);
  const timestamp = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    const rows = [JSON.stringify({ type: 'session_meta', timestamp, payload: { id: `bench-${i}`, cwd: project } }),
      JSON.stringify({ type: 'turn_context', timestamp, payload: { cwd: project, model: 'fixture' } })];
    for (let j = 0; j < 100; j++) rows.push(JSON.stringify({ type: 'event_msg', timestamp, payload: { type: j % 2 ? 'agent_message' : 'user_message', message: `${j}:` + 'x'.repeat(5000) } }));
    await fs.writeFile(path.join(logs, `${i}.jsonl`), rows.join('\n') + '\n');
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  child = spawn(process.execPath, ['connector/index.mjs', '--project', project, '--codex-logs', logs, '--claude-logs', claude, '--metrics'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      LIOOPS_RELAY_URL: `http://127.0.0.1:${server.address().port}`, LIOOPS_WEB_URL: 'http://127.0.0.1:8000/', LIOOPS_RELAY_ADMIN_TOKEN: adminToken,
      LIOOPS_CONNECTOR_DATA: path.join(dir, 'state'), CODEX_HOME: path.join(dir, 'provider-codex'), CLAUDE_CONFIG_DIR: path.join(dir, 'provider-claude') },
  });
  child.stdout.on('data', data => { log = (log + data).slice(-4000); }); child.stderr.resume();
  await wait(() => log.includes('#control='));
  const controlURL = new URL(log.match(/http:\/\/127\.0\.0\.1:\d+\/#control=[A-Za-z0-9_-]+/)[0]);
  const token = new URLSearchParams(controlURL.hash.slice(1)).get('control');
  async function control(action, body = {}) {
    const response = await fetch(`${controlURL.origin}/control/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Benchmark control failed'); return response.json();
  }
  const idle = (await control('status')).state.runtime, startMs = Date.now() - started, invite = (await control('status')).inviteURL;
  const record = await createBrowserPair(JSON.parse(new URLSearchParams(new URL(invite).hash.slice(1)).get('lioops-pair')));
  client = createOfficeClient(); client.connect(createEncryptedRelaySource({ record, save: async () => {}, onObservation: value => { metadata = value; } }));
  let pending; await wait(async () => { pending = (await control('status')).state.pending; return !!pending; });
  await control('approve', { fingerprint: pending.fingerprint, epoch: pending.epoch });
  await wait(() => metadata?.sessions === 20);
  const first = (await control('status')).state.runtime, samples = [], beginning = Date.now();
  while (Date.now() - beginning < seconds * 1000) {
    samples.push({ at: Date.now(), ...(await control('status')).state.runtime });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const last = (await control('status')).state.runtime, durationMs = Date.now() - beginning;
  const report = { date: new Date().toISOString().slice(0, 10), scope: 'Actual isolated Connector CLI; 20 synthetic ~500KB logs; loopback relay and Node observer, no real provider/model or 3D browser',
    platform: process.platform, node: process.version, startupMs: startMs, idleRssBytes: idle.rssBytes, activeRssBytes: last.rssBytes,
    peakSampledRssBytes: Math.max(...samples.map(value => value.rssBytes)), durationMs,
    averageCpuPctOfOneLogicalCore: Math.round((last.cpuMicros - first.cpuMicros) / (durationMs * 10) * 100) / 100,
    parsedFiles: last.parses, cacheHits: last.cacheHits, scans: last.scans,
    caveat: 'Node Connector process only; excludes transient PowerShell credential helper, provider and browser resources. Short steady fixture measurement after indexing; not an 8-hour soak, installer measurement or cross-device performance guarantee' };
  await fs.mkdir('test-results-release-checks', { recursive: true }); await fs.writeFile('test-results-release-checks/d-benchmark.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close();
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  const target = await fs.realpath(dir), root = await fs.realpath(os.tmpdir());
  if (path.dirname(target) !== root || !path.basename(target).startsWith('lioops-observe-bench-')) throw new Error('Unsafe benchmark cleanup');
  await fs.rm(target, { recursive: true, force: true });
}
