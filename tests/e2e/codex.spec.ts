import { test, expect, type Locator } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = (Number(process.env.E2E_PORT) || 4399) + 44, BASE = `http://127.0.0.1:${PORT}`;
test.use({ actionTimeout: 20_000 });
let server: ChildProcess, dir: string, log = '';
const desktopOpens = (): string[] => { try { return fs.readFileSync(path.join(dir, 'desktop-opens.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
async function pasteImages(input: Locator, count = 1) {
  await input.evaluate((field, { png, count }) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0)), data = new DataTransfer();
    for (let i = 0; i < count; i++) data.items.add(new File([bytes], `clipboard-${i}.png`, { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { png: fs.readFileSync('public/icon-512.png').toString('base64'), count });
}
test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-codex-e2e-'));
  const codexHome = path.join(dir, '.codex'), usageFile = path.join(codexHome, 'sessions', 'rollout-external-codex-fixture.jsonl');
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  fs.writeFileSync(usageFile, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 80000, output_tokens: 4000 }, last_token_usage: { total_tokens: 20000 }, model_context_window: 100000,
  } } }) + '\n');
  // Test-only interception of the native app launcher: exercise the real endpoint without switching the user's app.
  const desktopPreload = 'data:text/javascript,' + encodeURIComponent(`
    import cp from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module'; const original = cp.execFile, originalSpawn = cp.spawn;
    const claudeFixture = ${JSON.stringify(path.resolve('tests/fixtures/fake-claude-workspace.mjs'))};
    cp.spawn = (file, args, options) => file === claudeFixture ? originalSpawn(process.execPath, [file, ...args], options) : originalSpawn(file, args, options);
    cp.execFile = (...args) => {
      const [file, argv, , callback] = args, prefix = 'codex:' + '//' + 'threads/'; let uri = '';
      if (file === claudeFixture) return original(process.execPath, [file, ...argv], args[2], callback);
      if (path.win32.basename(String(file)).toLowerCase() === 'powershell.exe' && argv?.at(-2) === '-EncodedCommand') {
        const script = Buffer.from(argv.at(-1), 'base64').toString('utf16le');
        uri = script.split("Start-Process -FilePath '")[1]?.split("'")[0] || '';
      } else if (['/usr/bin/open', 'xdg-open'].includes(file) && argv?.length === 1) uri = argv[0];
      if (!uri.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(uri.slice(prefix.length))) return original(...args);
      fs.appendFileSync(${JSON.stringify(path.join(dir, 'desktop-opens.jsonl'))}, uri + '\\n');
      queueMicrotask(() => callback(null, '', '')); return {};
    }; syncBuiltinESMExports();
  `);
  server = spawn(process.execPath, ['--import', desktopPreload, 'server/index.mjs'], { env: { ...process.env,
    NODE_ENV: 'production', OFFICE_PORT: String(PORT), OFFICE_DATA_DIR: dir, CLAUDE_CONFIG_DIR: path.join(dir, '.claude'),
    OFFICE_CODEX: '1', OFFICE_CODEX_DESKTOP: '1', OFFICE_CODEX_BIN: path.resolve('tests/fixtures/codex/fake-app-server.mjs'), OFFICE_CODEX_TEST_CWD: process.cwd(),
    OFFICE_CLAUDE_BIN: path.resolve('tests/fixtures/fake-claude-workspace.mjs'), OFFICE_TEST_CLAUDE_LOG: path.join(dir, 'claude-workspace.jsonl'),
    CODEX_HOME: codexHome, OFFICE_CODEX_TEST_USAGE_FILE: usageFile,
    OFFICE_USAGE: '0', OFFICE_TRANSLATE: '0', OFFICE_CI: '0', OFFICE_LANG: 'en' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout?.on('data', (c) => { log += c; }); server.stderr?.on('data', (c) => { log += c; });
  await expect.poll(async () => { try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; } }, { message: log }).toBe(true);
});
test.afterAll(async () => {
  const diagnostics = log.split('\n').filter((line) => /^\s*(?:FATAL ERROR:|TypeError:|RangeError:|Error:|SyntaxError:|\s+at\s)/.test(line));
  if (diagnostics.length) console.error(diagnostics.slice(-16).join('\n'));
  if (server?.exitCode != null && server.exitCode !== 0) console.error(`Codex fixture server exited: ${server.exitCode}`);
  if (server && server.exitCode === null) { server.kill(); await new Promise((r) => server.once('exit', r)); }
  // The directory was created under the OS temporary folder by this fixture.
  if (dir && path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
});

test('Codex and Claude coexist; Codex forks, asks for approval, returns Markdown and stops @smoke', async ({ request, page }) => {
  test.setTimeout(300_000); // Includes the 3D office, token drawer and allowance popover on Windows/software graphics.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); localStorage.setItem('office-lite', 'on'); });
  const tasks = async () => (await request.get(`${BASE}/api/tasks`, { maxRetries: 2 })).json();
  await expect.poll(async () => (await tasks()).sessions.some((s: { agent: string }) => s.agent === 'codex')).toBe(true);
  await request.post(`${BASE}/event`, { data: { hook_event_name: 'SessionStart', session_id: 'claude-fixture', cwd: process.cwd() } });
  await expect.poll(async () => new Set((await tasks()).sessions.map((s: { agent: string }) => s.agent)).size).toBe(2);
  const start = await request.post(`${BASE}/api/tasks`, { data: { sid: 'external-codex-fixture', text: 'Run fixture tests' } });
  expect(start.ok()).toBe(true); const run = (await start.json()).task;
  expect(run.sid).not.toBe('external-codex-fixture');
  const steer = await request.post(`${BASE}/api/tasks/steer`, { data: { task: run.id, text: 'Focus on the failing tests first' } });
  expect((await steer.json()).ok).toBe(true);
  // Opening the page also checks that provider-specific sessions can pass through the real UI.
  await page.goto(`${BASE}/?layout=cozy`);
  await expect(page.locator('#rail-list .av[title="Codex"]').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#codex-quota-mini')).toHaveText('75% left');
  await page.locator('#btn-codex-usage').click();
  await expect(page.locator('#pop-codex-usage')).toBeVisible();
  await expect(page.locator('#codex-quota-rows [role="progressbar"]')).toHaveAttribute('aria-valuenow', '75');
  await page.screenshot({ path: test.info().outputPath('codex-remaining-quota.png') });
  await page.locator('#codex-quota-close').click();
  await page.route(`${BASE}/api/tasks`, async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.codex.limits = null; await route.fulfill({ response, json: body });
  });
  await page.locator('#btn-codex-usage').click();
  await expect(page.locator('#codex-quota-mini')).toHaveText('–');
  await expect(page.locator('#codex-quota-empty')).toBeVisible();
  await page.unroute(`${BASE}/api/tasks`);
  await page.locator('#codex-quota-close').click();
  await page.locator('#btn-codex-usage').click();
  await expect(page.locator('#codex-quota-mini')).toHaveText('75% left');
  await page.locator('#codex-quota-close').click();
  const external = (await tasks()).sessions.find((s: { sid: string }) => s.sid === 'external-codex-fixture');
  const externalRow = page.locator(`#rail-list .ri[data-sess="${external.id}"]`);
  await expect(externalRow.locator('.ri-ctx-left')).toHaveText('Context 80% left');
  await expect.poll(async () => externalRow.locator('.ri-ctx').evaluate((bar) => bar.firstElementChild!.getBoundingClientRect().width / bar.getBoundingClientRect().width)).toBeCloseTo(0.8, 1);
  await externalRow.click();
  await expect(page.locator('#ds-ctx')).toHaveText('80%');
  await expect(page.locator('#ds-codex-usage')).toContainText('20,000 / 100,000 tokens');
  await expect(page.locator('#ds-codex-usage')).toContainText('Total input tokens: 80,000');
  await page.screenshot({ path: test.info().outputPath('codex-remaining-context.png') });
  await page.locator('#dr-session [data-close]').click();
  const noTokens = (await tasks()).sessions.find((s: { sid: string }) => s.sid === 'codex-no-token-fixture');
  await page.locator(`#rail-list .ri[data-sess="${noTokens.id}"]`).click();
  await expect(page.locator('#ds-ctx')).toHaveText('–');
  await expect(page.locator('#ds-codex-usage')).toContainText('Token data is not available');
  await expect(page.locator('#ds-codex-usage [role="progressbar"]')).toHaveCount(0);
  await page.locator('#dr-session [data-close]').click();
  const pending = async () => {
    const r = await request.get(`${BASE}/api/live`, { maxRetries: 2 }); return (await r.json()).msgs.find((m: { k: string }) => m.k === 'snap')?.perms || [];
  };
  await expect.poll(async () => (await pending()).length).toBe(1);
  const approval = (await pending())[0];
  const foreign = await request.post(`${BASE}/api/perm`, { headers: { Origin: 'https://evil.example' }, data: { id: approval.id, choice: 'allow' } });
  expect(foreign.status()).toBe(403);
  const approvalCard = page.locator(`.perm-card[data-id="${approval.id}"]`);
  await expect(approvalCard).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('codex-approval.png') });
  await approvalCard.locator('[data-perm="allow"]').click();
  await expect.poll(async () => (await tasks()).running.length).toBe(0);
  await expect(page.getByText('Needs approval', { exact: true })).toBeHidden();
  const chat = await (await request.get(`${BASE}/api/chat`)).json();
  expect(chat.msgs.some((m: { tag: string; text: string }) => m.tag === 'codex' && m.text.includes('Codex completed'))).toBe(true);
  const owned = (await tasks()).sessions.find((s: { sid: string }) => s.sid === run.sid);
  expect(owned.agent).toBe('codex');
  const desktop = (await tasks()).desktop;
  expect(desktop.enabled).toBe(true); // The native launch is captured by the test-only preload above.
  expect(desktop.autoOpen).toBe(true); expect(desktop.canConfigure).toBe(true);
  await expect.poll(desktopOpens).toEqual([`codex://threads/${owned.sid}`]);
  expect((await request.post(`${BASE}/api/tasks/desktop`, { data: { on: false } })).ok()).toBe(true);
  expect((await tasks()).desktop.autoOpen).toBe(false);
  expect((await request.post(`${BASE}/api/tasks/open-codex`, { data: { sid: owned.sid } })).status()).toBe(200);
  expect((await request.post(`${BASE}/api/tasks/open-codex`, { data: { sid: 'external-codex-fixture' } })).status()).toBe(404);
  expect((await request.post(`${BASE}/api/tasks/open-codex`, { headers: { Origin: 'https://evil.example' }, data: { sid: owned.sid } })).status()).toBe(403);
  expect((await tasks()).running).toHaveLength(0); // Opening a conversation never starts or resumes a turn.
  const history = await (await request.get(`${BASE}/api/log?id=${encodeURIComponent(owned.id)}`)).json();
  expect(history.items.some((x: { text: string }) => x.text?.includes('Codex completed'))).toBe(true);
  const another = await (await request.post(`${BASE}/api/tasks`, { data: { sid: owned.sid, text: 'Run again' } })).json();
  const opensBeforeStop = desktopOpens().length;
  const stop = await request.post(`${BASE}/api/tasks/stop`, { data: { id: another.task.id } }); expect((await stop.json()).ok).toBe(true);
  expect((await tasks()).running.length).toBe(1); // Interrupt acknowledgement precedes terminal completion.
  await expect.poll(async () => (await tasks()).running.length).toBe(0);
  expect(desktopOpens()).toHaveLength(opensBeforeStop); // Turning auto-open off persists across later work.
  await page.locator('#btn-chat').click();
  const openDesktop = page.locator(`button[data-codex-sid="${owned.sid}"]`).first();
  await expect(openDesktop).toHaveText('Open in Codex on PC');
  await openDesktop.click();
  await expect(page.locator('#toast')).toContainText('Requested to open the conversation');

  // Work has its own workspace; company chat no longer exposes the AI recipient composer.
  await expect(page.locator('.zc-to')).toBeHidden();
  await page.locator('.zc-task-btn').click();
  const panel = page.locator('#ai-workspace');
  await expect(panel).toBeVisible(); await expect(page.locator('#zchat')).toBeHidden();
  const picker = page.getByRole('combobox', { name: 'AI assistant', exact: true });
  await expect(picker).toHaveValue('codex');
  await page.locator('.aw-advanced summary').click();
  const source = page.getByRole('combobox', { name: 'Start from an open session (optional)', exact: true });
  await source.selectOption('external-codex-fixture');
  await expect(panel.locator('.aw-context-cache')).toHaveText('Context 80% left');
  await source.selectOption('');
  await expect(panel.locator('.aw-context-cache')).toBeHidden();
  const desktopAuto = page.getByRole('checkbox', { name: 'Automatically open the conversation in Codex on the computer when giving work' });
  await expect(desktopAuto).not.toBeChecked(); await desktopAuto.check();
  await expect.poll(async () => (await tasks()).desktop.autoOpen).toBe(true);
  await page.getByRole('combobox', { name: 'Codex model', exact: true }).selectOption('fixture-model');
  await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high');
  const prompt = page.getByRole('textbox', { name: 'Task prompt', exact: true });
  await pasteImages(prompt, 4);
  await expect(page.locator('.aw-image')).toHaveCount(4);
  await expect(page.locator('.aw-images')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.aw-send')).toBeEnabled();
  await pasteImages(prompt); await expect(page.locator('#toast')).toContainText('up to 4 images');
  await page.getByRole('button', { name: 'Remove image 1', exact: true }).click();
  await page.locator('.aw-composer input[type="file"]').setInputFiles('public/icon-512.png');
  await expect(page.locator('.aw-image')).toHaveCount(4);
  await prompt.fill('Check tests with selected model');
  const sent = page.waitForRequest((r) => r.url() === BASE + '/api/tasks' && r.method() === 'POST');
  await page.locator('.aw-send').click();
  const body = (await sent).postDataJSON();
  expect(body.model).toBe('fixture-model'); expect(body.effort).toBe('high'); expect(body.workspace).toBe(true);
  expect(body.images).toHaveLength(4); expect(body.images.every((image: string) => image.startsWith('data:image/jpeg;base64,'))).toBe(true);
  await expect(panel.locator('.aw-permission')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('ai-workspace-approval.png') });
  await page.route(BASE + '/api/perm', async (route) => { await route.abort(); await page.unroute(BASE + '/api/perm'); });
  await panel.locator('.aw-permission [data-perm="allow"]').click();
  await expect(panel.locator('.aw-permission [data-perm="allow"]')).toBeEnabled();
  expect((await tasks()).running).toHaveLength(1); // A failed approval submission keeps the decision available.
  await panel.locator('.aw-permission [data-perm="allow"]').click();
  await expect.poll(async () => (await tasks()).running.length).toBe(0);
  await expect(panel.locator('.is-ai')).toContainText('Codex completed');
  const workspace = async () => (await request.get(BASE + '/api/workspace')).json();
  const conversationId = (await workspace()).conversations[0].id;
  const conversation = async () => (await request.get(BASE + '/api/workspace?id=' + conversationId)).json();
  const firstSid = (await conversation()).conversation.sid;
  expect((await conversation()).conversation.turns).toHaveLength(1);
  const company = await (await request.get(BASE + '/api/chat')).json();
  expect(company.msgs.some((m: { text: string }) => m.text?.includes('Check tests with selected model'))).toBe(false);
  await prompt.fill('Continue the workspace conversation'); await page.locator('.aw-send').click();
  await expect(panel.locator('.aw-permission')).toBeVisible();
  await panel.locator('.aw-permission [data-perm="allow"]').click();
  await expect.poll(async () => (await conversation()).conversation.turns.at(-1).status).toBe('done');
  expect((await conversation()).conversation.sid).toBe(firstSid);
  expect((await conversation()).conversation.turns).toHaveLength(2);
  await page.reload(); await expect(panel).toBeVisible();
  await expect(panel.locator('.aw-prompt-text')).toHaveCount(2);
  await expect(panel.locator('.aw-native')).toBeVisible();
  // A draft survives closing/reopening through the session drawer, which reuses the existing conversation.
  await prompt.fill('Keep this unsent draft');
  await panel.locator('.aw-close').click();
  const ownedSession = (await tasks()).sessions.find((s: { sid: string }) => s.sid === firstSid);
  await page.locator('#rail-list .ri[data-sess="' + ownedSession.id + '"]').click();
  await page.locator('#ds-actions [data-ai-work]').click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('.aw-prompt-text')).toHaveCount(2);
  await expect(prompt).toHaveValue('Keep this unsent draft');
  await expect.poll(async () => new URL(page.url()).searchParams.get('work')).toBe(conversationId);
  expect((await workspace()).conversations).toHaveLength(1);
  await prompt.fill('');
  await page.screenshot({ path: test.info().outputPath('ai-workspace-desktop.png') });
  // Provider selection creates an independent Claude conversation, with its own reusable session id.
  await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
  await picker.selectOption('claude'); await prompt.fill('Claude workspace request'); await page.locator('.aw-send').click();
  await expect(panel.locator('.is-ai')).toContainText('Claude workspace completed');
  const claudeId = (await workspace()).conversations.find((c: { agent: string }) => c.agent === 'claude').id;
  const claude = async () => (await request.get(BASE + '/api/workspace?id=' + claudeId)).json();
  const claudeSid = (await claude()).conversation.sid;
  await prompt.fill('Continue Claude workspace'); await page.locator('.aw-send').click();
  await expect.poll(async () => (await claude()).conversation.turns.length).toBe(2);
  await expect.poll(async () => (await claude()).conversation.turns.at(-1).status).toBe('done');
  expect((await claude()).conversation.sid).toBe(claudeSid);
  const calls = fs.readFileSync(path.join(dir, 'claude-workspace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(calls.at(-1).resume).toBe(claudeSid);
  // Questions use the same approval component inside the AI conversation, including its answer payload.
  await panel.getByRole('button', { name: 'New conversation', exact: true }).click();
  await picker.selectOption('codex'); await prompt.fill('fixture-question'); await page.locator('.aw-send').click();
  await expect(panel.locator('.aw-permission[data-kind="ask"]')).toBeVisible();
  await panel.locator('.pq-opt').filter({ hasText: 'Yes' }).click();
  await panel.locator('[data-perm="answer"]').click();
  await expect.poll(async () => (await tasks()).running.length).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.ph-tab[data-tab="work"]')).toHaveAttribute('aria-selected', 'true');
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('ai-workspace-phone.png') });
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await expect(page.locator('.aw-sidebar')).toBeVisible();
  await page.locator('.aw-conversation[data-id="' + conversationId + '"]').click();
  await expect(panel.locator('.aw-prompt-text')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Close AI workspace', exact: true }).click();
  await page.locator('.ph-tab[data-tab="chat"]').click(); await expect(page.locator('#zchat')).toBeVisible();
  await expect(page.locator('#zchat')).not.toContainText('Claude workspace completed');
  expect(errors).toEqual([]);
});
