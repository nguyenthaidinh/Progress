import { test, expect, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const PORT = (Number(process.env.E2E_PORT) || 4399) + 64, BASE = `http://127.0.0.1:${PORT}`;
const VIA = `http://127.0.0.1:${PORT + 7}`, ORIGIN = 'https://e2e-office-test.trycloudflare.com';
let server: ChildProcess, dir: string, project: string, cookie = '';
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const receipt = (text: string) => ({ dir: project, agent: 'codex', text, fresh: true, requestId: crypto.randomUUID() });
async function boot(extra: Record<string, string> = {}, preload = '') {
  server = spawn(process.execPath, [...(preload ? ['--import', preload] : []), 'server/index.mjs'], { env: { ...process.env,
    OFFICE_PUBLIC_URL: '', OFFICE_TUNNEL_TOKEN_FILE: '', OFFICE_ACCESS_TEAM_DOMAIN: '', OFFICE_ACCESS_AUD: '', OFFICE_TUNNEL_PROTOCOL: 'auto',
    NODE_ENV: 'production', OFFICE_PORT: String(PORT), OFFICE_DATA_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
    OFFICE_CODEX: '1', OFFICE_CODEX_BIN: path.resolve('tests/fixtures/codex/fake-app-server.mjs'), OFFICE_CODEX_TEST_CWD: project,
    CODEX_HOME: path.join(dir, '.codex'), OFFICE_TUNNEL_CMD: path.resolve('tests/fixtures/fake-cloudflared.mjs'),
    OFFICE_USAGE: '0', OFFICE_TRANSLATE: '0', OFFICE_CI: '0', OFFICE_LANG: 'en', ...extra }, stdio: 'ignore', windowsHide: true });
  await expect.poll(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }).toBe(true);
  await expect.poll(async () => (await (await fetch(`${BASE}/api/tasks`)).json()).codex.available).toBe(true);
}
async function halt() {
  if (server?.exitCode === null) { server.kill(); await new Promise((r) => server.once('exit', r)); }
}
const headers = () => ({ Host: new URL(ORIGIN).host, Origin: ORIGIN, Cookie: cookie });
const remote = (r: APIRequestContext, route: string, body: object) => r.post(`${VIA}${route}`, { headers: headers(), data: body });
const snapshot = async (r: APIRequestContext) => (await (await r.get(`${VIA}/api/live`, { headers: headers() })).json()).msgs.find((m: { k: string }) => m.k === 'snap');
const tasks = async (r: APIRequestContext) => (await r.get(`${VIA}/api/tasks`, { headers: headers() })).json();
async function approval(r: APIRequestContext) {
  await expect.poll(async () => (await snapshot(r)).perms.length).toBe(1);
  return (await snapshot(r)).perms[0];
}
test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-remote-codex-')); project = path.join(dir, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  await boot();
});

test('Tunnel cancellation during startup and stale PID protection on Windows @smoke', async ({ request }) => {
  test.setTimeout(90_000);
  const tunnel = async () => (await request.get(`${BASE}/api/tunnel`)).json();
  await request.post(`${BASE}/api/tunnel`, { data: { on: true } });
  const pidFile = path.join(dir, 'tunnel.pid');
  await expect.poll(() => { try { return Number(fs.readFileSync(pidFile, 'utf8')) > 1; } catch { return false; } }).toBe(true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await request.post(`${BASE}/api/tunnel`, { data: { on: false } });
  await expect.poll(async () => (await tunnel()).state).toBe('off');
  await expect.poll(() => alive(pid)).toBe(false);
  // Reused PIDs must not be killed or adopted. The server itself stands in for an unrelated process.
  fs.writeFileSync(path.join(dir, 'tunnel.json'), JSON.stringify({ version: 2, pid: server.pid, port: PORT + 7,
    url: ORIGIN, identity: { file: 'wrong-process', born: 'reused', command: 'wrong' } }));
  await request.post(`${BASE}/api/tunnel`, { data: { on: true } });
  await expect.poll(async () => (await tunnel()).state).toBe('error');
  expect((await request.get(`${BASE}/health`)).ok()).toBe(true);
  await request.post(`${BASE}/api/tunnel`, { data: { on: false } });
  fs.rmSync(path.join(dir, 'tunnel.json'), { force: true }); fs.rmSync(pidFile, { force: true });
  await request.post(`${BASE}/api/tunnel`, { data: { on: false } });
  expect((await tunnel()).state).toBe('off');
});
test.afterAll(async () => {
  try { await fetch(`${BASE}/api/tunnel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' }); } catch { /* server may be down */ }
  await halt();
  // A failed test may have killed the server before it could stop its owned fixture helper.
  try { const s = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8')); if (s.pid > 1 && alive(s.pid)) {
    const { tunnelIdentity, sameTunnelIdentity } = await import('../../server/tunnel-process.mjs');
    if (sameTunnelIdentity(s.identity, await tunnelIdentity(s.pid))) process.kill(s.pid);
  } } catch { /* none */ }
  if (dir && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
});

test('Remote Codex: PIN, permissions, deduplication, approvals, reconnect and Windows restart @smoke', async ({ request, page }) => {
  test.setTimeout(180_000);
  await request.post(`${BASE}/api/tunnel`, { data: { on: true } });
  const tunnel = async () => (await request.get(`${BASE}/api/tunnel`)).json();
  await expect.poll(async () => (await tunnel()).state).toBe('on');
  const info = await tunnel();
  expect((await request.get(`${VIA}/api/tasks`, { headers: { Host: new URL(ORIGIN).host } })).status()).toBe(401);
  expect((await request.get(`${VIA}/api/tasks`, { headers: { Host: 'evil.example' } })).status()).toBe(421);
  const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  expect((await request.get(`${VIA}/api/tasks?k=${token}`, { headers: { Host: new URL(ORIGIN).host } })).status()).toBe(401);
  const login = await request.post(`${VIA}/pin`, { headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN }, form: { pin: info.pin }, maxRedirects: 0 });
  expect(login.status()).toBe(303); expect(login.headers()['set-cookie']).toContain('Secure');
  cookie = login.headers()['set-cookie'].split(';')[0];
  const body = receipt('Remote fixture work');
  expect((await remote(request, '/api/tasks', body)).status()).toBe(403);
  expect((await remote(request, '/api/tasks/allow', { on: true })).status()).toBe(403);
  expect((await remote(request, '/api/tasks/desktop', { on: true })).status()).toBe(403);
  expect((await remote(request, '/api/tasks/open-codex', { sid: 'external-codex-fixture' })).status()).toBe(403);
  expect((await remote(request, '/event', { hook_event_name: 'SessionStart' })).status()).toBe(403);
  await request.post(`${BASE}/api/tasks/allow`, { data: { on: true } });
  expect((await remote(request, '/api/tasks', { ...body, requestId: undefined })).status()).toBe(400);
  expect((await remote(request, '/api/tasks', { ...body, dir: os.tmpdir() })).status()).toBe(400);
  expect((await request.post(`${VIA}/api/tasks`, { headers: { ...headers(), Origin: 'https://evil.example' }, data: body })).status()).toBe(403);
  const [a, b] = await Promise.all([remote(request, '/api/tasks', body), remote(request, '/api/tasks', body)]);
  const run = (await a.json()).task; expect(run?.id).toBeTruthy(); expect((await b.json()).task.id).toBe(run.id);
  expect((await remote(request, '/api/tasks/desktop', { on: false })).status()).toBe(403);
  expect((await remote(request, '/api/tasks/open-codex', { sid: 'external-codex-fixture' })).status()).toBe(404);
  expect((await remote(request, '/api/tasks/open-codex', { sid: run.sid })).status()).toBe(409); // Test env disables native app launching; ownership passed.
  expect((await tasks(request)).running).toHaveLength(1);
  expect((await remote(request, '/api/tasks', { ...body, text: 'Changed content' })).status()).toBe(409);
  const steer = { task: run.id, text: 'Check the fixture first', requestId: crypto.randomUUID() };
  expect((await remote(request, '/api/tasks/steer', steer)).ok()).toBe(true);
  expect((await remote(request, '/api/tasks/steer', steer)).ok()).toBe(true);
  let p = await approval(request);
  expect((await remote(request, '/api/perm', { id: p.id, choice: 'allow' })).status()).toBe(403);
  await request.post(`${BASE}/api/phone`, { data: { approve: true } });
  expect((await remote(request, '/api/perm', { id: p.id, choice: 'always' })).status()).toBe(403);
  expect((await remote(request, '/api/perm', { id: p.id, choice: 'allow' })).ok()).toBe(true);
  await expect.poll(async () => (await tasks(request)).running.length).toBe(0);
  expect((await (await request.get(`${VIA}/api/chat`, { headers: headers() })).json()).msgs.some((m: { tag: string; text: string }) => m.tag === 'codex' && m.text.includes('Codex completed'))).toBe(true);
  await remote(request, '/api/tasks', receipt('fixture-risky'));
  p = await approval(request); expect((await remote(request, '/api/perm', { id: p.id, choice: 'allow' })).status()).toBe(403);
  expect((await remote(request, '/api/perm', { id: p.id, choice: 'deny' })).ok()).toBe(true);
  await expect.poll(async () => (await tasks(request)).running.length).toBe(0);
  await remote(request, '/api/tasks', receipt('fixture-question'));
  p = await approval(request); expect(p.kind).toBe('ask');
  expect((await remote(request, '/api/perm', { id: p.id, choice: 'answer', answers: [{ q: 0, pick: [0] }] })).ok()).toBe(true);
  await expect.poll(async () => (await tasks(request)).running.length).toBe(0);
  const stopRun = (await (await remote(request, '/api/tasks', receipt('Stop remotely'))).json()).task;
  expect((await remote(request, '/api/tasks/stop', { id: stopRun.id })).ok()).toBe(true);
  await expect.poll(async () => (await tasks(request)).running.length).toBe(0);

  // Simulate the HTTPS transport in-process. Every browser request reaches the actual untrusted listener; no public
  // tunnel, model, CLI login or user project is touched. Drop a delivered POST response AND its status read once.
  const ids: string[] = [], browserErrors: string[] = []; let losePost = true, loseRead = true, closing = false;
  page.on('pageerror', (e) => browserErrors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); localStorage.setItem('office-lite', 'on'); });
  const eq = cookie.indexOf('=');
  await page.context().addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: ORIGIN, secure: true, httpOnly: true, sameSite: 'Lax' }]);
  await page.route(`${ORIGIN}/**`, async (route) => {
    try {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === '/api/tasks/request' && loseRead) { loseRead = false; await route.abort(); return; }
    const response = await request.fetch(`${VIA}${url.pathname}${url.search}`, { method: req.method(),
      headers: { ...req.headers(), host: new URL(ORIGIN).host, cookie, ...(req.method() === 'POST' ? { origin: ORIGIN } : {}) },
      ...(req.postDataBuffer() && { data: req.postDataBuffer()! }), maxRedirects: 0, maxRetries: req.method() === 'GET' ? 2 : 0 });
    if (url.pathname === '/api/tasks' && req.method() === 'POST') {
      ids.push(req.postDataJSON().requestId);
      if (losePost) { losePost = false; await route.abort(); return; }
    }
    await route.fulfill({ response });
    } catch (err) {
      if (!closing) browserErrors.push(err instanceof Error ? err.message.split('\n')[0] : 'Browser proxy failed');
      await route.abort().catch(() => {});
    }
  });
  await page.goto(`${ORIGIN}/?layout=cozy`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#btn-give-work').click();
  await expect(page.getByRole('combobox', { name: 'AI assistant' })).toHaveValue('codex');
  await expect(page.locator('.ph-tab[data-tab="work"]')).toHaveAttribute('aria-selected', 'true');
  const giveBox = await page.locator('#btn-give-work').boundingBox();
  expect(giveBox && giveBox.x >= 0 && giveBox.x + giveBox.width <= 390).toBeTruthy();
  await page.screenshot({ path: test.info().outputPath('remote-codex-phone.png'), animations: 'disabled' });
  await page.locator('textarea.aw-prompt').fill('Browser reconnect fixture');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === 'office-pending-task-requests') throw new Error('Storage blocked by fixture'); original.call(this, key, value); };
    Object.assign(window, { restoreFixtureStorage: () => { Storage.prototype.setItem = original; } });
  });
  await page.locator('.aw-send').click();
  await expect(page.locator('.aw-feedback')).toContainText('browser cannot save');
  expect(ids).toHaveLength(0); expect((await tasks(request)).running).toHaveLength(0);
  await page.evaluate(() => (window as unknown as { restoreFixtureStorage: () => void }).restoreFixtureStorage());
  await page.locator('.aw-send').click();
  await expect(page.locator('.aw-feedback')).toContainText('Connection lost');
  expect((await tasks(request)).running).toHaveLength(1);
  const savedBrowser = await page.evaluate(() => sessionStorage.getItem('office-pending-task-requests'));
  expect(savedBrowser).not.toContain('Browser reconnect fixture'); expect(savedBrowser).toContain(ids[0]);
  await page.reload(); await page.locator('#btn-give-work').click();
  await page.locator('textarea.aw-prompt').fill('Browser reconnect fixture'); await page.locator('.aw-send').click();
  await expect(page.locator('.aw-prompt-text')).toContainText('Browser reconnect fixture'); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]);
  expect((await tasks(request)).running).toHaveLength(1);
  p = await approval(request); await remote(request, '/api/perm', { id: p.id, choice: 'deny' });
  await expect.poll(async () => (await tasks(request)).running.length).toBe(0);
  await page.screenshot({ path: test.info().outputPath('remote-codex.png') });
  expect(browserErrors).toEqual([]); closing = true;
  await page.close();

  const savedTunnel = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8'));
  await halt(); expect(alive(savedTunnel.pid)).toBe(true); await boot();
  await expect.poll(async () => (await tunnel()).state).toBe('on');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8')).pid).toBe(savedTunnel.pid);
  expect((await (await remote(request, '/api/tasks', body)).json()).task.id).toBe(run.id);
  expect((await tasks(request)).running).toHaveLength(0); // A receipt survives restart; a prompt is never replayed.
  const status = await request.get(`${VIA}/api/tasks/request?id=${body.requestId}`, { headers: headers() });
  expect((await status.json()).state).toBe('done');
  await request.post(`${BASE}/api/tasks/allow`, { data: { on: false } });
  expect((await remote(request, '/api/tasks', body)).status()).toBe(403);
  expect((await request.get(`${VIA}/api/tasks/request?id=${body.requestId}`, { headers: headers() })).status()).toBe(403);
  await request.post(`${BASE}/api/tunnel`, { data: { on: false } });
  await expect.poll(() => alive(savedTunnel.pid)).toBe(false);
  await expect.poll(async () => { try { await fetch(`${VIA}/health`); return true; } catch { return false; } }).toBe(false);
});

test('Managed listener validates signed Access JWTs before PIN and preserves the gate across restart @smoke', async ({ request }) => {
  test.setTimeout(90_000); await halt();
  const origin = 'https://office.example.com', issuer = 'https://fixture-team.cloudflareaccess.com';
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = { keys: [{ ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }] };
  // Test-process-only transport interception for the public JWKS endpoint; production has no key or auth bypass.
  const preload = 'data:text/javascript,' + encodeURIComponent(`const original=globalThis.fetch;globalThis.fetch=(url,opts)=>String(url)==='${issuer}/cdn-cgi/access/certs'?Promise.resolve(new Response(${JSON.stringify(JSON.stringify(keys))},{headers:{'content-type':'application/json'}})):original(url,opts);`);
  const tokenFile = path.join(dir, 'cloudflare-fixture-token.txt'); fs.writeFileSync(tokenFile, 'fake-tunnel-token-not-a-credential');
  const env = { OFFICE_PUBLIC_URL: origin, OFFICE_TUNNEL_TOKEN_FILE: tokenFile, OFFICE_ACCESS_TEAM_DOMAIN: issuer, OFFICE_ACCESS_AUD: 'office-fixture' };
  await boot(env, preload); await request.post(`${BASE}/api/tunnel`, { data: { on: true } });
  const info = async () => (await request.get(`${BASE}/api/tunnel`)).json();
  await expect.poll(async () => (await info()).state).toBe('on');
  expect((await info()).url).toBe(origin); expect((await info()).mode).toBe('managed'); expect((await info()).access).toBe(true);
  const host = { Host: new URL(origin).host, Origin: origin };
  for (const route of ['/pin', '/api/tasks', '/health', '/_next/static/fixture.js']) expect((await request.get(`${VIA}${route}`, { headers: host })).status()).toBe(403);
  const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(issuer).setAudience('office-fixture').setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const access = { ...host, 'Cf-Access-Jwt-Assertion': jwt };
  expect((await request.get(`${VIA}/health`, { headers: access })).status()).toBe(200);
  expect((await request.get(`${VIA}/api/tasks`, { headers: access })).status()).toBe(401); // Access never substitutes for the Office PIN.
  const login = await request.post(`${VIA}/pin`, { headers: access, form: { pin: (await info()).pin }, maxRedirects: 0 });
  expect(login.status()).toBe(303); expect(login.headers()['set-cookie']).toContain('Secure');
  const both = { ...access, Cookie: login.headers()['set-cookie'].split(';')[0] };
  expect((await request.get(`${VIA}/api/tasks`, { headers: both })).status()).toBe(200);
  expect((await request.get(`${VIA}/api/tasks`, { headers: { ...both, 'Cf-Access-Jwt-Assertion': jwt + 'forged' } })).status()).toBe(403);
  expect((await request.get(`${VIA}/api/tasks`, { headers: { ...host, Cookie: both.Cookie } })).status()).toBe(403);
  expect((await request.post(`${VIA}/api/tasks/allow`, { headers: both, data: { on: true } })).status()).toBe(403);
  expect((await request.post(`${VIA}/event`, { headers: both, data: { hook_event_name: 'SessionStart' } })).status()).toBe(403);
  const pid = JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8')).pid;
  await halt(); await boot(env, preload); await expect.poll(async () => (await info()).state).toBe('on');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'tunnel.json'), 'utf8')).pid).toBe(pid);
  expect((await request.get(`${VIA}/api/tasks`, { headers: both })).status()).toBe(200);
  expect((await request.get(`${VIA}/api/tasks`, { headers: host })).status()).toBe(403);
  await request.post(`${BASE}/api/tunnel`, { data: { on: false } }); await expect.poll(() => alive(pid)).toBe(false);
});
