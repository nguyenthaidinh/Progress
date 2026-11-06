import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodex, codexItem, codexStatus, codexLimits } from '../../server/providers/codex.mjs';
import { createCodexRpc, findCodex } from '../../server/providers/codex-rpc.mjs';

const NOW = 1800000000000;
function fixture({ rows = [], turns = [], enabled = true, dataDir = null, override = null, usageReader = async () => null } = {}) {
  let handlers, next = 0;
  const calls = [], replies = [], rejected = [], sessions = [], events = [], approvals = [], done = [], resolved = [];
  const rpc = {
    async call(method, params) {
      calls.push({ method, params });
      if (override) { const value = await override(method, params); if (value !== undefined) return value; }
      if (method === 'thread/list') return { data: rows };
      if (method === 'thread/turns/list') return { data: turns };
      if (method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId, cwd: '/project', createdAt: NOW / 1000, updatedAt: NOW / 1000 } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/interrupt') return {};
      if (method === 'thread/backgroundTerminals/list') return { data: [], nextCursor: null };
      if (method === 'thread/backgroundTerminals/terminate') return { terminated: true };
      if (method === 'turn/steer') return { turnId: params.expectedTurnId };
      if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: 'Fixture model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] };
      if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: NOW / 1000 + 500 } } };
      return { thread: { id: `owned-${++next}`, cwd: '/project', createdAt: NOW / 1000, updatedAt: NOW / 1000 } };
    },
    reply(id, result) { replies.push({ id, result }); }, reject(id) { rejected.push(id); }, close() {},
  };
  const adapter = createCodex({ enabled, dataDir, usageReader, now: () => NOW, binary: () => ({ file: 'codex', args: [] }),
    rpcFactory: (opts) => { handlers = opts; return rpc; }, onSession: (s) => sessions.push(s),
    onEvent: (sid, e) => events.push({ sid, ...e }), onApproval: (a) => approvals.push(a),
    onResolved: (id) => resolved.push(id), onDone: (t) => done.push(t) });
  return { adapter, calls, replies, rejected, sessions, events, approvals, done, resolved,
    notify: (method, params) => handlers.onNotification({ method, params }),
    request: (id, method, params) => handlers.onRequest({ id, method, params }),
    disconnect: () => handlers.onDisconnect(new Error('disconnected')) };
}

test('Codex maps public items and masks secrets; unknown events are ignored', () => {
  assert.equal(codexItem({ type: 'commandExecution', command: 'npm test' }).type, 'bash');
  assert.equal(codexItem({ type: 'commandExecution', command: 'cat a.js', commandActions: [{ type: 'read', name: 'a.js' }] }).type, 'read');
  assert.equal(codexItem({ type: 'fileChange', changes: [{ path: '/p/app.js' }] }).label, 'app.js');
  assert.equal(codexItem({ type: 'reasoning', text: 'private' }), null);
  assert.ok(!codexItem({ type: 'agentMessage', text: 'api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789' }).text.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('Codex status distinguishes waiting and expires stale in-progress turns', () => {
  assert.equal(codexStatus({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } }, null, NOW), 'wait');
  assert.equal(codexStatus({ updatedAt: NOW / 1000 }, { status: 'inProgress' }, NOW), 'work');
  assert.equal(codexStatus({ updatedAt: (NOW - 3600_000) / 1000 }, { status: 'inProgress' }, NOW), 'rest');
});

test('Observed Codex sessions publish stored token counts without resuming or starting work', async () => {
  const usage = { model: 'fixture-model', ctx: 20000, ctxMax: 100000, in: 80000, out: 4000, at: NOW, cost: null };
  const f = fixture({ rows: [{ id: 'external', cwd: '/project', updatedAt: NOW / 1000 }], usageReader: async () => usage });
  await f.adapter.poll();
  assert.deepEqual(f.sessions.at(-1).usage, usage);
  assert.ok(!f.calls.some((x) => ['thread/resume', 'thread/fork', 'turn/start'].includes(x.method)));
});

test('Discovery reads history without resuming, filters stale/nested threads and never replays old activity', async () => {
  const rows = [{ id: 'external', cwd: '/project', updatedAt: NOW / 1000, source: 'vscode' },
    { id: 'old', updatedAt: (NOW - 3600_000) / 1000 }, { id: 'sub', updatedAt: NOW / 1000, source: { subAgent: {} } }];
  const turns = [{ status: 'completed', items: [{ id: 'c', type: 'commandExecution', command: 'npm test', status: 'completed' }] }];
  const f = fixture({ rows, turns }); await f.adapter.poll(); await f.adapter.poll();
  assert.equal(f.sessions.length, 2); assert.equal(f.sessions[0].observed, true);
  assert.equal(f.events.length, 0); assert.ok(!f.calls.some((x) => x.method === 'thread/resume'));
  turns[0].items.push({ id: 'edit', type: 'fileChange', changes: [{ path: '/project/a.js' }] });
  await f.adapter.poll(); await f.adapter.poll(); assert.equal(f.events.filter((x) => x.type === 'edit').length, 1);
});

test('Office forks external threads, keeps sandbox/approval policy, then resumes only its own threads', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Fix bug', sid: 'external' });
  assert.equal(r.ok, true); const fork = f.calls.find((x) => x.method === 'thread/fork');
  assert.equal(fork.params.threadId, 'external'); assert.equal(fork.params.sandbox, 'workspace-write'); assert.equal(fork.params.approvalPolicy, 'on-request');
  await f.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'turn-1', status: 'completed' } });
  await f.adapter.start({ dir: '/project', text: 'Continue', sid: r.task.sid });
  assert.ok(f.calls.some((x) => x.method === 'thread/resume' && x.params.threadId === r.task.sid));
});

test('Approvals are scoped to owned runs; allow once/deny only; file diffs are reviewable', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Fix' });
  f.request(7, 'item/commandExecution/requestApproval', { threadId: 'foreign', command: 'bad' });
  assert.deepEqual(f.rejected, [7]);
  await f.notify('item/started', { threadId: r.task.sid, item: { id: 'patch', type: 'fileChange', changes: [{ path: '/project/a', diff: '+hello' }] } });
  f.request(8, 'item/fileChange/requestApproval', { threadId: r.task.sid, itemId: 'patch' });
  assert.match(f.approvals[0].detail, /\+hello/);
  assert.equal(f.adapter.answer(f.approvals[0].id, 'always'), false);
  assert.equal(f.adapter.answer(f.approvals[0].id, 'allow'), true);
  assert.deepEqual(f.replies[0], { id: 8, result: { decision: 'accept' } });
  assert.equal(f.adapter.answer(f.approvals[0].id, 'allow'), false);
});

test('User input answers use Codex question IDs and reject incomplete answers', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Fix' });
  f.request('q', 'item/tool/requestUserInput', { threadId: r.task.sid, questions: [{ id: 'mode', question: 'Choose', options: [{ label: 'Yes' }] }] });
  const id = f.approvals[0].id;
  assert.equal(f.adapter.answer(id, 'answer', []), false);
  assert.equal(f.adapter.answer(id, 'answer', [{ q: 0, pick: [0] }]), true);
  assert.deepEqual(f.replies[0].result, { answers: { mode: { answers: ['Yes'] } } });
});

test('Deny uses cancel when Codex does not offer decline; persistent grants are never selected', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Approval' });
  f.request(20, 'item/commandExecution/requestApproval', { threadId: r.task.sid, availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node'] } }, 'cancel'] });
  assert.equal(f.adapter.answer(f.approvals[0].id, 'deny'), true);
  assert.deepEqual(f.replies[0], { id: 20, result: { decision: 'cancel' } });
  f.request(21, 'item/commandExecution/requestApproval', { threadId: r.task.sid, availableDecisions: ['acceptForSession', 'decline', 'cancel'] });
  assert.equal(f.adapter.answer(f.approvals[1].id, 'allow'), false);
  assert.equal(f.adapter.answer(f.approvals[1].id, 'always'), false);
  assert.equal(f.adapter.answer(f.approvals[1].id, 'deny'), true);
  assert.deepEqual(f.replies[1], { id: 21, result: { decision: 'decline' } });
});

test('Disconnect clears pending approvals and ends office tasks once', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Fix' });
  f.request(9, 'item/commandExecution/requestApproval', { threadId: r.task.sid, command: 'npm test' });
  f.disconnect(); f.disconnect();
  assert.equal(f.done.length, 1); assert.equal(f.resolved.length, 1); assert.equal(f.adapter.list().length, 0);
});

test('Late events and approval requests from an earlier turn cannot alter the active task', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Current work' });
  await f.notify('turn/started', { threadId: r.task.sid, turn: { id: 'previous-turn', status: 'inProgress' } });
  await f.notify('item/completed', { threadId: r.task.sid, turnId: 'previous-turn', item: { id: 'old-reply', type: 'agentMessage', text: 'Stale result' } });
  f.request(10, 'item/commandExecution/requestApproval', { threadId: r.task.sid, turnId: 'previous-turn', command: 'old command' });
  await f.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'previous-turn', status: 'completed' } });
  assert.equal(f.done.length, 0); assert.equal(f.approvals.length, 0); assert.deepEqual(f.rejected, [10]);
  assert.equal(f.adapter.resolveRun({ task: r.task.id }).turnId, 'turn-1');
  assert.equal(f.adapter.resolveRun({ task: r.task.id }).result, '');
  await f.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: 'Current result' }] } });
  assert.equal(f.done.length, 1); assert.equal(f.done[0].result, 'Current result');
});

test('Disabled adapter does not access Codex; running tasks can be interrupted', async () => {
  const off = fixture({ enabled: false }); await off.adapter.poll();
  assert.equal((await off.adapter.start({ dir: '/project', text: 'Fix' })).ok, false); assert.equal(off.calls.length, 0);
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Fix' });
  assert.equal(await f.adapter.stop(r.task.id), true); assert.equal(f.done.length, 0);
  assert.equal(f.adapter.stateOf(r.task.id).stopping, true);
  assert.equal(await f.adapter.stop(r.task.id), true);
  assert.equal(f.calls.filter((c) => c.method === 'turn/interrupt').length, 1);
  await f.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(f.done[0].stopped, true);
  assert.equal(await f.adapter.stop(r.task.id), false);
});

test('Stop terminates only this turn terminals and waits for terminal cleanup before completing', async () => {
  let release, lists = 0, f;
  const gate = new Promise((resolve) => { release = resolve; });
  const terminals = [{ itemId: 'previous-command', processId: 'keep-old' }, { itemId: 'current-command', processId: 'stop-current' }];
  f = fixture({ override: async (method, params) => {
    if (method === 'thread/backgroundTerminals/list') {
      if (++lists === 2) await gate;
      return { data: [...terminals], nextCursor: null };
    }
    if (method === 'thread/backgroundTerminals/terminate') {
      terminals.splice(terminals.findIndex((t) => t.processId === params.processId), 1);
      return { terminated: true };
    }
    if (method === 'turn/interrupt') {
      await f.notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
      return {};
    }
  } });
  const r = await f.adapter.start({ dir: '/project', text: 'Run a command' });
  await f.notify('item/started', { threadId: r.task.sid, turnId: 'turn-1', item: { id: 'current-command', type: 'commandExecution', command: 'node wait.cjs', status: 'inProgress' } });
  const stopping = f.adapter.stop(r.task.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.done.length, 0); assert.equal(f.adapter.stateOf(r.task.id).stopping, true);
  release(); assert.equal(await stopping, true);
  assert.deepEqual(f.calls.filter((c) => c.method === 'thread/backgroundTerminals/terminate').map((c) => c.params), [{ threadId: r.task.sid, processId: 'stop-current' }]);
  assert.deepEqual(terminals, [{ itemId: 'previous-command', processId: 'keep-old' }]);
  assert.equal(f.done.length, 1); assert.equal(f.done[0].stopped, true); assert.equal(f.done[0].error, '');
});

test('An interrupted turn is reported as failed when command termination cannot be confirmed', async () => {
  let f;
  f = fixture({ override: async (method, params) => {
    if (method === 'thread/backgroundTerminals/list') throw new Error('Terminal control unavailable');
    if (method === 'turn/interrupt') {
      await f.notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
      return {};
    }
  } });
  const r = await f.adapter.start({ dir: '/project', text: 'Run' });
  assert.equal(await f.adapter.stop(r.task.id), true);
  assert.equal(f.done.length, 1); assert.equal(f.done[0].stopped, false);
  assert.match(f.done[0].error, /Could not confirm Codex commands stopped/);
});

test('Stop tolerates a terminal exiting naturally between listing and termination', async () => {
  let present = true, f;
  f = fixture({ override: async (method, params) => {
    if (method === 'thread/backgroundTerminals/list') return { data: present ? [{ itemId: 'short-command', processId: 'already-exiting' }] : [] };
    if (method === 'thread/backgroundTerminals/terminate') { present = false; return { terminated: false }; }
    if (method === 'turn/interrupt') { await f.notify('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); return {}; }
  } });
  const r = await f.adapter.start({ dir: '/project', text: 'Short command' });
  await f.notify('item/started', { threadId: r.task.sid, turnId: 'turn-1', item: { id: 'short-command', type: 'commandExecution', command: 'node short.cjs' } });
  assert.equal(await f.adapter.stop(r.task.id), true);
  assert.equal(f.done.length, 1); assert.equal(f.done[0].stopped, true); assert.equal(f.done[0].error, '');
});

test('App-server transport handles split JSON, concurrent responses and peer requests without a shell', async () => {
  const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => {};
  const sent = [], requests = []; let buf = '', options;
  proc.stdin.on('data', (chunk) => {
    buf += chunk; let end;
    while ((end = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, end)); buf = buf.slice(end + 1); sent.push(msg);
      if (msg.method === 'initialize') queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n'));
      else if (msg.method === 'test') { const line = JSON.stringify({ id: msg.id, result: msg.params }); proc.stdout.write(line.slice(0, 5)); proc.stdout.write(line.slice(5) + '\n'); }
    }
  });
  const rpc = createCodexRpc({ binary: () => ({ file: 'codex', args: [] }), spawnProcess: (_file, _args, opts) => { options = opts; return proc; }, onRequest: (msg) => requests.push(msg), timeout: 1000 });
  assert.deepEqual(await Promise.all([rpc.call('test', { n: 1 }), rpc.call('test', { n: 2 })]), [{ n: 1 }, { n: 2 }]);
  proc.stdout.write(JSON.stringify({ id: 1, method: 'approval', params: {} }) + '\n');
  await new Promise((r) => setImmediate(r)); assert.equal(requests.length, 1);
  assert.equal(options.shell, undefined); assert.equal(sent.filter((m) => m.method === 'initialize').length, 1);
  rpc.close();
});

test('Continuation ownership survives restart, stays in the same project, and stores no prompt', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-codex-state-'));
  try {
    const first = fixture({ dataDir });
    const r = await first.adapter.start({ dir: '/project', sid: 'external', text: 'SECRET PROMPT' });
    await first.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'turn-1', status: 'completed' } });
    first.adapter.close();
    const saved = fs.readFileSync(path.join(dataDir, 'codex-threads.json'), 'utf8');
    assert.ok(!saved.includes('SECRET PROMPT'));
    const next = fixture({ dataDir });
    const resumed = await next.adapter.start({ dir: '/project', sid: 'external', text: 'Continue' });
    assert.equal(resumed.task.sid, r.task.sid);
    assert.ok(next.calls.some((x) => x.method === 'thread/resume' && x.params.threadId === r.task.sid));
    assert.ok(!next.calls.some((x) => x.method === 'thread/fork'));
    const moved = fixture({ dataDir, override: (method, params) => method === 'thread/read' ? { thread: { id: params.threadId, cwd: '/other-project' } } : undefined });
    assert.equal((await moved.adapter.start({ dir: '/project', sid: 'external', text: 'Continue' })).ok, false);
    assert.ok(!moved.calls.some((x) => x.method === 'turn/start'));
  } finally {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Restart never resumes a thread whose previous turn is still unconfirmed', async () => {
  const turns = [], f = fixture({ turns }); const r = await f.adapter.start({ dir: '/project', sid: 'external', text: 'Start' });
  await f.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'turn-1', status: 'completed' } });
  // Persisted state may still report an active turn even when our UI saw a terminal event.
  turns.push({ id: 'turn-from-another-client', status: 'inProgress', items: [] });
  const callCount = f.calls.length;
  const r2 = await f.adapter.start({ dir: '/project', sid: 'external', text: 'Continue' });
  assert.equal(r2.ok, false); assert.equal(r2.code, 'busy');
  assert.ok(!f.calls.slice(callCount).some((c) => ['thread/resume', 'turn/start'].includes(c.method)));
});

test('Steering targets only the owned active turn and uses the expected turn ID', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', sid: 'external', text: 'Start' });
  assert.equal((await f.adapter.steer({ sid: 'external' }, 'Focus on tests')).ok, false); // external hasn't been observed with a project
  assert.equal((await f.adapter.steer({ task: r.task.id }, 'Focus on tests')).ok, true);
  const sent = f.calls.find((x) => x.method === 'turn/steer');
  assert.equal(sent.params.threadId, r.task.sid); assert.equal(sent.params.expectedTurnId, 'turn-1');
  assert.deepEqual(sent.params.input, [{ type: 'text', text: 'Focus on tests' }]);
  await f.adapter.stop(r.task.id);
  assert.equal((await f.adapter.steer({ task: r.task.id }, 'Too late')).ok, false);
  await f.notify('turn/completed', { threadId: r.task.sid, turn: { id: 'turn-1', status: 'interrupted' } });
});

test('A poll reconciles a missed completion and keeps the final answer', async () => {
  const rows = [], turns = [], f = fixture({ rows, turns });
  const r = await f.adapter.start({ dir: '/project', text: 'Start' });
  rows.push({ id: r.task.sid, cwd: '/project', updatedAt: NOW / 1000 });
  turns.push({ id: 'turn-1', status: 'completed', items: [{ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Recovered final answer' }] });
  await f.adapter.poll(); await f.adapter.poll();
  assert.equal(f.done.length, 1); assert.equal(f.done[0].result, 'Recovered final answer');
  assert.equal(f.adapter.list().length, 0);
});

test('Model/effort must come from the catalog; quota is real, bounded data with no auth fields', async () => {
  const f = fixture(); await f.adapter.refreshMetadata();
  assert.equal(f.adapter.info().models[0].id, 'fixture-model');
  assert.equal(f.adapter.info().limits.buckets[0].windows[0].pct, 25);
  assert.equal((await f.adapter.start({ dir: '/project', text: 'Start', model: 'invented' })).ok, false);
  assert.equal((await f.adapter.start({ dir: '/project', text: 'Start', model: 'fixture-model', effort: 'ultra' })).ok, false);
  const r = await f.adapter.start({ dir: '/project', text: 'Start', model: 'fixture-model', effort: 'high' });
  assert.equal(r.ok, true); const request = f.calls.find((x) => x.method === 'turn/start');
  assert.equal(request.params.model, 'fixture-model'); assert.equal(request.params.effort, 'high');
  const data = codexLimits({ rateLimits: { limitId: 'codex', accessToken: 'SECRET', primary: { usedPercent: 150, resetsAt: NOW / 1000 } } }, NOW);
  assert.equal(data.buckets[0].windows[0].pct, 100); assert.ok(!JSON.stringify(data).includes('SECRET'));
});

test('Malformed question submissions do not throw, and secret answers use password fields', async () => {
  const f = fixture(); const r = await f.adapter.start({ dir: '/project', text: 'Start' });
  f.request('q', 'item/tool/requestUserInput', { threadId: r.task.sid, questions: [{ id: '__proto__', question: 'Secret?', isSecret: true }] });
  const id = f.approvals[0].id; assert.equal(f.approvals[0].questions[0].secret, true);
  assert.equal(f.adapter.answer(id, 'answer', {}), false);
  assert.equal(f.adapter.answer(id, 'answer', [{ q: 0, other: 'private answer' }]), true);
  assert.ok(Object.hasOwn(f.replies[0].result.answers, '__proto__'));
});

function peer(onMessage) {
  const p = new EventEmitter(); p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed = 0; p.kill = () => { p.killed++; };
  let buffer = '';
  p.send = (m) => p.stdout.write(JSON.stringify(m) + '\n');
  p.stdin.on('data', (chunk) => {
    buffer += chunk; let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (m.method === 'initialize') queueMicrotask(() => p.send({ id: m.id, result: {} }));
      else if (m.method) onMessage(m, p);
    }
  });
  return p;
}

test('Transport preserves multibyte UTF-8 split across arbitrary chunks', async () => {
  const expected = 'Tiếng Việt · 🇻🇳';
  const p = peer((m, proc) => {
    if (m.method === 'read') { const bytes = Buffer.from(JSON.stringify({ id: m.id, result: { text: expected } }) + '\n'); for (let i = 0; i < bytes.length; i++) proc.stdout.write(bytes.subarray(i, i + 1)); }
  });
  const rpc = createCodexRpc({ binary: () => ({ file: 'fixture' }), spawnProcess: () => p });
  try { assert.deepEqual(await rpc.call('read'), { text: expected }); } finally { rpc.close(); }
});

test('Oversized complete frames disconnect once; old process output cannot alter a new connection', async () => {
  const p1 = peer((m, proc) => { if (m.method === 'read') proc.stdout.write(JSON.stringify({ id: m.id, result: 'x'.repeat(2000) }) + '\n'); });
  const p2 = peer((m, proc) => { if (m.method === 'read') proc.send({ id: m.id, result: 'fresh' }); });
  const notifications = []; let spawned = 0, disconnected = 0;
  const rpc = createCodexRpc({ binary: () => ({ file: 'fixture' }), spawnProcess: () => ++spawned === 1 ? p1 : p2,
    maxMessageBytes: 1000, onNotification: (m) => notifications.push(m), onDisconnect: () => disconnected++ });
  try {
    await assert.rejects(rpc.call('read'), /size limit/); assert.equal(disconnected, 1);
    assert.equal(await rpc.call('read'), 'fresh');
    p1.send({ method: 'turn/completed', params: {} }); p1.emit('exit');
    await new Promise((r) => setImmediate(r)); assert.equal(notifications.length, 0); assert.equal(disconnected, 1);
  } finally { rpc.close(); }
});

test('Timed-out mutations are never replayed; a read timeout leaves active work connected', async () => {
  let mutations = 0;
  const p = peer((m, proc) => { if (m.method === 'turn/start') mutations++; if (m.method === 'ready') proc.send({ id: m.id, result: true }); });
  const rpc = createCodexRpc({ binary: () => ({ file: 'fixture' }), spawnProcess: () => p, timeout: 25 });
  try {
    await assert.rejects(rpc.call('thread/list'), /timeout/); assert.equal(p.killed, 0);
    assert.equal(await rpc.call('ready'), true);
    await assert.rejects(rpc.call('turn/start', {}), /timeout/); assert.equal(p.killed, 1); assert.equal(mutations, 1);
  } finally { rpc.close(); }
});

test('The repo CLI is preferred and an explicit invalid override never silently falls back', () => {
  const local = findCodex({ PATH: '' });
  assert.equal(local.source, 'project'); assert.match(local.version, /^\d+\.\d+\.\d+/);
  const file = path.resolve('tests/fixtures/codex/fake-app-server.mjs');
  const override = findCodex({ OFFICE_CODEX_BIN: file, PATH: '' });
  assert.equal(override.source, 'override'); assert.deepEqual(override.args, [file]);
  assert.equal(findCodex({ OFFICE_CODEX_BIN: path.resolve('does-not-exist-codex.exe'), PATH: '' }), null);
});

test('Thread initialization gets a separate timeout budget without replaying work', async () => {
  const p = peer((m, proc) => { if (m.method === 'thread/start') setTimeout(() => proc.send({ id: m.id, result: { thread: { id: 'ready' } } }), 30); });
  const rpc = createCodexRpc({ binary: () => ({ file: 'fixture' }), spawnProcess: () => p, timeout: 10, startupTimeout: 100 });
  try { assert.equal((await rpc.call('thread/start')).thread.id, 'ready'); assert.equal(p.killed, 0); } finally { rpc.close(); }
});
