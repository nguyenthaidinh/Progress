// Isolated D browser fixture. Never discovers the real provider homes or executes a model.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../../relay/server.mjs';
import { createConnector } from '../../connector/core.mjs';
import { createControl } from '../../connector/control.mjs';
import { selectProjects } from '../../connector/scope.mjs';
import { secretStore } from '../../connector/store.mjs';
import { randomSecret, importIdentity, open } from '../../src/shared/remote/crypto.js';
export async function projectObservationFixture(webOrigin) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lioops-project-browser-')), project = path.join(dir, 'green-project'), denied = path.join(dir, 'private-project');
  const codex = path.join(dir, 'codex-logs'), claude = path.join(dir, 'claude-logs'), wire = [], delivery = [];
  for (const folder of [project, denied, codex, claude]) await fs.mkdir(folder);
  const codexFile = path.join(codex, 'a.jsonl');
  async function writeCodex(file, cwd, marker, at = Date.now()) {
    const timestamp = new Date(at).toISOString();
    await fs.writeFile(file, [
      { type: 'session_meta', timestamp, payload: { id: path.basename(file), cwd } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: marker } },
      { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: marker + '-ANSWER' } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 800, output_tokens: 200 }, last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 }, rate_limits: { primary: { used_percent: 25, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3600 } } } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  await writeCodex(codexFile, project, 'PRIVATE-D-CODEX');
  await writeCodex(path.join(codex, 'denied.jsonl'), denied, 'NEVER-SHARE-PROJECT-B');
  const timestamp = new Date().toISOString();
  await fs.writeFile(path.join(claude, 'c.jsonl'), [
    { type: 'user', sessionId: 'fixture-claude', cwd: project, timestamp, message: { content: [{ type: 'text', text: 'PRIVATE-D-CLAUDE' }] } },
    { type: 'assistant', sessionId: 'fixture-claude', cwd: project, timestamp, message: { id: 'fixture-answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'PRIVATE-D-CLAUDE-ANSWER' }], usage: { input_tokens: 40, output_tokens: 10 } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const adminToken = randomSecret(), relay = createRelay({ adminToken, origins: [webOrigin] });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const relayURL = `http://127.0.0.1:${relay.server.address().port}`;
  let connector, control, identity, peer;
  async function close() {
    try { await control?.close(); await connector?.stop(); }
    finally {
      relay.server.closeAllConnections(); await new Promise(resolve => relay.server.close(resolve));
      const target = await fs.realpath(dir), root = await fs.realpath(os.tmpdir());
      if (path.dirname(target) !== root || !path.basename(target).startsWith('lioops-project-browser-')) throw new Error('Unsafe fixture cleanup path');
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  try {
    const selection = await selectProjects({ projects: [project], logs: [{ provider: 'codex', path: codex }, { provider: 'claude', path: claude }] });
    const protectedStore = secretStore(path.join(dir, 'identity-d.json'));
    const store = { load: () => protectedStore.load(), async save(value) {
      const started = Date.now();
      try { await protectedStore.save(value); delivery.push({ store: 'saved', revision: value.revision, durationMs: Date.now() - started }); }
      catch (error) { delivery.push({ store: 'failed', revision: value.revision, durationMs: Date.now() - started, reason: error.code || error.message }); throw error; }
    } };
    connector = await createConnector({ relay: relayURL, webURL: `${webOrigin}/vi/`, adminToken, selection, store, onDiagnostic: event => delivery.push(event),
      async fetch(input, init) {
        const action = String(input).split('/').at(-1); if (action === 'send') wire.push(init.body);
        const response = await fetch(input, init);
        delivery.push({ action, status: response.status, at: Date.now() });
        if (action === 'poll' && response.ok && identity) {
          const data = await response.clone().json();
          if (data.ciphertext) {
            try { const { payload, sender } = await open(data.ciphertext, identity, peer); peer ||= sender;
              delivery.push({ incoming: payload.type, revision: payload.permission, seq: payload.seq, at: Date.now() });
            } catch { delivery.push({ incoming: 'invalid', at: Date.now() }); }
          }
        }
        return response;
      } });
    identity = await importIdentity((await store.load()).identity);
    await connector.start(); control = await createControl(connector);
    return { connector, invite: connector.inviteURL, controlURL: control.url, relayURL, wire, delivery, close,
      async append() { await fs.appendFile(codexFile, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: 'PRIVATE-D-LIVE-UPDATE' } }) + '\n'); },
      async addOldSession() { await writeCodex(path.join(codex, 'old.jsonl'), project, 'PRIVATE-D-OLD', Date.now() - 600000); },
    };
  } catch (error) { await close(); throw error; }
}
