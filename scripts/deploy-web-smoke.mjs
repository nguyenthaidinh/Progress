// Public deployment smoke. A fresh browser profile and synthetic demo never access a user's PC backend.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { isIP } from 'node:net';
const target = new URL(process.env.LIOOPS_DEPLOY_WEB_URL || 'https://ops.liotnu.com/');
if (target.protocol !== 'https:' || target.username || target.password) throw new Error('An HTTPS deployment URL is required');
const ip = process.env.LIOOPS_DEPLOY_EDGE_IP;
if (ip && !isIP(ip)) throw new Error('Invalid explicit DNS override');
const browser = await chromium.launch({ headless: true, args: ip ? [`--host-resolver-rules=MAP ${target.hostname} ${ip}`] : [] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage(), errors = [], pcRequests = [];
const out = path.resolve('.deploy-work/public-smoke'); await fs.mkdir(out, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && /content security policy|refused to execute/i.test(message.text())) errors.push(message.text()); });
page.on('request', request => { if (/^\/(api|stream|hook|event)(\/|$)/.test(new URL(request.url()).pathname)) pcRequests.push(request.url()); });
await page.addInitScript(() => { localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low'); localStorage.setItem('office-layout', 'cozy'); });
try {
  const response = await page.goto(new URL('vi/', target).href, { waitUntil: 'networkidle', timeout: 60000 });
  assert.equal(response.status(), 200); assert.ok(response.headers()['content-security-policy']?.includes('sha256-'));
  await page.getByRole('heading', { name: 'Kết nối một lần. Dùng văn phòng như cũ.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Tải bộ kết nối' }).isDisabled(), true);
  assert.equal(await page.locator('#stage canvas').count(), 0);
  await page.screenshot({ path: path.join(out, 'setup.png') });
  await page.getByRole('link', { name: 'Xem văn phòng mẫu' }).click();
  await page.locator('#stage canvas').waitFor({ timeout: 90000 }); await page.locator('#rail-list .ri').first().waitFor({ timeout: 60000 });
  assert.equal(await page.locator('#demo-chip').isVisible(), true);
  await page.screenshot({ path: path.join(out, 'office-demo.png') });
  assert.deepEqual(errors, []); assert.deepEqual(pcRequests, []);
  const report = { status: 'pass', url: target.href, validHttps: true, csp: true, setup: true, explicitDemo: true, pcApiRequests: 0, errors };
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, errors, pcRequests }, null, 2)); throw error;
} finally { await browser.close(); }
