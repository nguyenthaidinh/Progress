import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createControl } from '../../connector/control.mjs';
import vi from '../../src/i18n/locales/vi/remote.js';
import { randomSecret } from '../../src/shared/remote/crypto.js';

test('PC consent keeps one refresh in flight and cannot render an old status over a new owner action', async t => {
  const state = { protocol: 2, revision: 1, status: 'connected', paired: true, revoked: false, pending: null, projects: ['fixture'],
    permissions: { content: true, accountQuota: true, systemMetrics: false } };
  const control = await createControl({ state, inviteURL: null }); t.after(() => control.close());
  const script = await (await fetch(new URL('/control.js', control.url))).text(), nodes = new Map(), requests = []; let interval;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', hidden: false, disabled: false, checked: false, removeAttribute() {} });
    return nodes.get(id);
  };
  const buttons = ['approve', 'reject', 'revoke', 'apply'].map(node);
  const context = vm.createContext({
    location: { hash: '#control=' + randomSecret() }, history: { replaceState() {} }, URLSearchParams, AbortSignal,
    document: { getElementById: node, querySelectorAll: () => buttons },
    setInterval(callback) { interval = callback; },
    fetch(url, init) { return new Promise(resolve => requests.push({ url, init, resolve })); },
  });
  vm.runInContext(script, context);
  const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const respond = (request, value) => request.resolve({ ok: true, json: async () => value });
  assert.equal(requests.length, 1);
  for (let i = 0; i < 20; i++) interval();
  assert.equal(requests.length, 1); // A stalled local request does not create an unbounded one-per-second queue.
  const action = node('revoke').onclick(); assert.equal(requests.length, 2); assert.equal(requests[1].url, '/control/revoke');
  respond(requests[0], { state, inviteURL: null, copy: vi }); await drain();
  assert.equal(node('status').textContent, ''); // This status started before the owner action and must be ignored.
  respond(requests[1], { ok: true }); await drain(); assert.equal(requests.length, 3);
  respond(requests[2], { state: { ...state, paired: false, revoked: true }, inviteURL: null, copy: vi });
  await action; assert.equal(node('status').textContent, vi.revoked); assert.equal(node('revoke').hidden, true);
  assert.ok(requests.every(request => request.init.signal instanceof AbortSignal));
});
