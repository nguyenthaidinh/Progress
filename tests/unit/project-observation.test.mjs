import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { selectProjects } from '../../connector/scope.mjs';
import { createProjectObserver } from '../../connector/project-observer.mjs';
import { createMetricsReader } from '../../connector/metrics.mjs';
import { createConnector } from '../../connector/core.mjs';
import { createControl } from '../../connector/control.mjs';
import { createRelay } from '../../relay/server.mjs';
import { createBrowserPair, createEncryptedRelaySource } from '../../src/office/data/encrypted-relay.js';
import { createOfficeClient } from '../../src/office/data/client.js';
import { randomSecret, seal, open, createIdentity, importIdentity } from '../../src/shared/remote/crypto.js';
import { publicDObservation } from '../../src/shared/remote/observation-v2.js';
import { relayTransport } from '../../src/shared/remote/transport.js';
import { boundObservation, OBSERVATION_BYTES } from '../../connector/observation-budget.mjs';
import { createObservationCache } from '../../src/office/data/observation-cache.js';
const grants = { content: true, accountQuota: true, systemMetrics: false };
const wait = async fn => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 12000) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lioops-observe-d-')), cleanups = [];
  t.after(async () => {
    for (const close of cleanups.reverse()) await close();
    const root = await fs.realpath(os.tmpdir()), target = await fs.realpath(dir);
    assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('lioops-observe-d-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const a = path.join(dir, 'alpha-project'), b = path.join(dir, 'beta-project'), codex = path.join(dir, 'codex'), claude = path.join(dir, 'claude');
  for (const folder of [a, b, codex, claude]) await fs.mkdir(folder);
  const logs = [{ provider: 'codex', path: codex }, { provider: 'claude', path: claude }];
  async function codexLog(name, cwd, message, at = Date.now()) {
    const timestamp = new Date(at).toISOString(), file = path.join(codex, name);
    await fs.writeFile(file, [
      { type: 'session_meta', timestamp, payload: { id: name, cwd } },
      { type: 'turn_context', timestamp, payload: { cwd, model: 'fixture-codex' } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message } },
      { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: 'src/index.ts' }) } },
      { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: `${message}-ANSWER` } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 800, output_tokens: 200 }, last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 },
        rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3600 } } } },
    ].map(JSON.stringify).join('\n') + '\n'); return file;
  }
  async function claudeLog(name, cwd, message, at = Date.now()) {
    const timestamp = new Date(at).toISOString(), file = path.join(claude, name);
    await fs.writeFile(file, [
      { type: 'user', sessionId: name, cwd, timestamp, message: { content: [{ type: 'text', text: message }] } },
      { type: 'assistant', sessionId: name, cwd, timestamp, message: { id: name, model: 'fixture-claude', stop_reason: 'end_turn', content: [{ type: 'text', text: `${message}-ANSWER` }], usage: { input_tokens: 40, output_tokens: 10 } } },
    ].map(JSON.stringify).join('\n') + '\n'); return file;
  }
  return { dir, a, b, codex, claude, logs, codexLog, claudeLog, cleanups,
    async observer(projects = [a], permissions = grants) {
      const selection = await selectProjects({ projects, logs, permissions }), scopeId = randomSecret(), observer = createProjectObserver({ selection, key: randomSecret(), scopeId });
      cleanups.push(() => observer.close()); return { selection, scopeId, observer };
    },
  };
}
const snapshot = rig => rig.observer.snapshot({ revision: 1, permissions: rig.selection.permissions });
function memoryStore() { let value; return { load: async () => value ? structuredClone(value) : null, save: async next => { value = structuredClone(next); } }; }
async function bridge(f, project, permissions = grants, relay, options = {}) {
  const { afterCoreSend, ...browserOptions } = options;
  if (!relay) {
    const adminToken = randomSecret(), instance = createRelay({ adminToken, origins: ['http://127.0.0.1:8000'], pollMs: 200 });
    await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
    f.cleanups.push(async () => { instance.server.closeAllConnections(); await new Promise(resolve => instance.server.close(resolve)); });
    relay = { adminToken, url: `http://127.0.0.1:${instance.server.address().port}` };
  }
  const selection = await selectProjects({ projects: [project], logs: f.logs, permissions }), store = memoryStore(), wire = [];
  const forward = (input, init) => { if (String(input).endsWith('/send')) wire.push(init.body); return fetch(input, init); };
  const core = await createConnector({ relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection, store,
    async fetch(input, init) { const response = await forward(input, init); if (String(input).endsWith('/send')) await afterCoreSend?.(); return response; }, intervalMs: 40 });
  await core.start(); f.cleanups.push(() => core.stop());
  const invite = JSON.parse(new URLSearchParams(new URL(core.inviteURL).hash.slice(1)).get('lioops-pair'));
  const record = await createBrowserPair(invite), client = createOfficeClient(); let latest;
  const adapter = createEncryptedRelaySource({ ...browserOptions, record, save: async () => {}, fetch: forward, onObservation: value => { latest = value; } });
  client.connect(adapter); f.cleanups.push(() => client.close()); await wait(() => core.state.pending);
  const pending = core.state.pending; await core.approve(pending.fingerprint, pending.epoch); await wait(() => client.state.status === 'connected');
  return { core, client, record, wire, store, relay, summary: () => latest };
}

test('D discovers Codex/Claude only in authorized projects, caches unchanged files and never publishes raw paths or credentials', async t => {
  const f = await fixture(t);
  await f.codexLog('a.jsonl', f.a, 'ALPHA-CODEX'); await f.claudeLog('a.jsonl', f.a, 'ALPHA-CLAUDE');
  await f.codexLog('b.jsonl', f.b, 'DO-NOT-SHARE-BETA'); await f.codexLog('auth.jsonl', f.a, 'DO-NOT-SHARE-CREDENTIALS');
  const rig = await f.observer(), first = publicDObservation(await snapshot(rig));
  assert.equal(first.sessions.length, 2); assert.ok(first.sessions.some(session => session.provider === 'codex'));
  assert.ok(first.sessions.some(session => session.provider === 'claude' && session.contextMax === null));
  assert.equal(first.quotas[0].windows[0].usedPct, 25); assert.equal(first.metrics, null);
  const serialized = JSON.stringify(first); for (const secret of [f.a, f.b, 'DO-NOT-SHARE', 'ALPHA-CODEX-ANSWER', 'ALPHA-CLAUDE-ANSWER']) assert.ok(!serialized.includes(secret));
  const count = rig.observer.diagnostics.parses; await snapshot(rig); assert.equal(rig.observer.diagnostics.parses, count); assert.ok(rig.observer.diagnostics.cacheHits >= 2);
});

test('D discovers new files and updates selected logs, preserves unknown state, and drops deleted or out-of-scope replacements', async t => {
  const f = await fixture(t), file = await f.codexLog('a.jsonl', f.a, 'ALPHA', Date.now() - 600000), rig = await f.observer();
  const first = await snapshot(rig); assert.equal(first.sessions[0].status, 'unknown');
  const id = first.sessions[0].id, requestId = randomSecret();
  const detail = await rig.observer.snapshot({ revision: 1, permissions: grants, detail: { id, requestId } });
  assert.equal(detail.details.messages[0].text, 'ALPHA'); publicDObservation(detail);
  await f.claudeLog('new.jsonl', f.a, 'NEW-SESSION'); await wait(() => true);
  let next; for (let i = 0; i < 3; i++) { next = await snapshot(rig); if (next.sessions.length === 2) break; }
  assert.equal(next.sessions.length, 2);
  await f.codexLog('a.jsonl', f.b, 'BETA-REPLACED'); const replaced = await snapshot(rig); assert.ok(!replaced.sessions.some(session => session.id === id));
  await fs.rm(file); assert.equal((await snapshot(rig)).sessions.length, 1);
});

test('project, provider-root and junction replacement fails closed and clears the previous catalog', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'ALPHA'); const rig = await f.observer(); assert.equal((await snapshot(rig)).sessions.length, 1);
  const link = path.join(f.dir, 'alias'); await fs.symlink(f.a, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(selectProjects({ projects: [link], logs: f.logs }));
  await fs.rename(f.a, path.join(f.dir, 'old-project')); await fs.mkdir(f.a);
  const next = await snapshot(rig); assert.equal(next.availability, 'unavailable'); assert.equal(next.sessions.length, 0); assert.equal(next.details, null);
});

test('D metrics are opt-in, first CPU sample is unknown and sleep/counter resets cannot become invented zero usage', async t => {
  let tick = 0, clock = 1000;
  const reader = createMetricsReader({ cpus: () => [{ times: { idle: 50 + tick, user: 50 + tick * 3, sys: 0, nice: 0, irq: 0 } }], totalmem: () => 1000, freemem: () => 250, now: () => clock });
  assert.equal(reader().cpuPct, null); tick = 10; clock += 1000; assert.equal(reader().cpuPct, 75);
  clock += 60000; tick = 20; assert.equal(reader().cpuPct, null); assert.deepEqual(reader().memory, { total: 1000, free: 250, used: 750 });
  const f = await fixture(t), selection = await selectProjects({ projects: [f.a], logs: f.logs }); let calls = 0;
  const observer = createProjectObserver({ selection, key: randomSecret(), scopeId: randomSecret(), metrics: () => { calls++; return { sampledAt: Date.now(), cpuPct: null, memory: { total: 1000, free: 250, used: 750 } }; } }); f.cleanups.push(() => observer.close());
  await observer.snapshot({ revision: 1, permissions: grants }); assert.equal(calls, 0);
  publicDObservation(await observer.snapshot({ revision: 2, permissions: { ...grants, systemMetrics: true } })); assert.equal(calls, 1);
});

test('multi-session encrypted bridge retrieves only the chosen transcript and changes sharing permissions through a new authenticated revision', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'D-ALPHA'); await f.claudeLog('a.jsonl', f.a, 'D-CLAUDE'); await f.codexLog('b.jsonl', f.b, 'D-NEVER-BETA');
  const rig = await bridge(f, f.a), id = rig.client.latestPacket.message.sessions.find(session => session.agent === 'codex').id;
  assert.equal(rig.client.latestPacket.message.sessions.length, 2);
  assert.ok(!rig.wire.join('').includes('D-ALPHA'));
  const response = await rig.client.request('log.read', { id }), log = await response.json(); assert.equal(log.items[0].text, 'D-ALPHA');
  const revision = rig.core.state.revision;
  await rig.core.setPermissions({ content: false, accountQuota: false, systemMetrics: true }, revision);
  await wait(() => rig.record.revision === revision + 1 && rig.client.state.status === 'connected');
  assert.equal(rig.client.can('log.read'), false); assert.equal(rig.client.state.capabilities.observe, true);
  assert.ok(rig.summary().metrics.memory.total > 0);
  await assert.rejects(response.json());
  await assert.rejects(rig.client.request('log.read', { id })); assert.deepEqual(rig.summary().quotas, []);
  await assert.rejects(rig.core.setPermissions(grants, revision));
  await rig.core.setPermissions(grants, revision + 1); await wait(() => rig.record.revision === revision + 2 && rig.client.can('log.read'));
  await assert.rejects(response.json());
  assert.equal((await (await rig.client.request('log.read', { id })).json()).items[0].text, 'D-ALPHA');
});

test('two paired PCs sharing a relay cannot read each other, even if ciphertext or IDs are swapped', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'ONLY-PC-A'); await f.codexLog('b.jsonl', f.b, 'ONLY-PC-B');
  const a = await bridge(f, f.a), b = await bridge(f, f.b, grants, a.relay);
  const aid = a.client.latestPacket.message.sessions[0].id, bid = b.client.latestPacket.message.sessions[0].id;
  assert.notEqual(aid, bid); await assert.rejects(a.client.request('log.read', { id: bid })); await assert.rejects(b.client.request('log.read', { id: aid }));
  const body = JSON.parse(a.wire.find(value => JSON.parse(value).ciphertext));
  await assert.rejects(open(body.ciphertext, b.record.identity, b.record.connector));
  await assert.rejects(relayTransport({ relay: a.relay.url, route: b.record.route, token: a.record.token }).call('poll'));
  const alog = await (await a.client.request('log.read', { id: aid })).json(), blog = await (await b.client.request('log.read', { id: bid })).json();
  assert.ok(!JSON.stringify(alog).includes('ONLY-PC-B')); assert.ok(!JSON.stringify(blog).includes('ONLY-PC-A'));
});

test('a permission notice with a delayed HTTP receipt does not discard the new authenticated hello', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'ALPHA'); let hold = false, release;
  const rig = await bridge(f, f.a, grants, undefined, { afterCoreSend() { if (!hold) return; hold = false; return new Promise(resolve => { release = resolve; }); } });
  hold = true; let done = false;
  const changing = rig.core.setPermissions({ ...grants, content: false }, 1).then(() => { done = true; });
  try {
    await wait(() => release); await wait(() => rig.record.revision === 2 && rig.client.state.status === 'connected');
    assert.equal(done, false); assert.equal(rig.client.can('log.read'), false); assert.equal(rig.client.latestPacket.message.sessions.length, 1);
    await assert.rejects(rig.core.setPermissions(grants, 2)); // The local mutation mutex remains held until completion.
  } finally { release?.(); await changing; }
});

test('PC consent script parses and permission updates require local bearer, origin and current revision', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'ALPHA'); const rig = await bridge(f, f.a);
  const control = await createControl(rig.core); f.cleanups.push(() => control.close());
  const url = new URL(control.url), token = new URLSearchParams(url.hash.slice(1)).get('control');
  const script = await (await fetch(`${url.origin}/control.js`)).text(); assert.doesNotThrow(() => new vm.Script(script));
  const send = (auth, origin, revision) => fetch(`${url.origin}/control/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${auth}` }), ...(origin && { Origin: origin }) }, body: JSON.stringify({ expectedRevision: revision, permissions: { ...grants, content: false } }) });
  assert.equal((await send(null, url.origin, 1)).status, 401); assert.equal((await send(token, 'https://evil.example', 1)).status, 403);
  assert.equal((await send(token, url.origin, 1)).status, 200); assert.equal((await send(token, url.origin, 1)).status, 409);
});

test('public D schema rejects permission leaks, arbitrary RPC/path fields, malformed metrics and oversized snapshots', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'ALPHA'); const rig = await f.observer(); const value = await snapshot(rig);
  publicDObservation(value);
  for (const invalid of [
    { ...value, shell: 'run' }, { ...value, permissions: { ...grants, localAdmin: true } },
    { ...value, sessions: Array(41).fill(value.sessions[0]) }, { ...value, quotas: [{ ...value.quotas[0], email: 'private@example.com' }] },
    { ...value, permissions: { ...grants, accountQuota: false } },
    { ...value, metrics: { sampledAt: Date.now(), cpuPct: 10, memory: { total: 100, free: 90, used: 40 } } },
  ]) assert.throws(() => publicDObservation(invalid));
  const none = await rig.observer.snapshot({ revision: 2, permissions: { content: false, accountQuota: false, systemMetrics: false } });
  assert.ok(none.sessions.every(session => !session.events.length)); assert.deepEqual(none.quotas, []); publicDObservation(none);
});

test('large logs drop an unanchored tail, reject a different project anchor and accept a long valid header', async t => {
  const f = await fixture(t), file = await f.codexLog('large.jsonl', f.a, 'SAFE-HEAD'), rig = await f.observer();
  const filler = JSON.stringify({ type: 'padding', text: 'x'.repeat(60000) }) + '\n';
  await fs.appendFile(file, filler.repeat(80) + JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: 'UNANCHORED-TAIL-PRIVATE' } }) + '\n');
  const first = await snapshot(rig), id = first.sessions[0].id;
  const detail = await rig.observer.snapshot({ revision: 1, permissions: grants, detail: { id, requestId: randomSecret() } });
  assert.equal(first.sessions[0].status, 'unknown'); assert.equal(first.sessions[0].partial, true);
  assert.ok(!JSON.stringify(detail).includes('UNANCHORED-TAIL-PRIVATE'));
  await fs.appendFile(file, JSON.stringify({ type: 'turn_context', payload: { cwd: f.b } }) + '\n');
  assert.equal((await snapshot(rig)).sessions.length, 0);
  const header = JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'long-header', cwd: f.a, instructions: 'x'.repeat(80000) } });
  await fs.writeFile(file, header + '\n' + JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: 'LONG-HEADER-OK' } }) + '\n');
  const last = await snapshot(rig); assert.equal(last.sessions.length, 1);
  assert.deepEqual(last.quotas, []); // Absence of rate_limits is unknown, never a fabricated allowance.
});

test('a project switch inside a small log cannot reuse a previously authorized transcript', async t => {
  const f = await fixture(t), file = await f.codexLog('a.jsonl', f.a, 'INITIAL'), rig = await f.observer();
  assert.equal((await snapshot(rig)).sessions.length, 1);
  await fs.appendFile(file, [
    { type: 'turn_context', payload: { cwd: f.b } },
    { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: 'PRIVATE-BETA' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const value = await snapshot(rig); assert.equal(value.sessions.length, 0); assert.ok(!JSON.stringify(value).includes('PRIVATE-BETA'));
});

test('an unreadable or oversized row cannot conceal a project switch or remove healthy provider sessions', async t => {
  const f = await fixture(t), file = await f.codexLog('broken.jsonl', f.a, 'INITIAL'); await f.claudeLog('healthy.jsonl', f.a, 'HEALTHY'); const rig = await f.observer();
  assert.equal((await snapshot(rig)).sessions.length, 2);
  const marker = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'HIDDEN-BETA' } }) + '\n';
  await fs.appendFile(file, JSON.stringify({ type: 'turn_context', payload: { cwd: f.b, instructions: 'x'.repeat(300000) } }) + '\n' + marker);
  const value = await snapshot(rig); assert.equal(value.sessions.length, 1); assert.equal(value.sessions[0].provider, 'claude');
  assert.equal(value.discovery.partial, true); assert.ok(!JSON.stringify(value).includes('HIDDEN-BETA'));
  await f.codexLog('broken.jsonl', f.a, 'RECOVERED'); assert.equal((await snapshot(rig)).sessions.length, 2);
  await fs.appendFile(file, '{incomplete-row\n' + marker); assert.equal((await snapshot(rig)).sessions.length, 1);
});

test('worst-case Unicode observations fit both JOSE layers without mutating the source or losing the selected session', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'BASE'); const rig = await f.observer(), base = await snapshot(rig);
  const model = base.sessions[0];
  base.sessions = Array.from({ length: 40 }, () => ({ ...model, id: 'rs-' + randomSecret(), name: '語'.repeat(80), project: '語'.repeat(100), model: '語'.repeat(100),
    events: Array.from({ length: 3 }, () => ({ type: 'cmd', label: '語'.repeat(200), at: Date.now() })) }));
  const selected = base.sessions[39]; base.quotas = [];
  base.details = { id: selected.id, requestId: randomSecret(), version: selected.version, error: null,
    messages: Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', text: '語'.repeat(990) + i, at: Date.now() })), events: [] };
  const original = JSON.stringify(base), bounded = boundObservation(base);
  assert.equal(JSON.stringify(base), original); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= OBSERVATION_BYTES);
  assert.ok(bounded.sessions.some(session => session.id === selected.id)); assert.ok(bounded.details.messages.at(-1).text.endsWith('19'));
  assert.equal(bounded.discovery.partial, true); publicDObservation(bounded);
  const sender = await createIdentity(), recipient = await createIdentity();
  const ciphertext = await seal({ v: 2, body: bounded }, sender, recipient.public);
  assert.ok(Buffer.byteLength(ciphertext) < 256 * 1024); assert.deepEqual((await open(ciphertext, recipient, sender.public)).payload.body, bounded);
});

test('selected-log cache coalesces reads, ignores superseded replies and clears permission-revoked content', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'A'); await f.claudeLog('c.jsonl', f.a, 'C'); const rig = await f.observer();
  const value = await snapshot(rig), a = value.sessions.find(s => s.provider === 'codex'), c = value.sessions.find(s => s.provider === 'claude'), sent = [], cache = createObservationCache(read => sent.push(read)); cache.apply(value);
  const first = cache.read(a.id), same = cache.read(a.id); const handledFirst = assert.rejects(first), handledSame = assert.rejects(same);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 1);
  const second = cache.read(c.id); await Promise.all([handledFirst, handledSame]); await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 2);
  const old = await rig.observer.snapshot({ revision: 1, permissions: grants, detail: sent[0] }); cache.apply(old);
  let resolved = false; second.then(() => { resolved = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  cache.apply(await rig.observer.snapshot({ revision: 1, permissions: grants, detail: sent[1] })); assert.equal((await second).items[0].text, 'C');
  cache.apply(await rig.observer.snapshot({ revision: 2, permissions: { ...grants, content: false } })); await assert.rejects(cache.read(c.id));
  cache.clear(); await assert.rejects(cache.read(c.id));
});

test('metrics failure does not drop authorized sessions, and closed observers cannot scan again', async t => {
  const f = await fixture(t); await f.codexLog('a.jsonl', f.a, 'AVAILABLE');
  const selection = await selectProjects({ projects: [f.a], logs: f.logs });
  const observer = createProjectObserver({ selection, key: randomSecret(), scopeId: randomSecret(), metrics: () => { throw new Error('unavailable'); } });
  f.cleanups.push(() => observer.close()); const value = await observer.snapshot({ revision: 1, permissions: { ...grants, systemMetrics: true } });
  assert.equal(value.sessions.length, 1); assert.equal(value.metrics, null); publicDObservation(value);
  await observer.close(); await assert.rejects(observer.snapshot({ revision: 1, permissions: grants }));
});

test('returning to a tab after a clock gap clears cached content and authenticates a new observation epoch', async t => {
  const f = await fixture(t); await f.codexLog('wake.jsonl', f.a, 'WAKE-CONTENT');
  const previous = globalThis.document, document = new EventTarget(); document.visibilityState = 'visible'; globalThis.document = document;
  let offset = 0;
  try {
    const rig = await bridge(f, f.a, grants, undefined, { now: () => Date.now() + offset });
    const id = rig.client.latestPacket.message.sessions[0].id;
    assert.equal((await (await rig.client.request('log.read', { id })).json()).items[0].text, 'WAKE-CONTENT');
    offset = 31000; document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(rig.client.latestPacket.message.sessions.length, 0); assert.equal(rig.client.can('log.read'), false); assert.equal(rig.summary(), null);
    offset = 0; await wait(() => rig.client.state.status === 'connected' && rig.client.latestPacket.message.sessions.length === 1);
    assert.equal((await (await rig.client.request('log.read', { id })).json()).items[0].text, 'WAKE-CONTENT');
    const coreIdentity = await importIdentity((await rig.store.load()).identity), epochs = new Set();
    for (const body of rig.wire) {
      try { const { payload } = await open(JSON.parse(body).ciphertext, coreIdentity, rig.record.identity.public); if (payload.type === 'hello') epochs.add(payload.epoch); }
      catch { /* opposite-direction envelopes cannot be decrypted with the Connector key */ }
    }
    assert.ok(epochs.size >= 2);
    rig.client.close();
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});
