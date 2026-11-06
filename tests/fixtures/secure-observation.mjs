// Real Connector/relay/control fixtures with their own explicit log and protected local identity store.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../../relay/server.mjs';
import { createConnector } from '../../connector/core.mjs';
import { createControl } from '../../connector/control.mjs';
import { selectLog } from '../../connector/observation.mjs';
import { secretStore } from '../../connector/store.mjs';
import { randomSecret } from '../../src/shared/remote/crypto.js';
import { quickTunnel } from './quick-tunnel.mjs';
export async function secureObservationFixture(webOrigin) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lioops-secure-browser-')), file = path.join(dir, 'session.jsonl'), wire = [], delivery = [];
  const timestamp = new Date().toISOString();
  await fs.writeFile(file, [
    { type: 'session_meta', timestamp, payload: { id: 'browser-codex-session', cwd: 'F:/private/green-project' } },
    { type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'PRIVATE-C-PROMPT-2026' } },
    { type: 'event_msg', timestamp, payload: { type: 'agent_message', message: 'PRIVATE-C-ANSWER-2026' } },
    { type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 800, output_tokens: 200 }, last_token_usage: { total_tokens: 1000 }, model_context_window: 10000 } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const adminToken = randomSecret(), relay = createRelay({ adminToken, origins: [webOrigin] });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const localRelay = `http://127.0.0.1:${relay.server.address().port}`;
  let tunnel, connector, control;
  async function close() {
    try { await control?.close(); await connector?.stop(); await tunnel?.close(); }
    finally {
      relay.server.closeAllConnections(); await new Promise(resolve => relay.server.close(resolve));
      const target = await fs.realpath(dir), root = await fs.realpath(os.tmpdir());
      if (path.dirname(target) !== root || !path.basename(target).startsWith('lioops-secure-browser-')) throw new Error('Unsafe fixture cleanup path');
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  try {
    if (process.env.LIOOPS_C_RELAY_HTTPS === '1') tunnel = await quickTunnel(localRelay, dir);
    const relayURL = tunnel?.url || localRelay;
    const forward = async (input, init) => {
      const action = String(input).split('/').at(-1); if (action === 'send') wire.push(init.body);
      try { const response = await fetch(input, init); delivery.push({ action, status: response.status, at: Date.now() }); return response; }
      catch (error) { delivery.push({ action, error: error.name, at: Date.now() }); throw error; }
    };
    connector = await createConnector({ relay: relayURL, webURL: `${webOrigin}/vi/`, adminToken, selection: await selectLog(file),
      store: secretStore(path.join(dir, 'connector.json')), fetch: forward });
    await connector.start(); control = await createControl(connector);
    return { connector, invite: connector.inviteURL, controlURL: control.url, relayURL, wire, delivery,
      async append() { await fs.appendFile(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'agent_message', message: 'PRIVATE-C-LIVE-UPDATE' } }) + '\n'); }, close };
  } catch (error) { await close(); throw error; }
}
