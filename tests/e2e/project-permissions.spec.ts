import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { projectObservationFixture } from '../fixtures/project-observation.mjs';
test.skip(process.env.LIOOPS_OBSERVER_STATIC !== '1', 'Requires the separate public export.');
test('D can change owner permissions before opening a transcript', async ({ page, context, baseURL }) => {
  test.setTimeout(240000);
  const fixture = await projectObservationFixture(new URL(baseURL!).origin), pc = await context.newPage();
  try {
    await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); localStorage.setItem('office-layout', 'cozy'); });
    await page.goto(fixture.invite!); await page.getByRole('button', { name: 'Yêu cầu ghép' }).click();
    await expect(page.locator('.cs-fingerprint')).toHaveText(/^[A-Za-z0-9_-]{43}$/);
    await pc.goto(fixture.controlURL); await expect(pc.locator('#fingerprint')).toHaveText(await page.locator('.cs-fingerprint').innerText()); await pc.locator('#approve').click();
    await expect(page.locator('#remote-observation[data-revision="1"]')).toBeVisible({ timeout: 90000 });
    await pc.locator('#allow-content').uncheck(); await pc.locator('#allow-quota').uncheck(); await pc.locator('#allow-metrics').check(); await pc.locator('#apply').click();
    await expect(page.locator('#remote-observation[data-revision="2"]')).toBeVisible({ timeout: 90000 });
    await expect(page.locator('#rail-list .ri')).toHaveCount(2);
  } finally {
    fs.writeFileSync(test.info().outputPath('permission-diagnostics.json'), JSON.stringify({ state: fixture.connector.state, delivery: fixture.delivery }, null, 2));
    await Promise.allSettled([page.close(), pc.close()]); await fixture.close();
  }
});
