// Resolve Cloudflare's helper and atomically cache an official release. Cancellation never publishes a partial binary.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const installed = () => new Promise((resolve) => execFile(process.platform === 'win32' ? 'where.exe' : 'which', ['cloudflared'],
  { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out).split('\n')[0].trim())));
export async function resolveTunnelBinary({ cacheFile, override = '', signal, onDownload = () => {},
  platform = process.platform, arch = process.arch, findInstalled = installed, fetcher = fetch }) {
  signal?.throwIfAborted();
  if (override) return override;
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).isFile()) return cacheFile;
  const existing = await findInstalled(); signal?.throwIfAborted();
  if (existing) return existing;
  const cpu = arch === 'arm64' ? 'arm64' : 'amd64';
  const asset = { darwin: `cloudflared-darwin-${cpu}.tgz`, linux: `cloudflared-linux-${cpu}`, win32: 'cloudflared-windows-amd64.exe' }[platform];
  if (!asset) throw Object.assign(new Error('Unsupported cloudflared platform'), { code: 'noPlatform' });
  onDownload();
  const response = await fetcher(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`, {
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw Object.assign(new Error('Cloudflared download failed'), { code: 'download', status: response.status });
  if (Number(response.headers.get('content-length')) > 256 * 1024 ** 2) throw new Error('Cloudflared download is too large');
  const bytes = Buffer.from(await response.arrayBuffer()); signal?.throwIfAborted();
  if (!bytes.length || bytes.length > 256 * 1024 ** 2) throw new Error('Invalid cloudflared download');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.download-${process.pid}`;
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o700 }); signal?.throwIfAborted();
    if (asset.endsWith('.tgz')) {
      const executable = await new Promise((resolve, reject) => execFile('tar', ['-xOzf', tmp, 'cloudflared'],
        { signal, windowsHide: true, encoding: 'buffer', maxBuffer: 256 * 1024 ** 2 }, (err, out) => err ? reject(err) : resolve(out)));
      signal?.throwIfAborted(); if (!executable.length) throw new Error('Empty cloudflared archive');
      fs.writeFileSync(tmp, executable, { mode: 0o700 });
    }
    signal?.throwIfAborted(); fs.renameSync(tmp, cacheFile);
    fs.chmodSync(cacheFile, 0o700);
    return cacheFile;
  } finally { fs.rmSync(tmp, { force: true }); }
}
