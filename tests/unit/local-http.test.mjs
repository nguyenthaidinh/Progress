import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createLocalHttpSource } from '../../src/office/data/local-http.js';

const snap = { k: 'snap', sessions: [{ id: 'fixture', name: 'shop' }], feed: [], stats: {} };
const stats = { k: 'stats', stats: { read: 3 } };
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

class FakeStream {
  static instances = [];
  constructor(url) { this.url = url; this.closed = 0; this.readyState = 1; FakeStream.instances.push(this); }
  close() { this.closed++; }
  emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
class HiddenPage extends EventTarget {
  hidden = true; listeners = new Set();
  addEventListener(type, fn, options) { this.listeners.add(fn); super.addEventListener(type, fn, options); }
  removeEventListener(type, fn, options) { this.listeners.delete(fn); super.removeEventListener(type, fn, options); }
}

test('SSE requires a valid snapshot, reconnects without duplicate streams, and ignores callbacks after close', () => {
  const packets = [], statuses = [];
  const close = createLocalHttpSource({ EventSource: FakeStream, token: 'key + unicode đ', now: () => 123 })
    .subscribe({ onEvent: p => packets.push(p), onStatus: s => statuses.push(s) });
  const stream = FakeStream.instances.at(-1);
  assert.equal(new URL(stream.url, 'http://localhost').searchParams.get('k'), 'key + unicode đ');
  stream.onopen(); stream.emit(stats); stream.emit({ k: 'snap' }); stream.onmessage({ data: '{broken' });
  assert.equal(packets.length, 0); assert.equal(statuses.includes('connected'), false);
  stream.emit(snap); stream.emit(stats); stream.onerror(); stream.emit(stats);
  stream.onopen(); stream.emit(snap);
  assert.deepEqual(packets.map(p => p.message), [snap, stats, snap]);
  assert.equal(packets[0].source, 'local-http'); assert.equal(packets[0].receivedAt, 123);
  const lateEvent = stream.onmessage, lateOpen = stream.onopen, lateError = stream.onerror;
  close(); close(); lateEvent({ data: JSON.stringify(snap) }); lateOpen(); lateError();
  assert.equal(packets.length, 3); assert.equal(stream.closed, 1); assert.equal(stream.onmessage, null);
});

test('long-poll uses the real HTTP backend, preserves cursors on errors and only performs reads', async t => {
  const requests = [], packets = [], complete = deferred();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push({ method: req.method, url });
    res.setHeader('Content-Type', 'application/json');
    if (requests.length === 1) res.end(JSON.stringify({ seq: 10, msgs: [snap] }));
    else if (requests.length === 2) { res.statusCode = 503; res.end('{}'); }
    else res.end(JSON.stringify({ seq: 11, msgs: [stats] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = createLocalHttpSource({ polling: true, token: 'test key', retryMs: 1, fetch: (url, init) => fetch(base + url, init) })
    .subscribe({ onEvent: p => { packets.push(p); if (packets.length === 2) { close(); complete.resolve(); } }, onStatus() {} });
  t.after(close); await complete.promise;
  assert.deepEqual(packets.map(p => p.message), [snap, stats]);
  assert.deepEqual(requests.map(r => r.url.searchParams.get('since')), ['-1', '10', '10']);
  assert.ok(requests.every(r => r.method === 'GET' && r.url.pathname === '/api/live' && r.url.searchParams.get('k') === 'test key'));
});

test('invalid poll batches cannot advance the cursor or apply a partial batch', async t => {
  const queries = [], packets = [], complete = deferred();
  const batches = [{ seq: 4, msgs: [snap] }, { seq: 6, msgs: [stats, { k: 'ev', s: null }] }, { seq: 6, msgs: [stats] }];
  const close = createLocalHttpSource({ polling: true, retryMs: 1, fetch: async url => {
    queries.push(new URL(url, 'http://localhost').searchParams.get('since')); return response(batches.shift());
  } }).subscribe({ onEvent: p => { packets.push(p); if (packets.length === 2) { close(); complete.resolve(); } }, onStatus() {} });
  t.after(close); await complete.promise;
  assert.deepEqual(queries, ['-1', '4', '4']); assert.deepEqual(packets.map(p => p.message), [snap, stats]);
});

test('a restarted backend can reset the cursor only with a fresh snapshot', async t => {
  const queries = [], packets = [], complete = deferred();
  const batches = [{ seq: 8, msgs: [snap] }, { seq: 0, msgs: [stats] }, { seq: 0, msgs: [snap] }];
  const close = createLocalHttpSource({ polling: true, retryMs: 1, fetch: async url => {
    queries.push(new URL(url, 'http://localhost').searchParams.get('since')); return response(batches.shift());
  } }).subscribe({ onEvent: p => { packets.push(p); if (packets.length === 2) { close(); complete.resolve(); } }, onStatus() {} });
  t.after(close); await complete.promise;
  assert.deepEqual(queries, ['-1', '8', '8']); assert.deepEqual(packets.map(p => p.message), [snap, snap]);
});

test('closing a hidden poll removes the visibility listener and makes no request', async () => {
  const page = new HiddenPage(); let calls = 0;
  const close = createLocalHttpSource({ polling: true, document: page, fetch: async () => { calls++; } })
    .subscribe({ onEvent() {}, onStatus() {} });
  assert.equal(page.listeners.size, 1); close();
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(page.listeners.size, 0); assert.equal(calls, 0);
});

test('closing aborts in-flight reads and ignores a response that races cancellation', async () => {
  const gate = deferred(), packets = [], statuses = []; let signal;
  const close = createLocalHttpSource({ polling: true, fetch: async (_url, init) => { signal = init.signal; await gate.promise; return response({ seq: 1, msgs: [snap] }); } })
    .subscribe({ onEvent: p => packets.push(p), onStatus: s => statuses.push(s) });
  close(); assert.equal(signal.aborted, true); gate.resolve(); await flush();
  assert.deepEqual(packets, []); assert.equal(statuses.includes('connected'), false);
});

test('request timeouts and close during retry leave no retry running', async () => {
  const done = deferred(); let calls = 0, close;
  const statuses = [];
  close = createLocalHttpSource({ polling: true, retryMs: 1, requestTimeoutMs: 5,
    fetch: (_url, { signal }) => { calls++; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
  }).subscribe({ onEvent() {}, onStatus: s => { statuses.push(s); if (s === 'reconnecting') { close(); done.resolve(); } } });
  await done.promise; await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 1); assert.equal(statuses.includes('connected'), false);
});

test('unauthorized responses stop without retrying or sending a new task', async () => {
  const done = deferred(), statuses = []; let calls = 0;
  const close = createLocalHttpSource({ polling: true, fetch: async () => { calls++; return response({}, 401); } })
    .subscribe({ onEvent() { assert.fail('Unauthorized data'); }, onStatus: s => { statuses.push(s); if (s === 'unauthorized') done.resolve(); } });
  await done.promise; await flush(); close();
  assert.equal(calls, 1); assert.equal(statuses.at(-1), 'unauthorized');
});
