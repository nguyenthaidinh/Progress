// Internal C/D launcher; the end-user installer/startup experience is milestone F.
import path from 'node:path';
import os from 'node:os';
import { selectLog } from './observation.mjs';
import { secretStore } from './store.mjs';
import { createConnector } from './core.mjs';
import { createControl } from './control.mjs';
import fs from 'node:fs';
import { selectProjects } from './scope.mjs';
const args = process.argv.slice(2), values = flag => args.flatMap((value, index) => value === flag && args[index + 1] && !args[index + 1].startsWith('--') ? [args[index + 1]] : []);
const file = values('--log')[0], projects = values('--project');
if (!!file === !!projects.length) throw new Error('Select either --log <absolute-session.jsonl> or --project <absolute-folder> (repeatable)');
const logs = [];
for (const [provider, fallback] of [['codex', path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')],
  ['claude', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')]]) {
  const explicit = values(`--${provider}-logs`)[0], root = explicit || fallback;
  if (explicit || projects.length && fs.existsSync(root)) logs.push({ provider, path: root });
}
const selection = file ? await selectLog(file) : await selectProjects({ projects, logs,
  permissions: { content: !args.includes('--no-content'), accountQuota: !args.includes('--no-quota'), systemMetrics: args.includes('--metrics') } });
const data = process.env.LIOOPS_CONNECTOR_DATA || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'LioOps', 'Connector');
const connector = await createConnector({ relay: process.env.LIOOPS_RELAY_URL, webURL: process.env.LIOOPS_WEB_URL,
  adminToken: process.env.LIOOPS_RELAY_ADMIN_TOKEN, selection, store: secretStore(path.join(data, projects.length ? 'identity-d.json' : 'identity.json')) });
await connector.start();
const control = await createControl(connector, { language: process.env.OFFICE_LANG || 'vi' });
console.log(`LioOps Connector (internal ${projects.length ? 'D' : 'C'}): ${control.url}`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (stopping) return; stopping = true; await connector.stop(); await control.close(); });
