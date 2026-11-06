import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../../server/workspace.mjs';
import { taskFingerprint, createTaskRequests } from '../../server/task-requests.mjs';
import crypto from 'node:crypto';

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lioops-workspace-')), workspace = createWorkspace(dir, options);
  t.after(() => { workspace.close(); if (path.dirname(dir) === os.tmpdir()) fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, workspace };
}
const start = (w, extra = {}) => w.begin({ agent: 'codex', dir: process.cwd(), text: 'Check this project', ...extra });

test('AI history groups real turns into one conversation, keeps provider and redacts secrets', (t) => {
  const { dir, workspace: w } = fixture(t);
  const first = start(w, { text: 'Fix sk-proj-0123456789abcdefghijklmnopqrstuvwxyz0123456789' });
  w.started(first, { id: 'task-1', sid: 'owned-thread' }); w.step(first, 'Run tests', 'owned-thread'); w.note('task-1', 'Check all tests');
  w.finish(first, { id: 'task-1', sid: 'owned-thread', result: '**Passed**' });
  const next = start(w, { conversationId: first.conversationId, text: 'Continue here' });
  w.started(next, { id: 'task-2', sid: 'owned-thread' }); w.finish(next, { result: 'Done' });
  const c = w.snapshot(first.conversationId).conversation;
  assert.equal(c.agent, 'codex'); assert.equal(c.sid, 'owned-thread'); assert.equal(c.turns.length, 2);
  assert.equal(c.turns[0].notes[0].text, 'Check all tests'); assert.equal(c.turns[0].result, '**Passed**');
  assert.equal(c.turns[1].prompt, 'Continue here'); assert.equal(c.turns[0].n, 1);
  assert.ok(!fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8').includes('sk-proj-0123456789'));
  assert.equal(w.snapshot().conversations.length, 1); assert.equal(w.hasSid('owned-thread'), true);
});

test('active work cannot overlap and interrupted history never silently restarts', (t) => {
  const { dir, workspace: w } = fixture(t), scope = start(w);
  w.started(scope, { id: 'task-running', sid: 'thread-running' });
  assert.throws(() => start(w, { conversationId: scope.conversationId }), /busy/);
  w.close(); const reopened = createWorkspace(dir);
  assert.equal(reopened.snapshot(scope.conversationId).conversation.turns[0].status, 'interrupted');
  assert.throws(() => start(reopened, { conversationId: scope.conversationId }), /workspaceInterrupted/);
  assert.equal(reopened.get(scope.conversationId).sid, 'thread-running'); reopened.close();
});

test('completion received before start acknowledgement is kept terminal', (t) => {
  const { workspace: w } = fixture(t), scope = start(w);
  w.finish(scope, { id: 'fast', sid: 'fast-thread', result: 'Already done' });
  w.started(scope, { id: 'fast', sid: 'fast-thread' });
  assert.equal(w.snapshot(scope.conversationId).conversation.turns[0].status, 'done');
  w.state(scope, 'wait'); assert.equal(w.snapshot(scope.conversationId).conversation.turns[0].status, 'done');
});

test('bounded history prunes old completed conversations and retains active work', (t) => {
  const { workspace: w } = fixture(t, { maxConversations: 2, maxTurns: 2 });
  const a = start(w); w.finish(a, { result: 'a' });
  const b = start(w, { agent: 'claude' });
  const c = start(w); assert.equal(w.get(a.conversationId), null); assert.ok(w.get(b.conversationId));
  assert.throws(() => start(w), /workspaceFull/);
  w.finish(c, { result: 'c' });
  for (let i = 0; i < 3; i++) { const s = start(w, { conversationId: c.conversationId, text: `Turn ${i}` }); w.finish(s, { result: 'done' }); }
  assert.equal(w.snapshot(c.conversationId).conversation.turns.length, 2);
});

test('stopped work stays stopped even when partial assistant text exists', (t) => {
  const { workspace: w } = fixture(t), scope = start(w);
  w.finish(scope, { stopped: true, result: 'I will inspect the files' });
  const turn = w.snapshot(scope.conversationId).conversation.turns[0]; assert.equal(turn.status, 'stopped'); assert.ok(turn.result);
});

test('corruption and write failures block new work and do not replace existing history', (t) => {
  const { dir, workspace: w } = fixture(t); w.close();
  const file = path.join(dir, 'workspace.json'); fs.writeFileSync(file, '{bad');
  const broken = createWorkspace(dir); assert.throws(() => start(broken), /workspaceStore/); broken.close();
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});

test('a failed atomic write reserves no conversation and preserves the previous snapshot', (t) => {
  const { dir, workspace: w } = fixture(t), scope = start(w); w.finish(scope, { result: 'Kept' });
  const file = path.join(dir, 'workspace.json'), before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.tmp-${process.pid}`);
  assert.throws(() => start(w), /workspaceStore/);
  assert.equal(w.snapshot().conversations.length, 1); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('workspace receipts retain only conversation IDs and keep legacy fingerprints compatible', async (t) => {
  const { dir } = fixture(t), receipts = createTaskRequests(dir), requestId = crypto.randomUUID(), conversationId = crypto.randomUUID();
  const body = { agent: 'codex', dir: process.cwd(), text: 'Never replay me' }, legacy = taskFingerprint('start', body);
  const previous = crypto.createHash('sha256').update(JSON.stringify({ operation: 'start', agent: body.agent, sid: '', dir: body.dir, task: '', text: body.text,
    images: [], fresh: false, model: '', effort: '' })).digest('hex');
  assert.equal(legacy, previous);
  assert.equal(taskFingerprint('start', { ...body, workspace: false }), legacy);
  assert.notEqual(taskFingerprint('start', { ...body, workspace: true }), legacy);
  let calls = 0;
  const result = () => { calls++; return [200, { ok: true, conversationId, task: { id: 'run', sid: 'thread', text: body.text } }]; };
  await receipts.run(requestId, legacy, result); const [, replay] = await receipts.run(requestId, legacy, result);
  assert.equal(replay.conversationId, conversationId); assert.equal(calls, 1);
  const saved = fs.readFileSync(path.join(dir, 'task-requests.json'), 'utf8'); assert.ok(!saved.includes(body.text)); assert.ok(!saved.includes(process.cwd()));
});
