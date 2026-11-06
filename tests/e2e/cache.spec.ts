import path from 'node:path';
import { test, expect, devices, type Page, type APIRequestContext } from '@playwright/test';
import { HOME_DIR } from '../../playwright.config';

// The prompt cache's clock (src/shared/cache-clock.js): a cup of coffee on a resting desk that steams while the
// session's cache is warm, the drawer's line, and the chat's "To" telling you whether carrying on is cheap.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { try { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); } catch { /* private mode */ } }); });

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|WebGL/i.test(m.text())) errors.push(m.text()); });
  return errors;
}
type Office = { cupsNow?: () => number[], sessions: Map<string, { name: string, desk: number }> };
// a session that did one turn and rests; its status line says (or doesn't) how its prompt cache stands
async function restingSession(request: APIRequestContext, sid: string) {
  const base = { session_id: sid, cwd: path.join(HOME_DIR, sid), transcript_path: path.join(HOME_DIR, `${sid}.jsonl`) };
  await request.post('/event', { data: { ...base, hook_event_name: 'SessionStart', source: 'startup' } });
  await request.post('/event', { data: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'tidy the README' } });
  await request.post('/event', { data: { ...base, hook_event_name: 'Stop', last_assistant_message: 'Done, shall I also fix the links?' } });
  // (the status line's own fields: code.claude.com/docs/en/statusline)
  const status = (prompt_cache: object | undefined) => request.post('/hook/status', { data: { session_id: sid, context_window: { context_window_size: 200000, used_percentage: 90 }, cost: { total_cost_usd: 1.2 }, prompt_cache } });
  return { base, status, name: `${sid}-${sid.slice(0, 2)}`, end: () => request.post('/event', { data: { ...base, hook_event_name: 'SessionEnd', reason: 'other' } }) };
}
const warm = (mins: number) => ({ warm: true, caching_observed: true, ttl: '1h', expires_at: Math.round(Date.now() / 1000) + mins * 60, hit_ratio: 0.9, recache_tokens_if_cold: 180000 });
const cold = { warm: false, caching_observed: true, ttl: '1h', expires_at: null, hit_ratio: 0.9, recache_tokens_if_cold: 180000 };

test('a resting desk gets a cup that steams while the cache is warm and stops once it is cold; the drawer says how long', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.goto('/?layout=cozy&debug');
  await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 120_000 });
  await page.waitForFunction(() => !!(window as unknown as { __office?: Office }).__office?.cupsNow, null, { timeout: 120_000 });
  const s = await restingSession(request, `cc-${Date.now() % 1e6}`);
  await s.status(warm(30));
  const cupOf = () => page.evaluate((name) => { const o = (window as unknown as { __office: Office }).__office; const x = [...o.sessions.values()].find((v) => v.name === name); return x && x.desk >= 0 ? o.cupsNow!()[x.desk] : null; }, s.name);
  await expect.poll(cupOf, { timeout: 60_000 }).toBe(5);   // (30 minutes of an hour: half the steam)
  await page.locator('#rail-list .ri', { hasText: s.name }).click();
  await expect(page.locator('#ds-cache')).toHaveText('Prompt cache still warm for ~30 minutes');
  await page.screenshot({ path: path.join(test.info().project.outputDir, 'cup-warm.png') });   // (kept after the run, to look at)
  // it goes cold (the status line runs again when it does): a cup with no steam, and what carrying on costs
  await s.status(cold);
  await expect.poll(cupOf, { timeout: 20_000 }).toBe(0);
  await expect(page.locator('#ds-cache')).toHaveText('Prompt cache gone cold: the next message re-reads ~180k tokens');
  await expect(page.locator('#ds-cache')).toHaveAttribute('data-state', 'cold');
  // back at work: no cup (the person is at it)
  await request.post('/event', { data: { ...s.base, hook_event_name: 'UserPromptSubmit', prompt: 'yes please' } });
  await expect.poll(cupOf, { timeout: 20_000 }).toBe(-1);
  await s.end();
  expect(errors).toEqual([]);
});

test('no word from Claude Code (an older version): guessed from the end of the turn, and said to be a guess', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.addInitScript(() => { try { localStorage.setItem('office-lite', 'on'); } catch { /* private mode */ } });
  const s = await restingSession(request, `cg-${Date.now() % 1e6}`);
  await page.goto('/');
  await page.locator('#rail-list .ri', { hasText: s.name }).click({ timeout: 120_000 });
  // (an API key's five minutes, or a subscription's hour once the office has heard of plan limits, as it has when
  // what-eats-your-plan's spec ran first on the same office)
  await expect(page.locator('#ds-cache')).toHaveText(/^Prompt cache still warm for ~(?:[345]|5[5-9]|60) minutes \(estimated\)$/);
  await expect(page.locator('#lite .lite-card', { hasText: s.name })).toContainText(/☕ warm (?:[345]|5[5-9]|60) min/);
  await s.end();
  expect(errors).toEqual([]);
});

test('AI workspace: warm, cheap to carry on; cold, how much it reads again', async ({ page, request }) => {
  test.setTimeout(240_000);
  const errors = watchErrors(page);
  await page.addInitScript(() => { try { localStorage.setItem('office-lite', 'on'); } catch { /* private mode */ } });
  const s = await restingSession(request, `ct-${Date.now() % 1e6}`);
  await s.status(warm(23));
  await page.goto('/');
  await page.locator('#btn-give-work').click();
  const panel = page.locator('#ai-workspace');
  await panel.locator('.aw-advanced summary').click();
  await panel.getByRole('combobox', { name: 'Start from an open session (optional)', exact: true }).selectOption(s.base.session_id);
  await expect(panel.locator('.aw-context-cache')).toHaveText('warm ~23 min · cheap to continue');
  await expect(panel.locator('.aw-context-cache')).toHaveAttribute('data-state', 'warm');
  await s.status(cold);
  await expect(panel.locator('.aw-context-cache')).toHaveText('cold · continuing re-reads ~180k tokens', { timeout: 30_000 });
  await s.end();
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 14'];
  void _browser;
  test.use({ ...iphone, deviceScaleFactor: 1 });
  test('the AI workspace keeps the cache on one line in Vietnamese on a phone', async ({ page, request }) => {
    test.setTimeout(240_000);
    const errors = watchErrors(page);
    await page.addInitScript(() => { try { localStorage.setItem('office-lite', 'on'); } catch { /* private mode */ } });
    const s = await restingSession(request, `cp-${Date.now() % 1e6}`);
    await s.status(warm(23));
    await page.goto('/?lang=vi');
    await page.locator('.ph-tab[data-tab="work"]').click();
    const panel = page.locator('#ai-workspace');
    await panel.locator('.aw-advanced summary').click();
    await panel.getByRole('combobox', { name: 'Bắt đầu từ phiên đang mở (tùy chọn)', exact: true }).selectOption(s.base.session_id);
    await expect(panel.locator('.aw-context-cache')).toHaveText('☕ còn ấm 23 phút');
    expect(await panel.locator('.aw-context-cache').evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    expect(await panel.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: path.join(test.info().project.outputDir, 'cache-phone.png') });   // (kept after the run, to look at)
    await s.end();
    expect(errors).toEqual([]);
  });
});
