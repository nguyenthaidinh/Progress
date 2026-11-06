import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createIdentity, exportIdentity, importIdentity, randomSecret, tokenHash, seal, open, secureOrigin, validatePublic } from '../../src/shared/remote/crypto.js';
import { invitation, validateFrame } from '../../src/shared/remote/contract.js';
import { relayTransport } from '../../src/shared/remote/transport.js';
import { createRelay } from '../../relay/server.mjs';
import { createConnector } from '../../connector/core.mjs';
import { createControl } from '../../connector/control.mjs';
import { selectLog, readSelectedLog } from '../../connector/observation.mjs';
import { secretStore } from '../../connector/store.mjs';
import { createBrowserPair, createEncryptedRelaySource } from '../../src/office/data/encrypted-relay.js';
import { createOfficeClient } from '../../src/office/data/client.js';

const wait = async fn => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 10000) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); } };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lioops-secure-test-'));
  t.after(async () => {
    const target = await fs.realpath(dir), root = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(target), root); assert.ok(path.basename(target).startsWith('lioops-secure-test-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const file = path.join(dir, 'session.jsonl'), timestamp = new Date().toISOString();
  await fs.writeFile(file, [
    { type: 'session_meta', timestamp, payload: { id: 'real-format-session', cwd: 'F:/private/project-green' } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'CONFIDENTIAL-PROMPT-ONE' } },
    { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: 'CONFIDENTIAL-ANSWER-ONE' } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 800, output_tokens: 200 }, last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 } } },
  ].map(JSON.stringify).join('\n') + '\n');
  return { dir, file, selection: await selectLog(file) };
}
async function relayFixture(t, options = {}) {
  const adminToken = randomSecret(), relay = createRelay({ adminToken, origins: ['http://127.0.0.1:8000'], pollMs: 200, ...options });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { relay.server.closeAllConnections(); await new Promise(resolve => relay.server.close(resolve)); });
  return { ...relay, adminToken, url: `http://127.0.0.1:${relay.server.address().port}` };
}
function memoryStore() { let value = null; return { load: async () => structuredClone(value), save: async next => { value = structuredClone(next); } }; }

test('JOSE authenticates the sender and recipient, rejects tampering, expired tokens and substituted public keys', async () => {
  const a = await createIdentity(), b = await createIdentity(), attacker = await createIdentity(), now = Date.now();
  const ciphertext = await seal({ type: 'probe', body: { text: 'hidden' } }, a, b.public, now);
  assert.equal((await open(ciphertext, b, a.public, now)).payload.body.text, 'hidden');
  assert.ok(!ciphertext.includes('hidden')); assert.equal(a.sign.extractable, false); assert.equal(a.box.extractable, false);
  await assert.rejects(open(ciphertext, attacker, a.public));
  await assert.rejects(open(ciphertext, b, attacker.public));
  const parts = ciphertext.split('.'); parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  await assert.rejects(open(parts.join('.'), b, a.public));
  await assert.rejects(open(ciphertext, b, a.public, now + 90000));
  await assert.rejects(validatePublic({ ...a.public, box: attacker.public.box }));
  await assert.rejects(validatePublic({ ...a.public, sign: { ...a.public.sign, d: randomSecret() } }));
});

test('identities survive protected persistence and mismatched private keys fail closed', async t => {
  const { dir } = await fixture(t), a = await createIdentity({ extractable: true }), b = await createIdentity({ extractable: true });
  const saved = await exportIdentity(a), store = secretStore(path.join(dir, 'identity.json'));
  await store.save({ identity: saved, secret: 'DO-NOT-STORE-AS-PLAINTEXT' });
  const raw = await fs.readFile(path.join(dir, 'identity.json'), 'utf8'); assert.ok(!raw.includes(saved.sign.d)); assert.ok(!raw.includes('DO-NOT-STORE-AS-PLAINTEXT'));
  if (process.platform === 'win32') assert.equal(JSON.parse(raw).protection, 'dpapi-current-user');
  else assert.equal((await fs.stat(path.join(dir, 'identity.json'))).mode & 0o777, 0o600);
  assert.equal((await importIdentity((await store.load()).identity)).public.id, a.public.id);
  for (const revision of [2, 3]) {
    await store.save({ identity: saved, revision, note: 'Dự án quan sát · 語', permissions: { content: revision === 3, systemMetrics: true } });
    const restored = await store.load(); assert.equal(restored.revision, revision); assert.equal(restored.note, 'Dự án quan sát · 語');
    assert.equal(restored.permissions.content, revision === 3); assert.equal((await importIdentity(restored.identity)).public.id, a.public.id);
  }
  await assert.rejects(importIdentity({ ...saved, sign: (await exportIdentity(b)).sign }));
});

test('invites require HTTPS or loopback, exact shape, strong secrets and a short expiry', async () => {
  const identity = await createIdentity(), now = Date.now(), invite = { v: 1, relay: 'https://relay.example', route: randomSecret(), token: randomSecret(), claim: randomSecret(), expires: now + 60000, connector: identity.public };
  assert.equal((await invitation(invite, now)).relay, 'https://relay.example');
  for (const bad of [{ ...invite, claim: '123456' }, { ...invite, shell: 'run' }, { ...invite, expires: now - 1 }, { ...invite, expires: now + 600000 }, { ...invite, relay: 'http://relay.example' }]) await assert.rejects(invitation(bad, now));
  for (const url of ['https://name:password@relay.example', 'https://relay.example/path', 'https://relay.example/?token=secret']) assert.throws(() => secureOrigin(url));
});

test('relay enforces auth, origin, bounded queues and separate mailbox roles without decoding ciphertext', async t => {
  const relay = await relayFixture(t, { maxRoutes: 1 }), route = randomSecret(), owner = randomSecret(), browser = randomSecret();
  const register = body => fetch(`${relay.url}/v1/routes`, { method: 'POST', headers: { Authorization: `Bearer ${relay.adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await register({ id: route, connectorHash: await tokenHash(owner), browserHash: await tokenHash(browser) })).status, 201);
  assert.equal((await register({ id: randomSecret(), connectorHash: await tokenHash(owner), browserHash: await tokenHash(browser) })).status, 429);
  const sender = relayTransport({ relay: relay.url, route, token: owner }), receiver = relayTransport({ relay: relay.url, route, token: browser });
  await sender.call('send', 'a.b.c.d.e'); assert.equal(relay.metadata().queuedBytes, 9);
  assert.equal((await receiver.call('poll')).ciphertext, 'a.b.c.d.e'); assert.equal(relay.metadata().queuedBytes, 0);
  await assert.rejects(receiver.call('close'));
  const forbidden = await fetch(`${relay.url}/v1/routes/${route}/poll`, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: `Bearer ${browser}`, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(forbidden.status, 403);
  await assert.rejects(relayTransport({ relay: relay.url, route, token: randomSecret() }).call('poll'));
  for (let i = 0; i < 4; i++) await sender.call('send', 'a.b.c.d.e');
  await assert.rejects(sender.call('send', 'a.b.c.d.e'));
  await sender.call('close'); assert.deepEqual(relay.metadata(), { routes: 0, queuedBytes: 0 });
});

test('selected observation is bounded, uses a public project ID and rejects replaced files or credential filenames', async t => {
  const { selection, file, dir } = await fixture(t), project = randomSecret();
  const data = await readSelectedLog(selection, project);
  assert.equal(data.projectId, project); assert.equal(data.sessions[0].project, 'project-green');
  assert.ok(!JSON.stringify(data).includes('F:/private')); assert.equal(data.sessions[0].contextUsed, 1000);
  await assert.rejects(selectLog(path.join(dir, 'auth.jsonl')));
  await fs.rename(file, path.join(dir, 'previous.jsonl')); await fs.writeFile(file, '{}');
  await assert.rejects(readSelectedLog(selection, project));
});

test('real Connector and relay pair only after local consent, show real-format logs, reconnect and revoke without command RPC', async t => {
  const { selection } = await fixture(t), relay = await relayFixture(t), store = memoryStore(), wire = [];
  const forward = (input, init) => { if (String(input).endsWith('/send')) wire.push(init.body); return fetch(input, init); };
  const connector = await createConnector({ relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection, store, fetch: forward, intervalMs: 300 });
  await connector.start(); t.after(() => connector.stop());
  const invite = JSON.parse(new URLSearchParams(new URL(connector.inviteURL).hash.slice(1)).get('lioops-pair'));
  const record = await createBrowserPair(invite); let persisted;
  const adapter = createEncryptedRelaySource({ record, fetch: forward, save: async value => { persisted = value; } });
  const client = createOfficeClient(); t.after(() => client.close()); client.connect(adapter);
  await wait(() => connector.state.pending);
  assert.equal(client.can('log.read'), false); assert.equal(connector.state.paired, false); assert.equal(client.latestPacket, null);
  await assert.rejects(connector.approve(randomSecret(), connector.state.pending.epoch));
  const pending = connector.state.pending; await connector.approve(pending.fingerprint, pending.epoch);
  await wait(() => client.state.status === 'connected');
  assert.equal(persisted.paired, true); assert.equal(persisted.claim, null); assert.equal(client.can('log.read'), true);
  const session = client.latestPacket.message.sessions[0]; assert.equal(session.name, 'project-green');
  assert.equal((await (await client.request('log.read', { id: session.id })).json()).items[0].text, 'CONFIDENTIAL-PROMPT-ONE');
  for (const name of ['tasks.start', 'system.action', 'prompt.rewrite', 'accounts.use', 'chat.send', 'image.read']) assert.equal(client.can(name), false);
  assert.ok(wire.length >= 3); for (const body of wire) for (const secret of ['CONFIDENTIAL', selection.file, 'project-green', record.identity.public.id]) assert.ok(!body.includes(secret));
  const context = client.context; client.reconnect(); await wait(() => client.state.status === 'connected'); assert.equal(client.context, context);
  await connector.revoke(); await wait(() => !client.state.capabilities.content);
  assert.equal((await store.load()).revoked, true); assert.equal(client.latestPacket.message.sessions.length, 0);
  await assert.rejects(client.request('log.read', { id: session.id }));
});

test('PC control requires its per-start bearer, correct origin and matching pending key/epoch', async t => {
  const connector = { state: { status: 'waiting', paired: false, revoked: false, pending: null }, inviteURL: null,
    approve: async () => { throw new Error('No pending request'); }, revoke: async () => {} };
  const control = await createControl(connector); t.after(() => control.close());
  const url = new URL(control.url), token = new URLSearchParams(url.hash.slice(1)).get('control');
  const send = (action, auth, origin) => fetch(`${url.origin}/control/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth && { Authorization: `Bearer ${auth}` }), ...(origin && { Origin: origin }) }, body: '{}' });
  assert.equal((await send('status')).status, 401); assert.equal((await send('status', token, 'https://evil.example')).status, 403);
  assert.equal((await send('status', token, url.origin)).status, 200); assert.equal((await send('approve', token, url.origin)).status, 400);
  assert.equal((await fetch(control.url)).headers.get('referrer-policy'), 'no-referrer');
});

test('wire validation rejects wrong route, recipient, direction, permission and command types', () => {
  const route = randomSecret(), recipient = randomSecret(), valid = { v: 1, type: 'hello', route, epoch: randomSecret(), seq: 0, permission: 1,
    iss: randomSecret(), aud: recipient, iat: 0, exp: 60, jti: randomSecret(), body: { claim: randomSecret(), public: {} } };
  assert.equal(validateFrame(valid, route, recipient), valid);
  for (const value of [{ ...valid, route: randomSecret() }, { ...valid, aud: randomSecret() }, { ...valid, permission: 2 }, { ...valid, type: 'tasks.start' }, { ...valid, seq: 1 }, { ...valid, method: 'POST' }]) assert.throws(() => validateFrame(value, route, recipient));
});

test('encrypted adapter ignores forged, replayed, old-epoch and scope-changing frames; sequence gaps force a fresh handshake', async t => {
  const { selection } = await fixture(t), connector = await createIdentity(), browser = await createIdentity(), attacker = await createIdentity();
  const route = randomSecret(), projectId = randomSecret(), data = await readSelectedLog(selection, projectId), queue = [], packets = [];
  let epoch, hellos = 0;
  const frame = (type, seq, body, extra = {}) => ({ type, route, epoch, seq, permission: 1, body, ...extra });
  const response = ciphertext => new Response(JSON.stringify({ ok: true, ciphertext }), { headers: { 'Content-Type': 'application/json' } });
  const mock = async (input, init) => {
    if (String(input).endsWith('/send')) {
      const hello = (await open(JSON.parse(init.body).ciphertext, connector, browser.public)).payload;
      if (['seen', 'ready'].includes(hello.type)) return response(null);
      epoch = hello.epoch; hellos++;
      queue.push(await seal(frame('paired', 0, { name: 'PC', projectId }), connector, browser.public), await seal(frame('observe', 1, data), connector, browser.public));
      return response(null);
    }
    if (!queue.length) await new Promise(resolve => setTimeout(resolve, 30));
    return response(queue.shift() || null);
  };
  const adapter = createEncryptedRelaySource({ record: { relay: 'http://127.0.0.1:8000', route, token: randomSecret(), connector: connector.public,
    paired: true, projectId, claim: null, identity: browser }, fetch: mock, save: async () => {} });
  const client = createOfficeClient(); t.after(() => client.close()); client.subscribe(packet => packets.push(packet)); client.connect(adapter);
  await wait(() => client.state.status === 'connected');
  const valid = await seal(frame('observe', 1, data), connector, browser.public), bad = valid.split('.'); bad[4] = (bad[4][0] === 'A' ? 'B' : 'A') + bad[4].slice(1);
  queue.push(valid, bad.join('.'), await seal(frame('observe', 2, data), attacker, browser.public),
    await seal(frame('observe', 2, data, { epoch: randomSecret() }), connector, browser.public),
    await seal(frame('observe', 2, data, { permission: 2 }), connector, browser.public),
    await seal(frame('observe', 2, { ...data, projectId: randomSecret() }), connector, browser.public),
    await seal(frame('tasks.start', 2, {}), connector, browser.public));
  const changed = { ...data, sessions: [{ ...data.sessions[0], name: 'verified-update' }] };
  queue.push(await seal(frame('observe', 2, changed), connector, browser.public));
  await wait(() => client.latestPacket?.message.sessions[0]?.name === 'verified-update');
  assert.equal(hellos, 1); assert.equal(client.state.status, 'connected');
  const oldEpoch = epoch;
  queue.push(await seal(frame('observe', 4, changed), connector, browser.public));
  await wait(() => hellos === 2 && client.state.status === 'connected');
  assert.notEqual(epoch, oldEpoch); assert.ok(packets.some(packet => packet.message.sessions.length === 0));
  assert.equal(client.latestPacket.message.sessions[0].name, 'project-green');
});

test('malicious relay response size is bounded while streaming', async () => {
  let cancelled = false;
  const transport = relayTransport({ relay: 'http://127.0.0.1:8000', route: randomSecret(), token: randomSecret(), fetch: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(300000)); }, cancel() { cancelled = true; },
  })) });
  await assert.rejects(transport.call('poll'), error => error.code === 'size'); assert.equal(cancelled, true);
});

test('local revocation cannot be overwritten by an approval whose durable save is still pending', async t => {
  const { selection } = await fixture(t), relay = await relayFixture(t); let saved = null, savingApproval = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = { load: async () => structuredClone(saved), save: async value => {
    if (value.peer && !value.revoked) { savingApproval = true; await gate; }
    saved = structuredClone(value);
  } };
  const connector = await createConnector({ relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection, store });
  await connector.start(); t.after(() => connector.stop());
  const invite = JSON.parse(new URLSearchParams(new URL(connector.inviteURL).hash.slice(1)).get('lioops-pair'));
  const record = await createBrowserPair(invite), client = createOfficeClient(); t.after(() => client.close());
  client.connect(createEncryptedRelaySource({ record, save: async () => {} })); await wait(() => connector.state.pending);
  const pending = connector.state.pending, approval = connector.approve(pending.fingerprint, pending.epoch).catch(error => error);
  await wait(() => savingApproval); const revocation = connector.revoke(); release(); await revocation;
  assert.equal((await approval).code, 'revoked'); assert.equal(saved.revoked, true); assert.equal(saved.peer, null); assert.equal(client.can('log.read'), false);
});

test('expired unapproved invitations rotate identity and routing secrets instead of remaining permanently stuck', async t => {
  const { selection } = await fixture(t), relay = await relayFixture(t), store = memoryStore(); let clock = Date.now();
  const options = { relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection, store, now: () => clock };
  const previous = await createConnector(options), before = previous.inviteURL; await previous.stop(); clock += 6 * 60000;
  const next = await createConnector(options); t.after(() => next.stop());
  assert.ok(next.inviteURL); assert.notEqual(next.inviteURL, before); assert.equal(next.state.paired, false);
});

test('disk failure stops sharing and never reports a durable revocation as successful', async t => {
  const { selection } = await fixture(t), relay = await relayFixture(t), store = memoryStore(); let fail = false;
  const connector = await createConnector({ relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection,
    store: { load: store.load, save: value => { if (fail) throw new Error('disk'); return store.save(value); } } });
  await connector.start(); t.after(() => connector.stop()); fail = true;
  await assert.rejects(connector.revoke()); assert.equal(connector.state.status, 'unavailable'); assert.equal(connector.state.revoked, false);
  assert.equal(connector.inviteURL, null);
});

test('large Unicode transcripts fit the wire budget after JOSE expansion', async t => {
  const { selection, file } = await fixture(t), text = '\u{1F642}'.repeat(1500), timestamp = new Date().toISOString();
  for (let i = 0; i < 45; i++) await fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp, payload: { type: i % 2 ? 'agent_message' : 'user_message', message: text + i } }) + '\n');
  const projectId = randomSecret(), data = await readSelectedLog(selection, projectId), a = await createIdentity(), b = await createIdentity();
  assert.equal(data.sessions[0].messages.length, 20); assert.ok(data.sessions[0].messages.every(message => message.text.length <= 1000));
  const ciphertext = await seal({ type: 'observe', route: randomSecret(), epoch: randomSecret(), seq: 1, permission: 1, body: data }, a, b.public);
  assert.ok(ciphertext.length < 256 * 1024);
});

test('a slow browser cannot fill the relay queue; only an authenticated receipt for the outstanding snapshot releases backpressure', async t => {
  const { selection } = await fixture(t), relay = await relayFixture(t), store = memoryStore(); let snapshots = 0;
  const forward = async (input, init) => { if (String(input).endsWith('/send')) snapshots++; return fetch(input, init); };
  const connector = await createConnector({ relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection, store, fetch: forward, intervalMs: 20 });
  await connector.start(); t.after(() => connector.stop());
  const invite = JSON.parse(new URLSearchParams(new URL(connector.inviteURL).hash.slice(1)).get('lioops-pair'));
  const browser = await createIdentity(), channel = relayTransport({ relay: relay.url, route: invite.route, token: invite.token }), epoch = randomSecret();
  const hello = await seal({ type: 'hello', route: invite.route, epoch, seq: 0, permission: 1, body: { claim: invite.claim, public: browser.public } }, browser, invite.connector);
  await channel.call('send', hello); await wait(() => connector.state.pending);
  const pending = connector.state.pending; await connector.approve(pending.fingerprint, pending.epoch);
  await channel.call('poll'); // authenticated peer acknowledgement carries no log content
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(snapshots, 1);
  await channel.call('send', await seal({ type: 'ready', route: invite.route, epoch, seq: 0, permission: 1, body: {} }, browser, invite.connector));
  await wait(() => snapshots === 2);
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(snapshots, 2); // paired + one snapshot
  const first = (await open((await channel.call('poll')).ciphertext, browser, invite.connector)).payload;
  assert.equal(first.seq, 1);
  const receipt = seq => seal({ type: 'seen', route: invite.route, epoch, seq, permission: 1, body: {} }, browser, invite.connector);
  await channel.call('send', await receipt(9)); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(snapshots, 2);
  const accepted = await receipt(1); await channel.call('send', accepted); await wait(() => snapshots === 3);
  await channel.call('send', accepted); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(snapshots, 3);
  assert.equal((await open((await channel.call('poll')).ciphertext, browser, invite.connector)).payload.seq, 2);
});

test('approval persistence failure never releases content or leaves a usable invitation in the running process', async t => {
  const { selection } = await fixture(t), relay = await relayFixture(t), store = memoryStore();
  const connector = await createConnector({ relay: relay.url, webURL: 'http://127.0.0.1:8000/', adminToken: relay.adminToken, selection,
    store: { load: store.load, save: value => { if (value.peer) throw new Error('disk'); return store.save(value); } } });
  await connector.start(); t.after(() => connector.stop());
  const invite = JSON.parse(new URLSearchParams(new URL(connector.inviteURL).hash.slice(1)).get('lioops-pair'));
  const record = await createBrowserPair(invite), client = createOfficeClient(); t.after(() => client.close());
  client.connect(createEncryptedRelaySource({ record, save: async () => {} })); await wait(() => connector.state.pending);
  const pending = connector.state.pending;
  await assert.rejects(connector.approve(pending.fingerprint, pending.epoch));
  assert.equal(connector.state.status, 'unavailable'); assert.equal(connector.state.paired, false); assert.equal(connector.inviteURL, null);
  assert.equal(client.can('log.read'), false); assert.equal(client.latestPacket, null);
});

test('forgetting an adapter invalidates retained references so history restoration cannot reconnect with discarded keys', async () => {
  const identity = await createIdentity(), connector = await createIdentity(); let calls = 0;
  const record = { relay: 'http://127.0.0.1:8000', route: randomSecret(), token: randomSecret(), connector: connector.public, paired: true, projectId: randomSecret(), claim: null, identity };
  const source = createEncryptedRelaySource({ record, save: async () => {}, fetch: async () => { calls++; throw new Error('network'); } });
  source.dispose(); source.markRendererReady();
  const states = []; source.subscribe({ onEvent() { assert.fail('Disposed source emitted content'); }, onStatus: value => states.push(value) });
  await assert.rejects(source.request('log.read', { id: 'previous' }));
  assert.deepEqual(states, ['closed']); assert.equal(calls, 0); assert.equal(record.identity, null); assert.equal(record.token, null);
});
