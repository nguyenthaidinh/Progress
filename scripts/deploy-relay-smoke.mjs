// Explicit operator smoke: real HTTPS relay, synthetic local log, no provider execution or real account history.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createConnector } from '../connector/core.mjs';
import { selectProjects } from '../connector/scope.mjs';
import { createBrowserPair, createEncryptedRelaySource } from '../src/office/data/encrypted-relay.js';
import { createOfficeClient } from '../src/office/data/client.js';

const relay = process.env.LIOOPS_DEPLOY_RELAY_URL, webURL = process.env.LIOOPS_DEPLOY_WEB_URL;
if (!relay?.startsWith('https://') || !webURL?.startsWith('https://') || !process.env.LIOOPS_RELAY_ADMIN_TOKEN) throw new Error('Explicit HTTPS URLs and operator relay credential required');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lioops-deploy-smoke-')), project = path.join(dir, 'synthetic-project'), logs = path.join(dir, 'logs');
let core, client, saved; const wire = [];
const wait = async condition => { const start = Date.now(); while (!condition()) { if (Date.now() - start > 60000) throw new Error('Authenticated observation timed out'); await new Promise(resolve => setTimeout(resolve, 100)); } };
try {
  await fs.mkdir(project); await fs.mkdir(logs);
  const timestamp = new Date().toISOString(), marker = 'LIOOPS-DEPLOY-SYNTHETIC-ONLY';
  await fs.writeFile(path.join(logs, 'sample.jsonl'), [
    { type: 'session_meta', timestamp, payload: { id: 'deployment-smoke', cwd: project } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: marker } },
    { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: marker + '-ANSWER' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const forward = (input, init) => { if (String(input).endsWith('/send')) wire.push(init.body); return fetch(input, init); };
  core = await createConnector({ relay, webURL, adminToken: process.env.LIOOPS_RELAY_ADMIN_TOKEN,
    selection: await selectProjects({ projects: [project], logs: [{ provider: 'codex', path: logs }] }),
    store: { load: async () => saved || null, save: async value => { saved = structuredClone(value); } }, fetch: forward, intervalMs: 1000 });
  await core.start();
  const invite = JSON.parse(new URLSearchParams(new URL(core.inviteURL).hash.slice(1)).get('lioops-pair'));
  const record = await createBrowserPair(invite); client = createOfficeClient();
  client.connect(createEncryptedRelaySource({ record, save: async () => {}, fetch: forward }));
  await wait(() => core.state.pending); await core.approve(core.state.pending.fingerprint, core.state.pending.epoch);
  await wait(() => client.state.status === 'connected' && client.latestPacket.message.sessions.length === 1);
  const id = client.latestPacket.message.sessions[0].id;
  assert.equal(client.can('tasks.start'), false);
  assert.equal((await (await client.request('log.read', { id })).json()).items[0].text, marker);
  assert.ok(wire.length > 2 && wire.every(body => !body.includes(marker) && !body.includes('synthetic-project')));
  await core.setPermissions({ content: false, accountQuota: false, systemMetrics: false }, core.state.revision);
  await wait(() => record.revision === 2 && client.state.status === 'connected'); assert.equal(client.can('log.read'), false);
  await core.revoke(); await wait(() => !client.state.capabilities.observe);
  console.log(JSON.stringify({ status: 'pass', relay, encryptedPairing: true, selectedLog: true, permissionChange: true, revocation: true, realProviderExecution: false }));
} finally {
  client?.close(); await core?.stop();
  const real = await fs.realpath(dir), root = await fs.realpath(os.tmpdir());
  if (path.dirname(real) !== root || !path.basename(real).startsWith('lioops-deploy-smoke-')) throw new Error('Unsafe smoke cleanup path');
  await fs.rm(real, { recursive: true, force: true });
}
