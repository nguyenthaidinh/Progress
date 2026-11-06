import { test, expect } from '@playwright/test';
import { createOfficeClient } from '../../src/office/data/client.js';
import { createLocalHttpSource } from '../../src/office/data/local-http.js';

// Exercise the shipped client/adapter against the isolated production backend. No AI run or OS action is started.
test('panel operations read/write real backend state through the named API and confirmed grants', async ({ baseURL }) => {
  test.setTimeout(120000);
  if (!baseURL) throw new Error('Missing isolated backend URL');
  const client = createOfficeClient(), paths: string[] = [];
  const forward: typeof fetch = (input, init) => {
    const target = typeof input === 'string' ? new URL(input, baseURL) : input;
    paths.push((target instanceof URL ? target : new URL(target.url)).pathname);
    return fetch(target, init);
  };
  const adapter = createLocalHttpSource({ polling: true, fetch: forward });
  client.connect(adapter);
  // Response-like replies deliberately expose boolean `ok`, just like fetch.
  const api = async (name: string, params = {}) => {
    const response = await client.request(name, params);
    expect(response.ok, `${name} HTTP status ${response.status}`).toBe(true);
    return response.json();
  };
  let todo = '', oldQuick: unknown[] | null = null, oldCache = false, savedQuick = false, savedCache = false;
  let oldLoop: { on: boolean; n: number; min: number } | null = null;
  try {
    await expect.poll(() => client.can('tasks.start')).toBe(true);
    expect(client.state.status).toBe('connected');
    expect((await api('tasks.metadata')).ok).toBe(true);
    expect((await api('system.read')).mem.total).toBeGreaterThan(0);
    const now = Date.now(), from = now - 3600000, day = new Date(now).toLocaleDateString('sv-SE');
    await api('history.burn', { range: '1h' }); await api('history.wrapped');
    await api('history.timeline', { from, to: now }); await api('history.replay', { day, from, to: now });

    const text = `B2 Unicode request ${Date.now()} — kiểm tra`;
    expect((await api('chat.send', { text })).ok).toBe(true);
    expect((await api('chat.read')).msgs.some((message: { text?: string }) => message.text === text)).toBe(true);

    oldQuick = (await api('quick.read')).list; savedQuick = true;
    expect((await api('quick.write', { list: [{ label: 'B2', prompt: text }] })).ok).toBe(true);
    expect((await api('quick.read')).list[0].prompt).toBe(text);
    const added = await api('todos.write', { op: 'add', text });
    expect(added.ok).toBe(true); todo = added.todos.find((item: { text: string }) => item.text === text).id;
    const toggled = await api('todos.write', { op: 'toggle', id: todo, done: true });
    expect(toggled.todos.find((item: { id: string }) => item.id === todo).done).toBe(true);

    oldCache = (await api('cache.read')).nudge; savedCache = true;
    expect((await api('cache.write', { nudge: !oldCache })).ok).toBe(true);
    expect((await api('cache.read')).nudge).toBe(!oldCache);
    const loop = await api('loop.read'); oldLoop = { on: loop.on, n: loop.n, min: loop.min };
    expect((await api('loop.config', { ...oldLoop, on: false })).ok).toBe(true);
    await api('preferences.language', { lang: 'vi' }); await api('preferences.language', { lang: 'en' });
    expect(paths).toContain('/api/todos'); expect(paths).toContain('/api/chat'); expect(paths).not.toContain('/api/tasks/steer');
  } finally {
    try {
      if (todo) await api('todos.write', { op: 'del', id: todo });
      if (savedQuick) await api('quick.write', { list: oldQuick || [] });
      if (savedCache) await api('cache.write', { nudge: oldCache });
      if (oldLoop) await api('loop.config', oldLoop);
      if (client.can('preferences.language')) await api('preferences.language', { lang: 'en' });
    } finally { client.close(); }
  }
});
