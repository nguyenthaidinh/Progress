import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficeClient } from '../../src/office/data/client.js';
import { officeCapabilities, officePacket } from '../../src/shared/contracts/office.js';
import { resolveOfficeSource } from '../../src/shared/office-source.js';

const snap = { k: 'snap', sessions: [], feed: [], stats: {} };
function source(name = 'local-http') {
  const calls = [];
  return { source: name, capabilities: { observe: true, taskStart: 'true' }, calls,
    subscribe(handlers) { const call = { ...handlers, closed: 0 }; calls.push(call); return () => call.closed++; } };
}

test('public and unknown sources stay unpaired; demo and browser logs require explicit selection', () => {
  for (const defaultSource of ['unpaired', '', undefined, 'relay', 'arbitrary']) {
    assert.equal(resolveOfficeSource({ defaultSource }), 'unpaired');
    assert.equal(resolveOfficeSource({ defaultSource, search: '?source=local-http&connected=true' }), 'unpaired');
    assert.equal(resolveOfficeSource({ defaultSource, search: '?demo' }), 'demo');
    assert.equal(resolveOfficeSource({ defaultSource, search: '?demo&observe' }), 'browser-log');
  }
  assert.equal(resolveOfficeSource({ defaultSource: 'local-http' }), 'local-http');
  assert.equal(resolveOfficeSource({ defaultSource: 'demo' }), 'demo');
});

test('capabilities fail closed and invalid payloads do not reach the UI', () => {
  const client = createOfficeClient(), adapter = source(), received = [];
  client.subscribe(event => received.push(event)); client.connect(adapter);
  assert.equal(client.state.capabilities.taskStart, false);
  assert.deepEqual(officeCapabilities({ observe: 1 }), officeCapabilities());
  const handler = adapter.calls[0];
  for (const packet of [null, { version: 9 }, { ...officePacket(snap, 'local-http', 12), source: 'demo' },
    { ...officePacket(snap, 'local-http', 12), message: { k: 'snap' } }, { ...officePacket(snap, 'local-http', 12), receivedAt: -1 }]) handler.onEvent(packet);
  assert.equal(received.length, 0);
  const packet = officePacket(snap, 'local-http', 42); handler.onEvent(packet);
  assert.equal(received[0].message, snap); assert.equal(client.state.receivedAt, 42);
  assert.equal(officePacket({ k: 'ev', s: { id: 'a' } }, 'local-http'), null);
  client.close();
});

test('replacing a source cancels it and ignores all late messages and status callbacks', () => {
  const client = createOfficeClient(), first = source(), second = source('browser-log'), received = [];
  client.subscribe(packet => received.push(packet));
  client.connect(first); client.connect(first); assert.equal(first.calls.length, 1);
  first.calls[0].onStatus('connected'); first.calls[0].onEvent(officePacket(snap, 'local-http', 1));
  client.connect(second); assert.equal(first.calls[0].closed, 1); assert.equal(client.state.receivedAt, null);
  first.calls[0].onEvent(officePacket(snap, 'local-http', 2)); first.calls[0].onStatus('unauthorized');
  assert.equal(client.state.source, 'browser-log'); assert.equal(client.state.status, 'connecting');
  second.calls[0].onEvent(officePacket(snap, 'browser-log', 3));
  client.close(); client.close();
  second.calls[0].onEvent(officePacket(snap, 'browser-log', 4)); second.calls[0].onStatus('connected');
  assert.deepEqual(received.map(p => p.receivedAt), [1, 3]);
  assert.equal(client.state.status, 'closed'); assert.equal(second.calls[0].closed, 1);
});

test('closing during a state notification does not start a new transport', () => {
  const client = createOfficeClient(), adapter = source();
  client.subscribeState(state => { if (state.status === 'connecting') client.close(); });
  client.connect(adapter); assert.equal(adapter.calls.length, 0);
  assert.equal(client.state.status, 'closed');
});

test('a source switched synchronously from subscribe cleans the old subscription', () => {
  const client = createOfficeClient(), replacement = source('browser-log'); let closed = 0;
  client.connect({ source: 'local-http', subscribe() { client.connect(replacement); return () => closed++; } });
  assert.equal(closed, 1); assert.equal(client.state.source, 'browser-log');
  client.close();
});
