#!/usr/bin/env node
// Opt-in browser -> real Office server -> real Codex acceptance checks. No model or API mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { createCodexRpc } from '../server/providers/codex-rpc.mjs';
import { redact } from '../server/redact.mjs';
import { contextBudget } from '../src/shared/token-budget.js';
import { fixtureCommands } from './lib/codex-fixture-commands.mjs';

if (!process.argv.includes('--run')) {
  console.log('Runs real Codex through the Office UI using your CLI login and model quota. Run: npm run test:codex:ui:live -- --run. Add --remote for a temporary real HTTPS tunnel (closed after the test).');
  process.exit(0);
}
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const remote = process.argv.includes('--remote');
const selected = process.argv.find((x) => x.startsWith('--scenario='))?.slice(11) || 'all';
assert.ok(['all', 'stop', 'usage'].includes(selected), 'Supported UI scenarios: all, stop, usage');
fs.mkdirSync(path.join(ROOT, 'test-results-codex-live'), { recursive: true });
const runRoot = fs.mkdtempSync(path.join(ROOT, 'test-results-codex-live', 'ui-'));
const project = path.join(runRoot, 'sample-project'), dataDir = path.join(runRoot, 'office-state');
fs.mkdirSync(project); fs.mkdirSync(dataDir); fs.mkdirSync(path.join(runRoot, 'markers'));
for (const name of ['calculator.cjs', 'checks.cjs']) fs.copyFileSync(new URL(`../tests/fixtures/codex/project/${name}.txt`, import.meta.url), path.join(project, name));
if (selected === 'stop') fs.writeFileSync(path.join(project, 'calculator.cjs'), 'exports.total = (items) => items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n');
let expectedChecks = fs.readFileSync(path.join(project, 'checks.cjs'), 'utf8');
const markerScript = "const fs = require('node:fs'); const path = require('node:path'); const mode = process.argv[2]; if (!['allow', 'deny'].includes(mode)) throw Error('Unexpected mode'); fs.appendFileSync(path.join(__dirname, '..', 'markers', mode + '.txt'), 'once\\n');\n";
fs.writeFileSync(path.join(project, 'approval.cjs'), markerScript);
fs.writeFileSync(path.join(project, 'AGENTS.md'), 'This is a disposable UI acceptance project. No network, dependency installation, delegation, unrelated files or detached processes. Use the built-in shell for commands. Do not modify checks.cjs, approval.cjs or wait.cjs.\n');
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([project]));
const reportFile = path.join(runRoot, 'report.json');
const report = { startedAt: new Date().toISOString(), transport: remote ? 'real-browser-cloudflare-https-real-server-real-codex' : 'real-browser-real-server-real-codex', scenarios: [], screenshots: [], browserErrors: [] };
const ownTasks = new Set();
let server, browser, page, base, pageBase, phase = '';
function save() { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
function record(kind, detail = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), phase, kind, ...detail })); save(); }
async function json(url, options) {
  const r = await fetch(`${base}${url}`, { ...options, signal: AbortSignal.timeout(20_000) });
  assert.equal(r.ok, true, `Office ${url}: HTTP ${r.status}`); return r.json();
}
async function until(fn, description, timeout = 240_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(500); }
  throw new Error(`Timed out: ${description}`);
}
async function scenario(name, fn) {
  if (selected === 'stop' && name !== 'ui-stop') return;
  if (selected === 'usage' && name !== 'ui-usage') return;
  phase = name; const at = Date.now(); record('begin');
  try { const result = await fn(); report.scenarios.push({ name, ok: true, ms: Date.now() - at, ...result }); record('pass'); }
  catch (e) { report.scenarios.push({ name, ok: false, ms: Date.now() - at, error: redact(e.message) }); record('fail', { error: redact(e.message) }); throw e; }
}
function checkProject(success = true) {
  assert.equal(fs.readFileSync(path.join(project, 'checks.cjs'), 'utf8'), expectedChecks, 'Acceptance tests were changed');
  assert.equal(fs.readFileSync(path.join(project, 'approval.cjs'), 'utf8'), markerScript, 'Approval fixture was changed');
  const result = spawnSync(process.execPath, ['--test', 'checks.cjs'], { cwd: project, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
}
async function screenshot(locator, name) {
  const file = path.join(runRoot, name); await locator.screenshot({ path: file });
  report.screenshots.push(name); save();
}
async function work(task) { return (await json('/api/chat')).msgs.find((m) => m.work?.task === task.id); }
function row(id) { return page.locator(`.zc-row[data-id="${id}"]`); }
async function submit(text, { resume = false } = {}) {
  await page.locator('.zc-task-btn').click();
  const options = page.locator('.zc-task-o').filter({ hasText: project });
  // The project's existing conversation is listed before its "new conversation" folder.
  await (resume ? options.first() : options.last()).click();
  if (!resume) await page.getByRole('combobox', { name: 'Coding agent', exact: true }).selectOption('codex');
  await expect(page.getByRole('combobox', { name: 'Coding agent', exact: true })).toHaveValue('codex');
  await page.locator('textarea.zc-task-in').fill(text);
  const sent = page.waitForResponse((r) => r.url() === `${pageBase}/api/tasks` && r.request().method() === 'POST', { timeout: 150_000 });
  await page.locator('.zc-task-go').click();
  const response = await sent, result = await response.json();
  assert.equal(response.ok() && result.ok, true, result.message || result.code);
  assert.equal(result.task.agent, 'codex'); assert.equal(result.task.dir, project);
  ownTasks.add(result.task.id); record('submitted-via-ui', { task: result.task.id });
  if (remote) {
    const duplicate = await page.request.post(`${pageBase}/api/tasks`, { headers: { Origin: pageBase }, data: response.request().postDataJSON() });
    assert.equal(duplicate.ok(), true, 'Remote receipt retry failed');
    assert.equal((await duplicate.json()).task.id, result.task.id, 'Remote retry started a different task');
    report.remote.deduplicatedSends++;
  }
  await expect(page.locator('.zc-task')).toBeHidden();
  await until(() => work(result.task), 'work card created');
  return result.task;
}
async function complete(task, expectedState = 'done') {
  const card = await until(async () => {
    const card = await work(task);
    return card && ['done', 'fail', 'stopped'].includes(card.work.state) ? card : null;
  }, 'terminal work card');
  assert.equal(card.work.state, expectedState, `Unexpected task state: ${card.work.state}`);
  await expect(row(card.id).locator(`.zc-work.is-${expectedState}`)).toBeVisible({ timeout: 30_000 });
  assert.equal((await json('/api/tasks')).running.some((t) => t.id === task.id), false);
  return card;
}
async function approval(task, choice) {
  const sid = (await json('/api/tasks')).sessions.find((s) => s.sid === task.sid)?.id;
  assert.ok(sid);
  const pending = await until(async () => {
    const snap = (await json('/api/live')).msgs.find((m) => m.k === 'snap');
    const a = snap?.perms.find((a) => a.agent === 'codex' && a.sess === sid);
    if (!a && ['done', 'fail', 'stopped'].includes((await work(task))?.work.state)) throw Error('Codex ended without requesting the expected approval');
    return a;
  }, 'real Codex approval');
  assert.equal(pending.type, 'bash');
  // Validate the complete command, never approve an arbitrary shell substring or policy amendment.
  const command = pending.detail.split('\n')[0].replace(/\\+/g, '\\');
  assert.ok(fixtureCommands(choice).includes(command), `Unexpected approval command: ${command}`);
  assert.equal(fs.readFileSync(path.join(project, 'approval.cjs'), 'utf8'), markerScript);
  const card = page.locator(`.perm-card[data-id="${pending.id}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await screenshot(card, `${phase}-approval.png`);
  const answered = page.waitForResponse((r) => r.url() === `${pageBase}/api/perm` && r.request().method() === 'POST');
  await card.locator(`[data-perm="${choice === 'allow' ? 'allow' : 'deny'}"]`).click();
  const response = await answered; assert.equal(response.ok() && (await response.json()).ok, true);
  await expect(card).toBeHidden(); record('answered-via-ui', { choice });
}
async function reply(token) {
  const message = await until(async () => (await json('/api/chat')).msgs.findLast((m) => m.tag === 'codex' && m.text.includes(token)), 'Codex chat reply');
  await expect(row(message.id).locator('.zc-claude')).toHaveText('Codex');
  await expect(row(message.id).locator('.zc-md b, .zc-md strong').filter({ hasText: token })).toBeVisible({ timeout: 30_000 });
  await screenshot(row(message.id), `${phase}-reply.png`);
}

try {
  console.log(`Live UI fixture: ${runRoot}`);
  assert.ok(fs.existsSync(path.join(ROOT, process.env.OFFICE_DIST_DIR || '.next', 'BUILD_ID')), 'Run npm run build first');
  const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise((resolve) => socket.close(resolve)); base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: 'production', OFFICE_HOST: '127.0.0.1', OFFICE_PORT: String(port), OFFICE_DATA_DIR: dataDir,
    OFFICE_CODEX: '1', OFFICE_CODEX_DESKTOP: '0', CLAUDE_CONFIG_DIR: path.join(runRoot, '.claude'), OFFICE_USAGE: '0', OFFICE_TRANSLATE: '0', OFFICE_CI: '0', OFFICE_LANG: 'en' };
  delete env.OFFICE_CODEX_BIN; delete env.OFFICE_LOG;
  // A live check owns a disposable Quick Tunnel, regardless of the user's normal managed-tunnel configuration.
  for (const key of ['OFFICE_PUBLIC_URL', 'OFFICE_TUNNEL_TOKEN_FILE', 'OFFICE_ACCESS_TEAM_DOMAIN', 'OFFICE_ACCESS_AUD', 'OFFICE_TUNNEL_CMD']) delete env[key];
  const cachedTunnel = path.join(ROOT, 'data', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (remote && fs.existsSync(cachedTunnel)) env.OFFICE_TUNNEL_CMD = cachedTunnel;
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Never save the server's login URLs, access tokens, or unrelated session data in the report.
  for (const output of [server.stdout, server.stderr]) output.on('data', () => {});
  await until(async () => { if (server.exitCode != null) throw Error(`Office startup exited with code ${server.exitCode}`); try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, 'Office startup', 90_000);
  const info = await until(async () => { const data = await json('/api/tasks'); return data.codex?.connected ? data : null; }, 'real Codex connection', 90_000);
  assert.equal(info.codex.runtime.source, 'project'); report.runtime = info.codex.runtime;
  browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  pageBase = base;
  if (remote) {
    phase = 'remote-https'; record('begin');
    await json('/api/tunnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' });
    const tunnel = await until(async () => {
      const t = await json('/api/tunnel'); if (t.state === 'error') throw Error(`Tunnel startup: ${redact(t.error)}`);
      return t.state === 'on' && t.url ? t : null;
    }, 'real HTTPS tunnel', 360_000);
    assert.match(tunnel.url, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/); pageBase = tunnel.url;
    await until(async () => { try { return (await fetch(`${pageBase}/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch { return false; } }, 'HTTPS edge ready', 120_000);
    const noLogin = await fetch(`${pageBase}/api/tasks`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    assert.equal(noLogin.status, 401, 'Unauthenticated requests reached task data');
    const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
    assert.equal((await fetch(`${pageBase}/api/tasks?k=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15_000) })).status, 401, 'LAN token was accepted through the tunnel');
    const login = await context.request.post(`${pageBase}/pin`, { headers: { Origin: pageBase }, form: { pin: tunnel.pin }, maxRedirects: 0 });
    assert.equal(login.status(), 303, 'HTTPS PIN login failed'); assert.match(login.headers()['set-cookie'], /; Secure/);
    const guard = { agent: 'codex', dir: project, text: 'Permission guard; must never execute', requestId: crypto.randomUUID() };
    assert.equal((await context.request.post(`${pageBase}/api/tasks`, { headers: { Origin: pageBase }, data: guard })).status(), 403);
    assert.equal((await context.request.post(`${pageBase}/api/tasks/allow`, { headers: { Origin: pageBase }, data: { on: true } })).status(), 403);
    await json('/api/tasks/allow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' });
    await json('/api/phone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"approve":true}' });
    assert.equal((await context.request.post(`${pageBase}/api/tasks`, { headers: { Origin: 'https://foreign.example' }, data: guard })).status(), 403);
    report.remote = { https: true, pinLogin: true, anonymousDenied: true, lanTokenDenied: true, remotePermissionDenied: true, crossOriginDenied: true, deduplicatedSends: 0, physical4GTest: false };
    record('https-auth-passed');
  }
  page = await context.newPage(); page.setDefaultTimeout(45_000);
  page.on('pageerror', (error) => { report.browserErrors.push(redact(error.message)); save(); });
  await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); localStorage.setItem('office-lite', 'on'); });
  await page.goto(`${pageBase}/?layout=cozy`, { timeout: 90_000 });
  await expect(page.locator('#btn-chat')).toBeVisible({ timeout: 90_000 });
  // The SSR button is visible before OfficeBoot imports and initializes its click listeners.
  await expect(page.locator('#chat-badge')).toHaveText(/^(0|[1-5]|5\+)$/, { timeout: 120_000 });
  await page.locator('#btn-chat').click();
  await expect(page.locator('#zchat')).toBeVisible();
  if (selected === 'usage') await scenario('ui-usage', async () => {
    const snapshot = (await json('/api/live')).msgs.find((m) => m.k === 'snap');
    assert.ok(snapshot.sessions.some((s) => s.agent === 'codex' && contextBudget(s.usage)), 'No recent Codex session has stored token data');
    await page.locator('.zc-close').click();
    const card = page.locator('.lite-card').filter({ hasText: /Context \d+% left/ }).first();
    await expect(card).toBeVisible({ timeout: 30_000 }); await card.click();
    await expect(page.locator('#ds-codex-usage')).toBeVisible();
    const pct = Number(await page.locator('#ds-codex-usage [role="progressbar"]').getAttribute('aria-valuenow'));
    assert.ok(Number.isFinite(pct) && pct >= 0 && pct <= 100);
    await expect(page.locator('#ds-ctx')).toHaveText(`${pct}%`);
    await screenshot(page.locator('#ds-codex-usage'), 'real-context-tokens.png');
    await page.locator('#dr-session [data-close]').click();
    await expect(page.locator('#btn-codex-usage')).toBeVisible(); await page.locator('#btn-codex-usage').click();
    await expect(page.locator('#pop-codex-usage')).toBeVisible();
    await screenshot(page.locator('#pop-codex-usage'), 'real-account-limits.png');
    return { observedContextLeftPct: pct, quota: (await json('/api/tasks')).codex.limits, modelTurnsStarted: 0 };
  });
  let first;
  await scenario('ui-repair-and-allow', async () => {
    checkProject(false);
    first = await submit('This is a real UI approval test. First use the built-in shell to run exactly node approval.cjs allow with sandbox_permissions="require_escalated" and ask approval for the disposable marker. Do not modify approval.cjs or request broader permissions. After approval, fix only calculator.cjs so node --test checks.cjs passes; run the tests. Do not modify tests, install dependencies, use network or delegate. Finish with **UI_REPAIR_COMPLETE** and a short test report.');
    await approval(first, 'allow'); const card = await complete(first); checkProject();
    assert.equal(fs.readFileSync(path.join(runRoot, 'markers', 'allow.txt'), 'utf8'), 'once\n');
    await screenshot(row(card.id), 'repair-work-card.png'); await reply('UI_REPAIR_COMPLETE');
    const owned = (await json('/api/tasks')).sessions.find((s) => s.sid === first.sid);
    assert.equal(owned.agent, 'codex');
    const history = await json(`/api/log?id=${encodeURIComponent(owned.id)}`);
    assert.ok(history.items.some((x) => x.text?.includes('UI_REPAIR_COMPLETE')));
    return { sid: first.sid, tests: 3, approvalExecutions: 1, historyAvailable: true };
  });
  await scenario('ui-followup', async () => {
    fs.appendFileSync(path.join(project, 'checks.cjs'), "\ntest('discount', () => assert.equal(total([{ price: 10, quantity: 2 }], 25), 15));\n");
    expectedChecks = fs.readFileSync(path.join(project, 'checks.cjs'), 'utf8'); checkProject(false);
    const task = await submit('Extend total(items, discountPercent = 0) to apply the percentage discount after summing quantities. Only change calculator.cjs. Run node --test checks.cjs. No network/dependencies/delegation. Finish with **UI_FOLLOWUP_COMPLETE** and a brief test report.', { resume: true });
    assert.equal(task.sid, first.sid); await complete(task); checkProject(); await reply('UI_FOLLOWUP_COMPLETE');
    return { sameThread: true, tests: 4 };
  });
  await scenario('ui-deny', async () => {
    const task = await submit('This is an approval test. Use the built-in shell to run exactly node approval.cjs deny with sandbox_permissions="require_escalated" and ask approval for the disposable marker. The user will deny it. Do not edit files, run another command, request broader permissions or retry after denial.');
    await approval(task, 'deny'); await complete(task, 'stopped');
    assert.equal(fs.existsSync(path.join(runRoot, 'markers', 'deny.txt')), false); checkProject();
    return { approvalExecutions: 0, interrupted: true };
  });
  await scenario('ui-stop', async () => {
    fs.writeFileSync(path.join(project, 'wait.cjs'), "const fs = require('node:fs'); fs.writeFileSync('started.flag', 'ready'); setTimeout(() => fs.writeFileSync('finished.flag', 'unexpected'), 30000);\n");
    const task = await submit('Use the built-in shell to run exactly node wait.cjs with a timeout of at least 60000ms, then wait for it to finish. Do not edit files or run another command. Do not use MCP tools, node_repl or detached processes.');
    await until(() => fs.existsSync(path.join(project, 'started.flag')), 'real command started'); const at = Date.now();
    const card = await work(task);
    const stopped = page.waitForResponse((r) => r.url() === `${pageBase}/api/tasks/stop` && r.request().method() === 'POST');
    await row(card.id).locator('.is-stop').click(); const response = await stopped;
    assert.equal(response.ok() && (await response.json()).ok, true); await complete(task, 'stopped');
    record('checking-command-exit'); const remaining = at + 32_000 - Date.now(); if (remaining > 0) await delay(remaining);
    assert.equal(fs.existsSync(path.join(project, 'finished.flag')), false); checkProject();
    return { interrupted: true, commandTerminated: true };
  });
  if (remote) {
    const before = [...ownTasks];
    await context.setOffline(true); await delay(1500); await context.setOffline(false);
    await page.reload({ timeout: 90_000 }); await expect(page.locator('#btn-give-work')).toBeVisible({ timeout: 90_000 });
    assert.equal((await json('/api/tasks')).running.some((t) => before.includes(t.id)), false);
    report.remote.browserReconnect = true; record('remote-reconnect-passed');
  }
  assert.deepEqual(report.browserErrors, []);
} catch (error) {
  report.error = redact(error.message); record('error', { error: report.error }); process.exitCode = 1;
  // Crop failures to the isolated chat UI; do not capture unrelated session titles in the rail.
  try { if (await page?.locator('#zchat').isVisible()) await screenshot(page.locator('#zchat'), 'failure-chat.png'); } catch { /* browser may already be gone */ }
}
finally {
  if (base) {
    try {
      const running = (await json('/api/tasks')).running.filter((t) => ownTasks.has(t.id));
      for (const task of running) await json('/api/tasks/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: task.id }) });
      if (running.length) await until(async () => !(await json('/api/tasks')).running.some((t) => ownTasks.has(t.id)), 'fixture stop during cleanup', 20_000);
    } catch { record('cleanup-warning', { message: 'Could not confirm fixture tasks stopped' }); }
  }
  await browser?.close();
  if (remote && base) {
    try {
      const stopped = await json('/api/tunnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":false}' });
      assert.equal(stopped.state, 'off');
      if (report.remote) report.remote.tunnelClosed = true;
    } catch { record('cleanup-warning', { message: 'Could not confirm the fixture tunnel stopped' }); process.exitCode = 1; }
  }
  if (server?.exitCode === null) { server.kill(); await Promise.race([new Promise((resolve) => server.once('exit', resolve)), delay(5000)]); }
  const rpc = createCodexRpc({ binary: () => ({ file: process.execPath, args: [path.join(ROOT, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] }) }); report.archivedThreads = 0;
  try {
    const stateFile = path.join(dataDir, 'codex-threads.json');
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { owners: [] };
    for (const owner of state.owners || []) if (owner.dir === project) { await rpc.call('thread/archive', { threadId: owner.sid }); report.archivedThreads++; }
  } catch { record('cleanup-warning', { message: 'Could not archive all fixture threads' }); }
  finally { rpc.close(); }
  report.finishedAt = new Date().toISOString(); save(); console.log(`Report: ${reportFile}`);
}
