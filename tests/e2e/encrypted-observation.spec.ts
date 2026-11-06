import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { secureObservationFixture } from '../fixtures/secure-observation.mjs';
test.skip(process.env.LIOOPS_OBSERVER_STATIC !== '1', 'Requires the separate public export.');

test('web and PC consent pair through encrypted relay, render a selected log, resume and revoke', async ({ page, context, baseURL }) => {
  test.setTimeout(240000);
  const fixture = await secureObservationFixture(new URL(baseURL!).origin), pc = await context.newPage();
  const api: string[] = [], errors: string[] = [], transport: { status: number; action: string; at: number }[] = [];
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === fixture.relayURL) transport.push({ status: response.status(), action: url.pathname.split('/').at(-1) || '', at: Date.now() }); });
  page.on('request', request => { if (/^\/(?:api|stream|event|hook)(?:\/|$)/.test(new URL(request.url()).pathname)) api.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); localStorage.setItem('office-layout', 'cozy'); });
  try {
    await page.goto(fixture.invite!);
    await expect(page).not.toHaveURL(/lioops-pair/);
    await expect(page.getByRole('button', { name: 'Yêu cầu ghép' })).toBeVisible();
    await expect(page.locator('#stage canvas')).toHaveCount(0);
    expect(fixture.connector.state.pending).toBeNull();
    await page.getByRole('button', { name: 'Yêu cầu ghép' }).click();
    await expect(page.locator('.cs-fingerprint')).toHaveText(/^[A-Za-z0-9_-]{43}$/);
    await pc.goto(fixture.controlURL);
    const approve = pc.getByRole('button', { name: 'Mã trùng — cho phép quan sát' });
    await expect(approve).toBeVisible();
    expect(await pc.locator('#fingerprint').textContent()).toBe(await page.locator('.cs-fingerprint').textContent());
    await pc.screenshot({ path: test.info().outputPath('pc-consent.png') });
    await approve.click();
    await expect(page.locator('#stage canvas')).toBeVisible({ timeout: 90000 });
    await expect(page.locator('#rail-list .ri').first()).toContainText('green-project', { timeout: 60000 });
    await expect(page.locator('#demo-chip')).toBeHidden();
    await expect(page.locator('#btn-give-work')).toBeHidden();
    await page.locator('#rail-list .ri').first().click();
    await expect(page.locator('#ds-body')).toContainText('PRIVATE-C-ANSWER-2026');
    await expect(page.locator('#ds-codex-usage')).toContainText('90%');
    await page.screenshot({ path: test.info().outputPath('encrypted-office.png') });
    await fixture.append(); await expect(page.locator('#ds-body')).toContainText('PRIVATE-C-LIVE-UPDATE');
    await page.reload();
    await expect(page.locator('#rail-list .ri').first()).toContainText('green-project', { timeout: 90000 });
    await expect(pc.locator('#pending')).toBeHidden();
    await page.locator('#rail-list .ri').first().click(); await expect(page.locator('#ds-body')).toContainText('PRIVATE-C-LIVE-UPDATE');
    await context.setOffline(true);
    await expect(page.locator('#rail-list .ri')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('#ds-body')).not.toContainText('PRIVATE-C');
    await context.setOffline(false);
    await expect(page.locator('#rail-list .ri').first()).toContainText('green-project', { timeout: 60000 });
    await expect(page.locator('#ds-body')).toContainText('PRIVATE-C-LIVE-UPDATE');
    const revokeResponse = pc.waitForResponse(response => new URL(response.url()).pathname === '/control/revoke');
    await pc.getByRole('button', { name: 'Thu hồi quyền trình duyệt' }).click();
    expect((await revokeResponse).status()).toBe(200);
    await expect(pc.locator('#status')).toHaveText('Đã thu hồi quyền tại PC.');
    await expect(page.locator('#rail-list .ri')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('#ds-body')).not.toContainText('PRIVATE-C');
    expect(fixture.wire.length).toBeGreaterThan(2);
    for (const body of fixture.wire) { expect(body).not.toContain('PRIVATE-C'); expect(body).not.toContain('green-project'); }
    expect(api).toEqual([]); expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Cấu hình kết nối' }).click();
    await page.getByRole('button', { name: 'Quên máy này' }).click();
    await expect(page.locator('.remote-status')).toHaveCount(0);
    await expect(page.locator('#stage canvas')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Tải bộ kết nối' })).toBeDisabled();
  } catch (error) {
    await page.screenshot({ path: test.info().outputPath('encrypted-failure.png') }).catch(() => {});
    const connectionState = JSON.stringify({
      connector: fixture.connector.state, wireCount: fixture.wire.length, delivery: fixture.delivery, transport, errors,
      browserStatus: await page.locator('.remote-status').textContent().catch(() => ''),
    }, null, 2);
    fs.writeFileSync(test.info().outputPath('connection-state.json'), connectionState);
    await test.info().attach('connection-state', { contentType: 'application/json', body: Buffer.from(connectionState) }); throw error;
  } finally { await context.setOffline(false).catch(() => {}); await Promise.allSettled([page.close(), pc.close()]); await fixture.close(); }
});
