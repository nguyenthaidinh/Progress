#!/usr/bin/env node
// Opt-in acceptance checks against the real Codex CLI. Uses existing CLI login and model quota.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodex } from '../server/providers/codex.mjs';
import { createCodexRpc, findCodex } from '../server/providers/codex-rpc.mjs';
import { fixtureCommands } from './lib/codex-fixture-commands.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
if (!process.argv.includes('--run')) {
  console.log('Live checks run model requests using your Codex CLI login and quota. To run: npm run test:codex:live -- --run');
  process.exit(0);
}
const selected = process.argv.find((x) => x.startsWith('--scenario='))?.slice(11) || 'all';
assert.ok(['all', 'repair', 'approvals', 'controls'].includes(selected), 'Supported scenarios: all, repair, approvals, controls');
// Keep live evidence outside Playwright's output directory, which Playwright clears on startup.
fs.mkdirSync(path.join(ROOT, 'test-results-codex-live'), { recursive: true });
const runRoot = fs.mkdtempSync(path.join(ROOT, 'test-results-codex-live', 'run-'));
const dir = path.join(runRoot, 'project'), dataDir = path.join(runRoot, 'state');
fs.mkdirSync(dir);
const fixture = new URL('../tests/fixtures/codex/project/', import.meta.url);
for (const name of ['calculator.cjs', 'checks.cjs']) fs.copyFileSync(new URL(`${name}.txt`, fixture), path.join(dir, name));
let expectedChecks = fs.readFileSync(path.join(dir, 'checks.cjs'), 'utf8');
const originalCalculator = fs.readFileSync(path.join(dir, 'calculator.cjs'), 'utf8');
fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Work only in this disposable sample project. Do not use network, install dependencies, delegate to agents, or inspect unrelated paths. Use node built-ins. Do not change checks.cjs.\n');
const report = { startedAt: new Date().toISOString(), runtime: findCodex()?.version, scenarios: [], events: [] };
const reportFile = path.join(runRoot, 'report.json');
const completed = new Map(), sessions = new Map(), requests = [], calls = [];
let adapter, transport, child, approvalError, phase = '', approvalPolicy = () => 'deny';
const key = `codex-live:${crypto.randomUUID()}`;
const continuity = crypto.randomBytes(8).toString('hex');
const markerScript = "const fs = require('node:fs'); const path = require('node:path'); const mode = process.argv[2]; if (!['allow', 'deny'].includes(mode)) throw Error('Unexpected mode'); fs.appendFileSync(path.join(__dirname, '..', 'markers', mode + '.txt'), 'once\\n');\n";
function safeMarkerApproval(a) {
  const p = requests.findLast((x) => x.id === a.requestId)?.params;
  if (a.type !== 'bash' || !p?.cwd || path.resolve(p.cwd).toLowerCase() !== path.resolve(dir).toLowerCase()) return 'deny';
  if (fs.readFileSync(path.join(dir, 'approval.cjs'), 'utf8') !== markerScript) return 'deny';
  const cmd = String(p.command).replace(/\\+/g, '\\');
  return fixtureCommands('allow').includes(cmd) ? 'allow' : 'deny';
}
function save() { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); }
function record(kind, data = {}) {
  const event = { at: new Date().toISOString(), phase, kind, ...data };
  report.events.push(event); save();
  console.log(JSON.stringify(event));
}
function create() {
  adapter = createCodex({ dataDir, enabled: true,
    rpcFactory: (handlers) => {
      transport = createCodexRpc({ ...handlers,
        spawnProcess: (file, args, options) => (child = spawn(file, args, { ...options, cwd: dir })),
        onNotification(msg) {
          if (msg.method === 'turn/completed') record('terminal', { status: msg.params.turn.status });
          return handlers.onNotification(msg);
        },
        onRequest(msg) { requests.push(msg); record('request', { method: msg.method, available: msg.params?.availableDecisions }); return handlers.onRequest(msg); },
      });
      return { ...transport, call: async (method, params) => {
        calls.push({ method, threadId: params?.threadId });
        const response = await transport.call(method, params);
        if (/^thread\/(start|resume|fork)$/.test(method)) report.model = response.model;
        return response;
      } };
    },
    onSession(s) { sessions.set(s.sid, s); },
    onEvent(sid, e) { record('activity', { sid, type: e.type, label: e.label }); },
    onApproval(a) {
      const choice = approvalPolicy(a);
      record('approval', { type: a.type, choice, detail: a.detail });
      // Only the exact disposable fixture operations selected by a scenario may be allowed.
      queueMicrotask(() => {
        if (!adapter.answer(a.id, choice)) approvalError = new Error(`Could not answer ${a.type} approval with ${choice}`);
      });
    },
    onDone(t) { completed.set(t.id, t); record('done', { id: t.id, error: t.error, stopped: t.stopped }); },
  });
}
async function until(predicate, description, timeout = 240_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (approvalError) throw approvalError; const value = predicate(); if (value) return value; await delay(200); }
  throw new Error(`Timed out: ${description}`);
}
async function begin(text, options = {}) {
  const r = await adapter.start({ dir, text, conversationKey: key, ...options });
  assert.equal(r.ok, true, r.message || r.code);
  return r.task;
}
async function done(task) {
  const result = await until(() => completed.get(task.id), 'turn completion');
  assert.equal(result.error, ''); assert.equal(result.stopped, false);
  return result;
}
function checkProject(expectSuccess = true) {
  assert.equal(fs.readFileSync(path.join(dir, 'checks.cjs'), 'utf8'), expectedChecks, 'Codex changed the acceptance tests');
  const result = spawnSync(process.execPath, ['--test', 'checks.cjs'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status === 0, expectSuccess, result.stdout + result.stderr);
  return result.stdout;
}
async function scenario(name, run) {
  if (selected === 'repair' && name !== 'repair') return;
  if (selected === 'approvals' && !name.startsWith('approval-')) return;
  if (selected === 'controls' && !['steer', 'steer-and-stop', 'disconnect'].includes(name)) return;
  phase = name; const start = Date.now(); record('begin');
  try { const details = await run(); report.scenarios.push({ name, ok: true, ms: Date.now() - start, ...details }); record('pass'); }
  catch (error) { report.scenarios.push({ name, ok: false, ms: Date.now() - start, error: error.message }); record('fail', { error: error.message }); throw error; }
}

try {
  console.log(`Live fixture: ${runRoot}`);
  create();
  await scenario('repair', async () => {
    checkProject(false);
    const task = await begin(`Fix the quantity bug in calculator.cjs. Read and run node --test checks.cjs, edit calculator.cjs only, and run tests again. No network/dependencies/delegation. Keep this conversation code in memory for a later turn, do not write it to a file: ${continuity}. Finish with a concise report.`);
    await done(task); checkProject();
    assert.notEqual(fs.readFileSync(path.join(dir, 'calculator.cjs'), 'utf8'), originalCalculator);
    // Codex may edit through a shell command instead of the dedicated fileChange tool.
    assert.ok((await adapter.log(task.sid)).some((x) => x.role === 'tool'));
    return { sid: task.sid, tests: 3 };
  });
  await scenario('followup', async () => {
    // This scenario depends on the repaired fixture from the preceding turn.
    fs.appendFileSync(path.join(dir, 'checks.cjs'), "\ntest('discount', () => assert.equal(total([{ price: 10, quantity: 2 }], 25), 15));\n");
    expectedChecks = fs.readFileSync(path.join(dir, 'checks.cjs'), 'utf8');
    checkProject(false);
    const task = await begin('Extend total(items, discountPercent = 0) to apply the percentage discount after summing quantities. Keep the no-discount behavior. Only edit calculator.cjs, run node --test checks.cjs and report. No network or delegation.');
    await done(task); checkProject();
    assert.ok(calls.some((x) => x.method === 'thread/resume' && x.threadId === task.sid));
    return { sid: task.sid, tests: 4 };
  });
  await scenario('restart', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-threads.json'), 'utf8')).owners[0].sid;
    adapter.close(); create();
    const task = await begin('Without opening any files or using tools, reply with only the conversation code I asked you to keep in memory in the first turn.');
    const result = await done(task);
    assert.equal(task.sid, before); assert.equal(result.result.trim(), continuity); checkProject();
    return { sid: task.sid, sameThread: true, contextRestored: true };
  });
  await scenario('approval-allow', async () => {
    fs.mkdirSync(path.join(runRoot, 'markers'));
    fs.writeFileSync(path.join(dir, 'approval.cjs'), markerScript);
    const before = requests.length;
    approvalPolicy = safeMarkerApproval;
    const task = await begin('This is an approval integration test. Use the shell tool to run exactly node approval.cjs allow with sandbox_permissions="require_escalated" and a justification asking approval for the disposable marker. This is intentionally outside normal sandbox execution. Do not change any files, use a different command, request broader permissions, or retry after denial. If escalation is unavailable, report that.', { fresh: true, conversationKey: `${key}:allow` });
    await done(task);
    assert.ok(requests.slice(before).some((x) => x.method === 'item/commandExecution/requestApproval'), 'No real command approval was requested');
    assert.equal(fs.readFileSync(path.join(runRoot, 'markers', 'allow.txt'), 'utf8'), 'once\n');
    approvalPolicy = () => 'deny';
    return { requested: true, executions: 1 };
  });
  await scenario('approval-deny', async () => {
    const before = requests.length;
    const task = await begin('This is an approval integration test. Use the shell tool to run exactly node approval.cjs deny with sandbox_permissions="require_escalated" and a justification asking approval for the disposable marker. Do not change files, use a different command, request broader permissions, or retry after denial. The approval will be denied; report that outcome.', { fresh: true, conversationKey: `${key}:deny` });
    const result = await until(() => completed.get(task.id), 'denial completed');
    assert.equal(result.error, '');
    assert.ok(requests.slice(before).some((x) => x.method === 'item/commandExecution/requestApproval'), 'No real command approval was requested');
    assert.equal(fs.existsSync(path.join(runRoot, 'markers', 'deny.txt')), false);
    return { requested: true, executions: 0, interrupted: result.stopped };
  });
  await scenario('steer', async () => {
    fs.writeFileSync(path.join(dir, 'steer.cjs'), "require('node:fs').writeFileSync('steer-started.flag', 'ready'); setTimeout(() => console.log('command finished'), 10000);\n");
    const task = await begin('Run exactly node steer.cjs with a command timeout of at least 20000ms. Wait for completion and reply ORIGINAL_REPLY. Do not edit files or run other commands.', { fresh: true, conversationKey: `${key}:steer` });
    await until(() => fs.existsSync(path.join(dir, 'steer-started.flag')), 'steering command started');
    assert.deepEqual(await adapter.steer({ task: task.id }, 'Change the final answer: after the command exits, reply exactly STEERING_RECEIVED and nothing else.'), { ok: true, how: 'now' });
    const result = await done(task);
    assert.equal(result.result.trim(), 'STEERING_RECEIVED');
    return { steerAccepted: true, modelFollowedSteering: true };
  });
  await scenario('steer-and-stop', async () => {
    fs.writeFileSync(path.join(dir, 'wait.cjs'), "const fs = require('node:fs'); fs.writeFileSync('started.flag', 'ready'); setTimeout(() => fs.writeFileSync('finished.flag', 'unexpected'), 40000);\n");
    const task = await begin('Run exactly node wait.cjs with a command timeout of at least 60000ms. Wait for it to finish, then give a brief report. Do not edit files or run other commands. No network or delegation.', { fresh: true, conversationKey: `${key}:stop` });
    await until(() => fs.existsSync(path.join(dir, 'started.flag')), 'real command started');
    const commandAt = Date.now();
    assert.deepEqual(await adapter.steer({ task: task.id }, 'After the command finishes, include STEERING_RECEIVED in your final reply.'), { ok: true, how: 'now' });
    assert.equal(await adapter.stop(task.id), true);
    const result = await until(() => completed.get(task.id), 'confirmed interrupt', 30_000);
    assert.equal(result.stopped, true); assert.equal(result.error, ''); assert.equal(adapter.has(task.id), false);
    record('checking-command-exit');
    const remaining = commandAt + 42_000 - Date.now();
    if (remaining > 0) await delay(remaining);
    assert.equal(fs.existsSync(path.join(dir, 'finished.flag')), false, 'Interrupted shell command continued running');
    return { steerAccepted: true, interruptConfirmed: true, commandTerminated: true };
  });
  await scenario('disconnect', async () => {
    const task = await begin('Without using tools, write a detailed explanation of merge sort in at least 2000 words. No files or commands.', { fresh: true, conversationKey: `${key}:disconnect` });
    const mutations = calls.filter((x) => x.method === 'turn/start').length;
    // Kill only the app-server process spawned by this harness, never a user-owned process.
    child.kill();
    const result = await until(() => completed.get(task.id), 'disconnect propagated', 15_000);
    assert.match(result.error, /disconnected/i); assert.equal(adapter.has(task.id), false);
    assert.equal(adapter.info().connected, false);
    // A subsequent explicit request opens a new connection; the lost turn must not be replayed.
    await adapter.refreshMetadata(true);
    assert.equal(calls.filter((x) => x.method === 'turn/start').length, mutations);
    return { taskFailed: true, replayed: false, reconnected: adapter.info().models.length > 0 };
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  // Archive only this fixture's completed threads, so test desks do not fill the user's office.
  if (adapter && !adapter.list().length) {
    try {
      const owners = JSON.parse(fs.readFileSync(path.join(dataDir, 'codex-threads.json'), 'utf8')).owners;
      report.archivedThreads = 0;
      for (const owner of owners) if (owner.dir === dir) {
        try { await transport.call('thread/archive', { threadId: owner.sid }); report.archivedThreads++; }
        catch { record('cleanup-warning', { message: 'Could not archive a fixture thread' }); }
      }
    } catch { /* A failed startup may not have created any ownership state. */ }
  }
  adapter?.close();
  report.finishedAt = new Date().toISOString(); save();
  console.log(`Report: ${reportFile}`);
}
