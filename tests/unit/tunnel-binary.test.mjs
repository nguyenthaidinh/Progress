import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveTunnelBinary } from '../../server/tunnel-binary.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tunnel-binary-')), cacheFile = path.join(root, 'bin', 'cloudflared.exe');
  t.after(() => { if (path.dirname(root) === os.tmpdir()) fs.rmSync(root, { recursive: true, force: true }); });
  return { cacheFile, platform: 'win32', findInstalled: async () => '' };
}
test('Only complete downloads are published and cached; cache reuse does not fetch again', async (t) => {
  const f = fixture(t); let downloads = 0;
  assert.equal(await resolveTunnelBinary({ ...f, fetcher: async (url) => {
    assert.equal(url, 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'); downloads++;
    return new Response('fixture binary; never executed');
  } }), f.cacheFile);
  assert.equal(fs.readFileSync(f.cacheFile, 'utf8'), 'fixture binary; never executed');
  await resolveTunnelBinary({ ...f, fetcher: () => assert.fail('Fetched cached binary') }); assert.equal(downloads, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.cacheFile)), ['cloudflared.exe']);
});
test('Cancellation during fetch and during body download never leaves a cached executable', async (t) => {
  const f = fixture(t), controller = new AbortController(); let started;
  const begin = new Promise((r) => { started = r; });
  const work = resolveTunnelBinary({ ...f, signal: controller.signal, fetcher: async (url, { signal }) => {
    started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await begin; controller.abort(); await assert.rejects(work); assert.equal(fs.existsSync(f.cacheFile), false);
  const bodyController = new AbortController();
  await assert.rejects(resolveTunnelBinary({ ...f, signal: bodyController.signal, fetcher: async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => {
    bodyController.abort(); return new TextEncoder().encode('partial').buffer;
  } }) }));
  assert.equal(fs.existsSync(f.cacheFile), false);
});
test('Failed, empty and oversized releases never become cached helpers', async (t) => {
  const f = fixture(t);
  for (const response of [new Response('error', { status: 503 }), new Response(''), new Response('too large', { headers: { 'content-length': String(257 * 1024 ** 2) } })]) {
    await assert.rejects(resolveTunnelBinary({ ...f, fetcher: async () => response })); assert.equal(fs.existsSync(f.cacheFile), false);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveTunnelBinary({ ...f, signal: controller.signal, findInstalled: () => assert.fail('Looked up after cancel') }));
});
