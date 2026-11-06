import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalApi, createLocalResourceUrl } from '../../src/office/data/local-api.js';
import { createLocalHttpSource } from '../../src/office/data/local-http.js';
import { createOfficeClient } from '../../src/office/data/client.js';
import { OFFICE_OPERATIONS, resolveApiOperation } from '../../src/shared/contracts/api.js';
import { officeCapabilities } from '../../src/shared/contracts/office.js';

const all = officeCapabilities(Object.fromEntries(['observe','content','accountQuota','systemMetrics','taskStart','taskStop','approve','writeState','localAdmin','openApp'].map(k => [k,true])));
const task = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', dir: 'F:\\Dự án\\shop', text: 'Private prompt', images: ['data:image/png;base64,AAAA'] };
const reply = data => ({ ok: true, status: 200, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function source(request, capability = all) { return { source: 'local-http', capabilities: capability, subscribe: () => () => {}, request }; }

test('named requests encode query values, own the token/method/origin policy and reject arbitrary fetch options', async () => {
  const calls = [];
  const request = createLocalApi({ token: 'real + token', capabilities: () => all,
    fetch: async (url, init) => { calls.push({ url, init }); return reply({ ok: true }); } });
  await request('log.read', { id: 'other?secret=1', agent: 'sub&k=attacker' });
  const url = new URL(calls[0].url, 'http://localhost');
  assert.equal(url.pathname, '/api/log'); assert.equal(url.searchParams.get('k'), 'real + token');
  assert.equal(url.searchParams.get('id'), 'other?secret=1'); assert.equal(url.searchParams.get('agent'), 'sub&k=attacker');
  assert.equal(calls[0].init.credentials, 'same-origin'); assert.equal(calls[0].init.redirect, 'error');
  await request('tasks.start', task);
  assert.equal(calls[1].init.method, 'POST'); assert.deepEqual(JSON.parse(calls[1].init.body), task);
  for (const params of [{ id: 'x', k: 'fake' }, { id: 'x', url: 'https://example.com' }, { id: 'x', method: 'POST' }]) {
    await assert.rejects(request('log.read', params), { code: 'invalid' });
  }
  await assert.rejects(request('/api/tasks', task), { code: 'unsupported' });
  assert.equal(calls.length, 2);
});

test('body discriminants, bounded JSON and durable task IDs are validated before transport', () => {
  assert.deepEqual(resolveApiOperation('loop.config', { on: true, n: 3, min: 10 }).params, { op: 'config', on: true, n: 3, min: 10 });
  assert.throws(() => resolveApiOperation('loop.config', { op: 'stop', id: 'x' }), { code: 'invalid' });
  assert.throws(() => resolveApiOperation('tasks.start', { dir: 'x', text: 'missing ID' }), { code: 'invalid' });
  assert.throws(() => resolveApiOperation('tasks.start', { requestId: task.requestId, text: 'missing target' }), { code: 'invalid' });
  assert.throws(() => resolveApiOperation('log.read', {}), { code: 'invalid' });
  assert.throws(() => resolveApiOperation('push.add', { sub: JSON.parse('{"constructor":{"prototype":{"x":1}}}') }), { code: 'invalid' });
  const answers = Array.from({ length: 20 }, (_, q) => ({ q, pick: [0], other: '' }));
  assert.equal(resolveApiOperation('permissions.answer', { id: 'request', choice: 'answer', answers }).params.answers.length, 20);
  for (const operation of Object.values(OFFICE_OPERATIONS)) assert.ok(Object.hasOwn(all, operation.capability));
});

test('observation/demo sources cannot call PC APIs even with forged execution capabilities', async () => {
  let calls = 0;
  for (const name of ['browser-log', 'demo']) {
    const client = createOfficeClient();
    client.selectSource({ ...source(async () => { calls++; return reply({}); }), source: name, resourceUrl: () => '/api/image?id=x' });
    await assert.rejects(client.request('tasks.start', task), { code: 'unavailable' });
    await assert.rejects(client.request('log.read', { id: 'x' }), { code: 'unavailable' });
    assert.throws(() => client.resourceUrl('image.read', { id: 'x' }), { code: 'unavailable' });
    assert.equal(client.can('system.action'), false); client.close();
  }
  assert.equal(calls, 0);
});

test('grants come from snapshots and revocations block new calls before a fetch', async () => {
  let calls = 0;
  class Stream { static instances = []; constructor() { Stream.instances.push(this); } close() {} }
  const adapter = createLocalHttpSource({ EventSource: Stream, fetch: async () => { calls++; return reply({ ok: true }); } });
  const client = createOfficeClient(); client.connect(adapter);
  const stream = Stream.instances.at(-1);
  await assert.rejects(client.request('tasks.start', task), { code: 'forbidden' });
  assert.equal(calls, 0);
  stream.onopen();
  const emit = message => stream.onmessage({ data: JSON.stringify(message) });
  emit({ k: 'snap', local: false, phoneTasks: false, phoneApprove: false, sessions: [] });
  await client.request('tasks.metadata');
  await assert.rejects(client.request('system.auto', { hours: 0 }), { code: 'forbidden' });
  emit({ k: 'phone', tasks: true, approve: true });
  assert.equal(client.can('tasks.start'), true); await client.request('tasks.start', task);
  await client.request('permissions.answer', { id: 'p', choice: 'deny' });
  emit({ k: 'phone', tasks: false, approve: false });
  await assert.rejects(client.request('tasks.start', task), { code: 'forbidden' });
  await assert.rejects(client.request('permissions.answer', { id: 'p', choice: 'allow' }), { code: 'forbidden' });
  assert.equal(calls, 3);
  emit({ k: 'snap', local: true, sessions: [] }); assert.equal(client.can('system.action'), true);
  emit({ k: 'snap', sessions: [] }); assert.equal(client.can('system.action'), false);
  client.close();
});

test('switching a source aborts pending requests and cannot reconcile a task on the new source', async () => {
  const client = createOfficeClient(), gate = deferred(); let signal, otherCalls = 0;
  client.selectSource(source(async (_name, _params, options) => { signal = options.signal; await gate.promise; return reply({ private: true }); }));
  const context = client.context, pending = client.request('tasks.start', task, { context });
  client.selectSource(source(async () => { otherCalls++; return reply({}); }));
  assert.equal(signal.aborted, true); gate.resolve();
  await assert.rejects(pending, { code: 'sourceChanged' });
  await assert.rejects(client.request('tasks.receipt', { id: task.requestId }, { context }), { code: 'sourceChanged' });
  assert.equal(otherCalls, 0); client.close();
});

test('response bodies are guarded if the source changes after headers arrive', async () => {
  const client = createOfficeClient(); client.selectSource(source(async () => reply({ secret: true })));
  const response = await client.request('log.read', { id: 'x' });
  client.selectSource(source(async () => reply({})));
  await assert.rejects(response.json(), { code: 'sourceChanged' }); client.close();
});

test('stream reconnect keeps the API context and never aborts or repeats an accepted task', async () => {
  const client = createOfficeClient(), gate = deferred(); let signal, calls = 0, subscriptions = 0, closed = 0;
  const adapter = { ...source(async (_name, _params, options) => { calls++; signal = options.signal; await gate.promise; return reply({ ok: true }); }),
    subscribe() { subscriptions++; return () => closed++; } };
  client.connect(adapter); const context = client.context, pending = client.request('tasks.start', task, { context });
  client.reconnect(); assert.equal(client.context, context); assert.equal(signal.aborted, false);
  gate.resolve(); assert.equal((await (await pending).json()).ok, true);
  assert.equal(calls, 1); assert.equal(subscriptions, 2); assert.equal(closed, 1); client.close();
});

test('write failures and deadlines never retry; aborted and malformed replies expose no body text', async () => {
  let calls = 0;
  const fail = createLocalApi({ capabilities: () => all, fetch: async () => { calls++; throw new Error(task.text); } });
  await assert.rejects(fail('tasks.start', task), error => error.code === 'unreachable' && !error.message.includes(task.text));
  assert.equal(calls, 1);
  const timeout = createLocalApi({ capabilities: () => all, fetch: (_url, { signal }) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })); } });
  await assert.rejects(timeout('tasks.start', task, { timeoutMs: 5 }), { code: 'timeout' }); assert.equal(calls, 2);
  const malformed = createLocalApi({ capabilities: () => all, fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error(task.text); } }) });
  await assert.rejects(malformed('tasks.metadata'), { code: 'invalidResponse' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fail('tasks.metadata', {}, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 2);
});

test('keepalive is restricted to leaving presence and stays bound to the original source', async () => {
  const client = createOfficeClient(), gate = deferred(); let signal, calls = 0;
  client.selectSource(source(async (_name, _params, options) => { signal = options.signal; calls++; await gate.promise; return reply({}); }));
  await assert.rejects(client.request('tasks.start', task, { keepalive: true }), { code: 'invalid' });
  await assert.rejects(client.request('presence.update', { page: 'p', focused: true }, { keepalive: true }), { code: 'invalid' });
  const pending = client.request('presence.update', { page: 'p', focused: false }, { keepalive: true });
  client.close(); assert.equal(signal.aborted, false); gate.resolve();
  await assert.rejects(pending, { code: 'sourceChanged' }); assert.equal(calls, 1);
});

test('native image URLs are scoped, encoded and cannot turn an execution operation into a resource', () => {
  const url = createLocalResourceUrl({ token: 'bound key', capabilities: () => all })('image.read', { id: 'a&k=forged' });
  const parsed = new URL(url, 'http://localhost');
  assert.equal(parsed.pathname, '/api/image'); assert.equal(parsed.searchParams.get('k'), 'bound key');
  assert.equal(parsed.searchParams.get('id'), 'a&k=forged');
  assert.throws(() => createLocalResourceUrl({ capabilities: () => all })('tasks.start', task), { code: 'unsupported' });
  const client = createOfficeClient();
  client.selectSource({ ...source(async () => reply({})), resourceUrl: () => 'https://example.com/' });
  assert.throws(() => client.resourceUrl('image.read', { id: 'x' }), { code: 'invalidResponse' }); client.close();
});

test('long-poll applies revocations from the whole batch before invoking a UI callback', async () => {
  const done = deferred(); let close;
  const adapter = createLocalHttpSource({ polling: true, fetch: async () => reply({ seq: 2, msgs: [
    { k: 'snap', local: false, phoneTasks: true, phoneApprove: true, sessions: [] },
    { k: 'phone', tasks: false, approve: false },
  ] }) });
  close = adapter.subscribe({ onEvent() {
    assert.equal(adapter.capabilities.taskStart, false); assert.equal(adapter.capabilities.approve, false);
    close(); done.resolve();
  }, onStatus() {} });
  await done.promise;
});

test('long-poll restores confirmed grants after a failed read without discarding the cursor', async () => {
  const done = deferred(); let count = 0, close;
  const adapter = createLocalHttpSource({ polling: true, retryMs: 1, fetch: async url => {
    count++;
    if (count === 1) return reply({ seq: 4, msgs: [{ k: 'snap', local: true, sessions: [] }] });
    if (count === 2) throw new Error('connection lost');
    assert.equal(new URL(url, 'http://localhost').searchParams.get('since'), '4');
    return reply({ seq: 4, msgs: [] });
  } });
  close = adapter.subscribe({ onEvent() {}, onStatus(status) {
    if (status === 'reconnecting') assert.equal(adapter.capabilities.taskStart, false);
    if (status === 'connected' && count === 3) { assert.equal(adapter.capabilities.taskStart, true); close(); done.resolve(); }
  } });
  await done.promise; assert.equal(count, 3);
});
