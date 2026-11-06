import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { HOME_DIR } from '../../playwright.config';

// UI-only rewrite responses: no real model, authentication or quota is used.
const REWRITE = 'Mục tiêu: sửa lỗi đang thấy trong ảnh đính kèm.\nBối cảnh: [trang nào?]\nXong khi: trang hiện đúng, không còn lỗi.';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { for (const [k, v] of [['office-tips', 'seen'], ['office-lite', 'on'], ['office-quality', 'low'], ['office-coach', 'on']]) localStorage.setItem(k, v); });
});
async function openWorkspace(page: Page, request: APIRequestContext, phone = false) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  await request.post('/event', { data: { session_id: `e2e-coach-${Date.now()}`, cwd: HOME_DIR, transcript_path: path.join(HOME_DIR, 'coach.jsonl'), hook_event_name: 'SessionStart', source: 'startup' } });
  await page.goto('/?lang=vi');
  await page.locator(phone ? '.ph-tab[data-tab="work"]' : '#btn-give-work').click({ timeout: 120_000 });
  const panel = page.locator('#ai-workspace'); await expect(panel).toBeVisible();
  return { panel, input: panel.locator('.aw-prompt'), box: panel.locator('.aw-coach') };
}

for (const phone of [false, true]) {
  test(`AI prompt helper: hints, chips, rewrite and undo on ${phone ? 'phone' : 'desktop'}`, async ({ page, request }) => {
    test.setTimeout(120_000);
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [], rewrites: object[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/prompt/rewrite*', async (route) => {
      rewrites.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true, text: REWRITE } });
    });
    const { panel, input, box } = await openWorkspace(page, request, phone);
    const fresh = async (text: string) => { await input.fill(''); await input.fill(text); };
    await panel.locator('input[type="file"]').setInputFiles('public/icon-512.png');
    await expect(panel.locator('.aw-image')).toHaveCount(1);
    await input.fill('sao');
    await expect(box).toHaveAttribute('data-hint', 'photoBare');
    await expect(box).toContainText('Muốn nó làm gì với ảnh?');
    await box.locator('[data-k="fixPhoto"]').click();
    await expect(input).toHaveValue('Sửa lỗi đang thấy trong ảnh: sao');
    await expect(box).toBeHidden();
    await panel.locator('.aw-image-remove').click();
    await fresh('khác đi'); await expect(box).toHaveAttribute('data-hint', 'vague');
    await box.locator('.zc-coach-x').click();
    await input.press('End'); await input.pressSequentially(' nhé, hay hơn');
    await expect(box).toBeHidden();
    await fresh('hay hơn'); await expect(box).toHaveAttribute('data-hint', 'vague');
    await box.locator('[data-k="criteria"]').click();
    await expect(input).toHaveValue('hay hơn\nTiêu chí: ');
    expect(await input.evaluate((e: HTMLTextAreaElement) => e.selectionStart === e.value.length && document.activeElement === e)).toBe(true);
    await fresh('cái này lỗi rồi'); await expect(box).toHaveAttribute('data-hint', 'dangling');
    await box.locator('[data-k="quote"]').click(); await expect(input).toHaveValue('cái này “” lỗi rồi');
    await fresh('gợi ý thêm… trước đó push lên github'); await expect(box).toHaveAttribute('data-hint', 'multi');
    await box.locator('[data-k="number"]').click(); await expect(input).toHaveValue('Làm lần lượt:\n1. Push lên github\n2. Gợi ý thêm');
    await fresh('config gì'); await expect(box).toHaveAttribute('data-hint', 'tooShort');
    expect(await panel.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: test.info().outputPath(`ai-coach-${phone ? 'phone' : 'desktop'}.png`) });
    await box.locator('[data-k="rewrite"]').click();
    await expect(box).toHaveAttribute('data-hint', 'rewritten'); await expect(input).toHaveValue(REWRITE);
    expect(rewrites).toEqual([{ text: 'config gì', lang: 'vi', photos: 0 }]);
    await box.locator('[data-k="undo"]').click(); await expect(input).toHaveValue('config gì');
    // Enter remains a newline; hints never submit a task or contact the rewrite endpoint automatically.
    await input.press('End'); await input.press('Enter'); await expect(input).toHaveValue('config gì\n');
    expect(rewrites).toHaveLength(1);
    expect((await (await request.get('/api/workspace')).json()).conversations).toHaveLength(0);
    if (!phone) {
      await panel.locator('.aw-close').click(); await page.click('#btn-look'); await page.click('#st-tab-more');
      const toggle = page.locator('[data-tgl="coach"]'); await expect(toggle).toHaveAttribute('aria-checked', 'true'); await toggle.click();
      await page.click('#st-close'); await page.click('#btn-give-work'); await fresh('hay hơn');
      await expect(box).toBeHidden();
    }
    expect(errors).toEqual([]);
  });
}

test('a failed or cancelled rewrite retains the draft and cannot overwrite another composer', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { panel, input, box } = await openWorkspace(page, request);
  await page.route('**/api/prompt/rewrite*', (route) => route.abort());
  await input.fill('config gì'); await expect(box).toHaveAttribute('data-hint', 'tooShort');
  await box.locator('[data-k="rewrite"]').click();
  await expect(box.locator('[data-k="rewrite"]')).toBeEnabled(); await expect(input).toHaveValue('config gì');
  await expect(input).not.toHaveAttribute('readonly');
  await page.unroute('**/api/prompt/rewrite*');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/prompt/rewrite*', async (route) => { await gate; await route.fulfill({ json: { ok: true, text: REWRITE } }).catch(() => {}); });
  const received = page.waitForRequest('**/api/prompt/rewrite*');
  await box.locator('[data-k="rewrite"]').click(); await received;
  await expect(input).toHaveAttribute('readonly'); await expect(panel.locator('.aw-send')).toBeDisabled();
  await panel.locator('.aw-close').click(); await page.click('#btn-give-work'); await input.fill('Nội dung đang soạn khác');
  release(); await expect(input).toHaveValue('Nội dung đang soạn khác'); await expect(input).not.toHaveAttribute('readonly');
});
