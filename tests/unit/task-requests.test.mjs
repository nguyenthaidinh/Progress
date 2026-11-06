import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTaskRequests, taskFingerprint } from '../../server/task-requests.mjs';

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-receipts-'));
  t.after(() => { if (path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store: createTaskRequests(dir, options), id: crypto.randomUUID(), fingerprint: taskFingerprint('start', { dir: '/project', text: 'private prompt', images: ['private image'] }) };
}
test('Concurrent retries execute once; restart replays only a receipt without persisting prompt data', async (t) => {
  const f = fixture(t); let calls = 0, release;
  const gate = new Promise((r) => { release = r; });
  const execute = async () => { calls++; await gate; return [200, { ok: true, task: { id: 'run-1', sid: 'thread-1', text: 'private prompt', dir: '/private/path', at: 1 } }]; };
  const a = f.store.run(f.id, f.fingerprint, execute), b = f.store.run(f.id, f.fingerprint, execute);
  assert.equal(f.store.get(f.id)[1].state, 'pending'); release();
  assert.deepEqual(await a, await b); assert.equal(calls, 1);
  const saved = fs.readFileSync(path.join(f.dir, 'task-requests.json'), 'utf8');
  assert.doesNotMatch(saved, /private prompt|private image|private\/path/);
  const restarted = createTaskRequests(f.dir);
  assert.equal((await restarted.run(f.id, f.fingerprint, () => { throw new Error('Must not replay'); }))[1].task.id, 'run-1');
  assert.equal(restarted.get(f.id)[1].state, 'done');
});
test('A reused ID with different content or operation is rejected', async (t) => {
  const f = fixture(t); await f.store.run(f.id, f.fingerprint, async () => [200, { ok: true }]);
  assert.equal((await f.store.run(f.id, taskFingerprint('steer', { text: 'other' }), () => assert.fail('replayed')))[1].code, 'requestConflict');
});
test('A crash after reservation leaves an uncertain receipt and never replays', async (t) => {
  const f = fixture(t); let release;
  const work = f.store.run(f.id, f.fingerprint, () => new Promise((r) => { release = r; }));
  const restarted = createTaskRequests(f.dir);
  assert.equal(restarted.get(f.id)[1].state, 'uncertain');
  assert.equal((await restarted.run(f.id, f.fingerprint, () => assert.fail('replayed')))[1].code, 'requestUncertain');
  release([200, { ok: true }]); await work;
});
test('Transport exceptions and ambiguous Codex errors remain uncertain', async (t) => {
  const f = fixture(t);
  assert.equal((await f.store.run(f.id, f.fingerprint, () => { throw new Error('lost reply'); }))[1].code, 'requestUncertain');
  const id = crypto.randomUUID();
  assert.equal((await f.store.run(id, f.fingerprint, async () => [409, { ok: false, code: 'codex' }]))[1].code, 'requestUncertain');
  assert.equal((await createTaskRequests(f.dir).run(id, f.fingerprint, () => assert.fail('replayed')))[1].code, 'requestUncertain');
});
test('Corrupt or unwritable state fails closed before executing', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'task-requests.json'), '{broken');
  const corrupt = createTaskRequests(f.dir);
  assert.equal((await corrupt.run(f.id, f.fingerprint, () => assert.fail('executed')))[0], 503);
  fs.rmSync(path.join(f.dir, 'task-requests.json'));
  fs.mkdirSync(path.join(f.dir, 'task-requests.json'));
  assert.equal((await f.store.run(f.id, f.fingerprint, () => assert.fail('executed')))[1].code, 'requestStore');
});
test('Capacity never evicts an existing receipt; invalid identifiers are rejected', async (t) => {
  const f = fixture(t, { max: 1 });
  assert.equal((await f.store.run('../bad', f.fingerprint, () => assert.fail('executed')))[0], 400);
  await f.store.run(f.id, f.fingerprint, async () => [200, { ok: true }]);
  assert.equal((await f.store.run(crypto.randomUUID(), f.fingerprint, () => assert.fail('executed')))[1].code, 'requestCapacity');
  assert.equal((await f.store.run(f.id, f.fingerprint, () => assert.fail('replayed')))[1].ok, true);
});
