import { test, expect } from '@playwright/test';
const READER = process.env.LIOOPS_OBSERVER_STATIC === '1' ? '/vi/observe/' : '/observe/?lang=vi';
const log = (text = 'Check the tests') => {
  const timestamp = new Date().toISOString();
  return [
    { type: 'session_meta', payload: { id: 'observer-fixture', cwd: 'F:\\Projects\\Observer shop' } },
    { type: 'turn_context', payload: { model: 'fixture-model' } },
    { type: 'event_msg', payload: { type: 'user_message', message: text } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ file_path: 'README.md' }) } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 80000, output_tokens: 2000 }, last_token_usage: { total_tokens: 20000 }, model_context_window: 100000 } } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Completed. token=super-secret-value' } },
  ].map(r => JSON.stringify({ timestamp, ...r })).join('\n') + '\n';
};

test('observer imports logs locally, renders real session data in 3D and never calls a backend API', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [], api: string[] = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Observer page error:', e.message); });
  page.on('request', r => { if (/(?:^|\/)(?:api|stream|event|hook)(?:\/|$)/.test(new URL(r.url()).pathname)) api.push(r.url()); });
  await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); });
  await page.goto(READER);
  await expect(page.getByRole('heading', { name: 'AI của bạn, nhìn là rõ.' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  const malicious = '<img src="/api/tasks" onerror="window.INJECTED=true"> Check the tests';
  await page.locator('.ob-file-input').setInputFiles([{ name: 'rollout-fixture.jsonl', mimeType: 'application/json', buffer: Buffer.from(log(malicious)) }, { name: 'credentials.jsonl', mimeType: 'application/json', buffer: Buffer.from('DO_NOT_READ') }]);
  await expect(page.locator('.ob-session')).toHaveCount(1);
  await expect(page.locator('.ob-metrics')).toContainText('80%');
  await expect(page.locator('.ob-metrics')).toContainText('80.000');
  await expect(page.locator('.ob-messages')).toContainText(malicious);
  await expect(page.locator('.ob-app')).not.toContainText('PRIVATE_REASONING');
  await expect(page.locator('.ob-app')).not.toContainText('super-secret-value');
  expect(await page.evaluate(() => (window as unknown as { INJECTED?: boolean }).INJECTED)).toBeUndefined();
  await page.getByRole('button', { name: 'Văn phòng 3D', exact: true }).click();
  const office = page.frameLocator('iframe');
  await expect(office.locator('#stage canvas')).toBeVisible({ timeout: 90_000 });
  await expect(office.locator('#rail-list')).toContainText('Observer shop', { timeout: 60_000 });
  await expect(office.locator('#rail-list')).not.toContainText('shop-api');
  await expect(office.locator('#btn-give-work')).toBeHidden();
  await office.locator('#rail-list .ri').first().click();
  await expect(office.locator('#ds-body')).toContainText('Completed');
  await expect(office.locator('#ds-actions [data-ai-work]')).toHaveCount(0);
  await office.locator('#dr-session [data-close]').click();
  await page.screenshot({ path: test.info().outputPath('observer-desktop.png') });
  await page.getByRole('button', { name: 'Các phiên', exact: true }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('.ob-app').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('observer-phone.png') });
  await page.getByRole('button', { name: 'Ngắt và xóa dữ liệu đang xem', exact: true }).click();
  await expect(page.locator('.ob-session')).toHaveCount(0);
  await expect(page.locator('.ob-app')).not.toContainText('Observer shop');
  expect(api).toEqual([]); expect(errors).toEqual([]);
});

test('folder observation refreshes changed logs, preserves selection on cancel and clears on revoked permission', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript((initial) => {
    const fixture = window as unknown as { logText: string; modified: number; permission: PermissionState; cancel: boolean; pickerMode?: string };
    fixture.logText = initial; fixture.modified = Date.now(); fixture.permission = 'granted'; fixture.cancel = false;
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async (options: { mode: string }) => {
      fixture.pickerMode = options.mode;
      if (fixture.cancel) throw new DOMException('Cancelled', 'AbortError');
      return { name: 'sessions', kind: 'directory', queryPermission: async () => fixture.permission, async *values() {
        yield { name: 'rollout-fixture.jsonl', kind: 'file', getFile: async () => new File([fixture.logText], 'rollout-fixture.jsonl', { lastModified: fixture.modified }) };
        yield { name: 'auth.json', kind: 'file', getFile: () => { throw new Error('Credential file must not be read'); } };
      } };
    } });
  }, log('First prompt'));
  await page.goto(READER);
  await page.getByRole('button', { name: 'Chọn thư mục nhật ký', exact: true }).click();
  await expect(page.locator('.ob-session')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { pickerMode: string }).pickerMode)).toBe('read');
  await page.evaluate(text => { const f = window as unknown as { logText: string; modified: number; cancel: boolean }; f.logText = text; f.modified++; f.cancel = true; }, log('Updated prompt'));
  await expect(page.locator('.ob-messages')).toContainText('Updated prompt');
  await page.getByRole('button', { name: 'Đổi thư mục', exact: true }).click();
  await expect(page.locator('.ob-session')).toHaveCount(1);
  await expect(page.locator('.ob-feedback')).toContainText('Đã hủy chọn');
  await page.evaluate(() => { (window as unknown as { permission: string }).permission = 'denied'; });
  await expect(page.locator('.ob-feedback')).toContainText('Quyền đọc thư mục đã bị thu hồi');
  await expect(page.locator('.ob-session')).toHaveCount(0);
});
