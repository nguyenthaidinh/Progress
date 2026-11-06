import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// Test-only socket metadata: exercise the real LAN authorization branch on a loopback listener.
// No production switch, external listener, destructive action or real provider account is used.
const remoteSocket = 'data:text/javascript,' + encodeURIComponent(`
  import http from 'node:http'; import { syncBuiltinESMExports } from 'node:module';
  const original = http.createServer;
  http.createServer = (...args) => {
    const handler = args.at(-1);
    if (typeof handler === 'function') args[args.length - 1] = (req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '198.51.100.20', configurable: true });
      return handler(req, res);
    };
    return original(...args);
  }; syncBuiltinESMExports();
`);
const base = `http://127.0.0.1:${(Number(process.env.E2E_PORT) || 4399) + 67}`;
let server: ChildProcess, dir: string, log = '';

test.beforeAll(async ({ request }) => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lioops-admin-e2e-'));
  server = spawn(process.execPath, ['--import', remoteSocket, 'server/index.mjs'], { windowsHide: true,
    env: { ...process.env, NODE_ENV: 'production', OFFICE_HOST: '127.0.0.1', OFFICE_PORT: new URL(base).port,
      OFFICE_DATA_DIR: dir, USERPROFILE: dir, HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'), CODEX_HOME: path.join(dir, '.codex'),
      OFFICE_CODEX: '0', OFFICE_CODEX_DESKTOP: '0', OFFICE_USAGE: '0', OFFICE_TRANSLATE: '0', OFFICE_CI: '0',
      OFFICE_PUBLIC_URL: '', OFFICE_TUNNEL_TOKEN_FILE: '', OFFICE_ACCESS_TEAM_DOMAIN: '', OFFICE_ACCESS_AUD: '', OFFICE_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout?.on('data', data => { log += data; }); server.stderr?.on('data', data => { log += data; });
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error(log.slice(-1500));
    try { return (await request.get(`${base}/health`)).ok(); } catch { return false; }
  }, { timeout: 60000 }).toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  if (dir && fs.existsSync(dir)) {
    const root = fs.realpathSync(os.tmpdir()), target = fs.realpathSync(dir);
    if (path.dirname(target) !== root || !path.basename(target).startsWith('lioops-admin-e2e-')) throw new Error('Unsafe fixture cleanup path');
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('an authenticated LAN viewer can read metrics but cannot invoke local machine administration', async ({ request }) => {
  await request.get(`${base}/pin`);
  // This file belongs to the temporary fixture, not the user's office.
  const pin = fs.readFileSync(path.join(dir, 'pin'), 'utf8').trim();
  expect(pin).toMatch(/^\d{6,10}$/);
  const login = await request.post(`${base}/pin`, { form: { pin }, maxRedirects: 0 });
  expect(login.status()).toBe(303);
  expect((await request.get(`${base}/api/sys`)).status()).toBe(200);
  // Invalid action is deliberate: a failed authorization test must not affect the real machine.
  const action = await request.post(`${base}/api/sys/action`, { data: { action: 'fixture-invalid', target: 'none' } });
  expect(action.status()).toBe(403);
  const auto = await request.post(`${base}/api/sys/auto`, { data: { hours: 0 } });
  expect(auto.status()).toBe(403);
});
