// Public C wire schema: one explicitly selected log, no filesystem routing fields or command RPC.
import { exact, isSecret, requireRemote, secureOrigin } from './crypto.js';
import { validateObservationSnapshot } from '../observation.js';
import { validateDFrame } from './observation-v2.js';
const text = (v, n) => typeof v === 'string' && v.length <= n && !/[\u0000-\u001f]/.test(v);
export const OBSERVATION_FRESH_MS = 30000;
export const OBSERVATION_RECEIPT_MS = 45000;
export async function invitation(value, now = Date.now()) {
  requireRemote(exact(value, ['v', 'route', 'relay', 'token', 'claim', 'expires', 'connector', 'protocol']) && value.v === 1 && [undefined, 2].includes(value.protocol)
    && isSecret(value.route) && isSecret(value.token) && isSecret(value.claim) && Number.isSafeInteger(value.expires)
    && value.expires > now && value.expires <= now + 5 * 60000, 'invite');
  const { validatePublic } = await import('./crypto.js');
  return { ...value, relay: secureOrigin(value.relay), connector: await validatePublic(value.connector) };
}
export function validateFrame(p, route, receiver, { protocol = 1, permission = 1 } = {}) {
  requireRemote(exact(p, ['v', 'type', 'route', 'epoch', 'seq', 'permission', 'body', 'iss', 'aud', 'iat', 'exp', 'jti'])
    && p.v === protocol && p.route === route && p.aud === receiver && isSecret(p.epoch) && Number.isSafeInteger(p.seq) && p.seq >= 0
    && Number.isSafeInteger(p.permission) && p.permission > 0 && (permission === null || p.permission === permission));
  if (protocol === 2) { validateDFrame(p); return p; }
  requireRemote(['hello', 'paired', 'ready', 'observe', 'seen', 'revoked'].includes(p.type));
  if (p.type === 'hello') requireRemote(p.seq === 0 && exact(p.body, ['claim', 'public']) && (p.body.claim === null || isSecret(p.body.claim)));
  if (p.type === 'paired') requireRemote(p.seq === 0 && exact(p.body, ['name', 'projectId']) && text(p.body.name, 80) && isSecret(p.body.projectId));
  if (p.type === 'revoked') requireRemote(exact(p.body, []));
  if (p.type === 'ready') requireRemote(p.seq === 0 && exact(p.body, []));
  if (p.type === 'seen') requireRemote(p.seq > 0 && exact(p.body, []));
  if (p.type === 'observe') requireRemote(p.seq > 0 && exact(p.body, ['projectId', 'sampledAt', 'sessions']) && isSecret(p.body.projectId)
    && Number.isSafeInteger(p.body.sampledAt) && Array.isArray(p.body.sessions) && p.body.sessions.length <= 1);
  return p;
}
export function publicObservation(value) {
  requireRemote(exact(value, ['projectId', 'sampledAt', 'sessions']) && isSecret(value.projectId));
  const parsed = validateObservationSnapshot({ version: 1, source: 'browser-log', ...value });
  requireRemote(parsed && parsed.sessions.length === value.sessions.length && parsed.sessions.length <= 1);
  return { projectId: value.projectId, sampledAt: parsed.sampledAt, sessions: parsed.sessions };
}
export function observationMessage(value) {
  const snapshot = publicObservation(value), stats = { read: 0, edit: 0, cmd: 0, prompts: 0 }, feed = [];
  const sessions = snapshot.sessions.map(s => {
    for (const e of s.events) { stats[e.type] = (stats[e.type] || 0) + 1; feed.push({ id: `${s.id}:${feed.length}`, sess: s.id, name: s.name, ts: e.at || snapshot.sampledAt, type: e.type === 'cmd' ? 'bash' : e.type, label: e.label }); }
    stats.prompts += s.messages.filter(m => m.role === 'user').length;
    return { id: s.id, sid: s.id, agent: s.provider, name: s.name, dir: s.project || s.name, projectId: snapshot.projectId,
      title: s.name, status: s.status === 'work' ? 'work' : 'rest', lastAt: s.updatedAt || snapshot.sampledAt,
      taskStart: s.status === 'work' ? s.updatedAt : 0, createdAt: s.updatedAt || snapshot.sampledAt,
      last: s.events.length ? { type: s.events.at(-1).type === 'cmd' ? 'bash' : s.events.at(-1).type, label: s.events.at(-1).label } : null,
      usage: s.contextUsed !== null && s.contextMax !== null ? { model: s.model || s.provider, in: s.inputTokens, out: s.outputTokens, ctx: s.contextUsed, ctxMax: s.contextMax, cost: null, at: snapshot.sampledAt } : null,
      counts: s.counts, subs: [], doneSubs: [], todos: [], observed: true };
  });
  return { k: 'snap', sessions, feed: feed.sort((a, b) => a.ts - b.ts), stats };
}
