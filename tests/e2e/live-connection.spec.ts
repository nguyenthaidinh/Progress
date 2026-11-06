import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { HOME_DIR } from '../../playwright.config';

// Chromium's offline emulation can leave an already-open EventSource alive. A loopback proxy lets the test
// sever its actual HTTP connection without adding a test-only endpoint to the production backend.
async function liveProxy(backend: string) {
  const streams = new Set<http.ServerResponse>();
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(new URL(req.url || '/', backend), { method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode || 502, incoming.headers);
      incoming.on('error', () => res.destroy()); incoming.pipe(res);
    });
    if (req.url?.startsWith('/stream')) streams.add(res);
    res.on('close', () => { streams.delete(res); upstream.destroy(); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing test proxy address');
  return { url: `http://127.0.0.1:${address.port}`,
    disconnect() { for (const response of streams) response.destroy(); },
    async close() { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); },
  };
}

for (const transport of ['sse', 'poll'] as const) {
  test(`${transport}: real sessions survive offline/reconnect and returning from replay`, async ({ page, request, context, baseURL }) => {
    test.setTimeout(180000);
    const errors: string[] = [], streams: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (/\/(stream|api\/live)(\?|$)/.test(req.url())) streams.push(req.url()); });
    await page.addInitScript(mode => {
      localStorage.setItem('office-tips', 'seen'); localStorage.setItem('office-quality', 'low');
      localStorage.setItem('office-layout', 'cozy'); localStorage.setItem('office-lite', 'on');
      if (mode === 'poll') Object.defineProperty(window, 'EventSource', { value: undefined });
    }, transport);
    const project = path.join(HOME_DIR, `stream-${transport}-${Date.now()}`);
    const addSession = async (suffix: string) => {
      const folder = `${project}-${suffix}`;
      fs.mkdirSync(folder, { recursive: true });
      const id = `stream-${transport}-${suffix}-${Date.now()}`;
      const response = await request.post('/event', { data: { hook_event_name: 'SessionStart', session_id: id, cwd: folder } });
      expect(response.ok()).toBe(true);
      let officeId = '';
      await expect.poll(async () => {
        const metadata = await (await request.get('/api/tasks')).json();
        officeId = metadata.sessions.find((session: { id: string; dir: string }) => session.dir.endsWith(path.basename(folder)))?.id || '';
        return officeId;
      }).not.toBe('');
      return officeId;
    };
    if (!baseURL) throw new Error('Missing test backend URL');
    const proxy = transport === 'sse' ? await liveProxy(baseURL) : null;
    try {
      const first = await addSession('first');
      await page.goto(`${proxy?.url || ''}/?layout=cozy`);
      await expect(page.locator('#conn')).toHaveAttribute('data-state', 'on');
      await expect(page.locator(`#rail-list [data-sess="${first}"]`)).toBeVisible();
      await expect(page.locator('#demo-chip')).toBeHidden();

      await context.setOffline(true);
      proxy?.disconnect();
      await expect(page.locator('#conn')).toHaveAttribute('data-state', 'off');
      const second = await addSession('offline');
      await expect(page.locator('#demo-chip')).toBeHidden();
      await context.setOffline(false);
      await expect(page.locator('#conn')).toHaveAttribute('data-state', 'on', { timeout: 60000 });
      await expect(page.locator(`#rail-list [data-sess="${second}"]`)).toBeVisible();

      // History is a bounded fixture; stopping replay must reconnect to the real backend, not keep the fixture snapshot.
      await page.route('**/api/replay?*', route => route.fulfill({ json: { items: [
        { t: Date.now() - 1000, m: { k: 'snap', sessions: [], feed: [], stats: {} } },
      ] } }));
      await page.locator('#btn-replay').click();
      await expect(page.locator('#replay-chip')).toBeVisible();
      await page.locator('#rp-close').click();
      await expect(page.locator('#replay-chip')).toBeHidden();
      await expect(page.locator('#conn')).toHaveAttribute('data-state', 'on');
      await expect(page.locator(`#rail-list [data-sess="${second}"]`)).toBeVisible();
      expect(streams.some(url => url.includes(transport === 'sse' ? '/stream' : '/api/live?'))).toBe(true);
      if (transport === 'poll') expect(streams.some(url => /\/stream(?:\?|$)/.test(url))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await context.setOffline(false);
      if (!page.isClosed()) await page.close();
      await proxy?.close();
    }
  });
}
