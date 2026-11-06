// D's public schema. Fixed observation fields only; no paths, provider credentials or arbitrary RPC payloads.
import { exact, isSecret, requireRemote } from './crypto.js';
import { redact } from '../redact.js';
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableCount = value => value === null || count(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(value);
export const isSessionId = value => typeof value === 'string' && /^rs-[A-Za-z0-9_-]{43}$/.test(value);
const projectId = value => typeof value === 'string' && /^pr-[A-Za-z0-9_-]{43}$/.test(value);
export function validatePermissions(value) {
  requireRemote(exact(value, ['content', 'accountQuota', 'systemMetrics']) && ['content', 'accountQuota', 'systemMetrics'].every(key => typeof value[key] === 'boolean'));
  return { content: value.content, accountQuota: value.accountQuota, systemMetrics: value.systemMetrics };
}
function events(value, limit) {
  requireRemote(Array.isArray(value) && value.length <= limit);
  return value.map(event => {
    requireRemote(exact(event, ['type', 'label', 'at']) && ['read', 'edit', 'cmd', 'web'].includes(event.type) && text(event.label, 220) && nullableCount(event.at));
    return { type: event.type, label: redact(event.label), at: event.at };
  });
}
export function validateDFrame(p) {
  requireRemote(['hello', 'paired', 'ready', 'observe', 'seen', 'read', 'changed'].includes(p.type));
  if (p.type === 'hello') requireRemote(p.seq === 0 && exact(p.body, ['claim', 'public']) && (p.body.claim === null || isSecret(p.body.claim)));
  if (p.type === 'paired') {
    requireRemote(p.seq === 0 && exact(p.body, ['name', 'scopeId', 'permissions']) && text(p.body.name, 80) && isSecret(p.body.scopeId));
    validatePermissions(p.body.permissions);
  }
  if (p.type === 'ready' || p.type === 'seen') requireRemote(p.type === 'ready' ? p.seq === 0 : p.seq > 0);
  if (['ready', 'seen'].includes(p.type)) requireRemote(exact(p.body, []));
  if (p.type === 'changed') requireRemote(p.seq > 0 && exact(p.body, ['revision']) && Number.isSafeInteger(p.body.revision) && p.body.revision > p.permission);
  if (p.type === 'read') requireRemote(p.seq > 0 && exact(p.body, ['op', 'id', 'requestId']) && p.body.op === 'log' && isSessionId(p.body.id) && isSecret(p.body.requestId));
  if (p.type === 'observe') { requireRemote(p.seq > 0); publicDObservation(p.body); }
}
export function publicDObservation(value) {
  requireRemote(exact(value, ['schema', 'scopeId', 'revision', 'permissions', 'sampledAt', 'availability', 'sessions', 'details', 'metrics', 'quotas', 'discovery'])
    && value.schema === 2 && isSecret(value.scopeId) && Number.isSafeInteger(value.revision) && value.revision > 0 && count(value.sampledAt)
    && ['ok', 'partial', 'unavailable'].includes(value.availability) && Array.isArray(value.sessions) && value.sessions.length <= 40);
  const permissions = validatePermissions(value.permissions), ids = new Set();
  const sessions = value.sessions.map(session => {
    requireRemote(exact(session, ['id', 'projectId', 'version', 'provider', 'name', 'project', 'model', 'updatedAt', 'status', 'contextUsed', 'contextMax', 'inputTokens', 'outputTokens', 'counts', 'partial', 'events'])
      && isSessionId(session.id) && !ids.has(session.id) && projectId(session.projectId) && isSecret(session.version) && ['codex', 'claude'].includes(session.provider)
      && text(session.name, 80) && text(session.project, 100) && text(session.model, 100) && nullableCount(session.updatedAt)
      && ['work', 'rest', 'unknown'].includes(session.status) && ['contextUsed', 'contextMax', 'inputTokens', 'outputTokens'].every(key => nullableCount(session[key]))
      && exact(session.counts, ['read', 'edit', 'cmd', 'web']) && ['read', 'edit', 'cmd', 'web'].every(key => count(session.counts[key])) && typeof session.partial === 'boolean');
    ids.add(session.id); const preview = events(session.events, permissions.content ? 3 : 0);
    return { ...session, name: redact(session.name), project: redact(session.project), model: redact(session.model), counts: { ...session.counts }, events: preview };
  });
  let details = null;
  if (value.details !== null) {
    const detail = value.details;
    requireRemote(exact(detail, ['id', 'requestId', 'version', 'messages', 'events', 'error']) && isSessionId(detail.id) && isSecret(detail.requestId)
      && (detail.version === null || isSecret(detail.version)) && [null, 'unavailable'].includes(detail.error) && Array.isArray(detail.messages)
      && detail.messages.length <= (permissions.content ? 20 : 0));
    const messages = detail.messages.map(message => {
      requireRemote(exact(message, ['role', 'text', 'at']) && ['user', 'assistant'].includes(message.role) && text(message.text, 1000) && nullableCount(message.at));
      return { role: message.role, text: redact(message.text), at: message.at };
    });
    const activity = events(detail.events, permissions.content ? 20 : 0);
    requireRemote(detail.error !== null || permissions.content && ids.has(detail.id) && sessions.find(session => session.id === detail.id).version === detail.version);
    requireRemote(detail.error === null || !messages.length && !activity.length);
    details = { ...detail, messages, events: activity };
  }
  let metrics = null;
  if (value.metrics !== null) {
    const metric = value.metrics;
    requireRemote(permissions.systemMetrics && exact(metric, ['sampledAt', 'cpuPct', 'memory']) && count(metric.sampledAt)
      && (metric.cpuPct === null || Number.isFinite(metric.cpuPct) && metric.cpuPct >= 0 && metric.cpuPct <= 100)
      && exact(metric.memory, ['total', 'used', 'free']) && ['total', 'used', 'free'].every(key => count(metric.memory[key]))
      && metric.memory.total > 0 && metric.memory.used + metric.memory.free === metric.memory.total);
    metrics = { sampledAt: metric.sampledAt, cpuPct: metric.cpuPct, memory: { ...metric.memory } };
  }
  requireRemote(Array.isArray(value.quotas) && value.quotas.length <= (permissions.accountQuota ? 40 : 0));
  const quotas = value.quotas.map(quota => {
    requireRemote(exact(quota, ['provider', 'source', 'at', 'sessionId', 'windows']) && quota.provider === 'codex' && quota.source === 'session-log'
      && count(quota.at) && ids.has(quota.sessionId) && Array.isArray(quota.windows) && quota.windows.length <= 2);
    return { ...quota, windows: quota.windows.map(window => {
      requireRemote(exact(window, ['key', 'usedPct', 'minutes', 'resetsAt']) && ['primary', 'secondary'].includes(window.key)
        && Number.isFinite(window.usedPct) && window.usedPct >= 0 && window.usedPct <= 100 && nullableCount(window.minutes) && nullableCount(window.resetsAt));
      return { ...window };
    }) };
  });
  requireRemote(exact(value.discovery, ['limited', 'partial']) && typeof value.discovery.limited === 'boolean' && typeof value.discovery.partial === 'boolean');
  return { schema: 2, scopeId: value.scopeId, revision: value.revision, permissions, sampledAt: value.sampledAt,
    availability: value.availability, sessions, details, metrics, quotas, discovery: { ...value.discovery } };
}
export function dObservationMessage(snapshot) {
  const stats = { read: 0, edit: 0, cmd: 0, prompts: 0 }, feed = [];
  const sessions = snapshot.sessions.map(session => {
    for (const key of ['read', 'edit', 'cmd']) stats[key] += session.counts[key];
    for (const event of session.events) feed.push({ id: `${session.id}:${session.version}:${feed.length}`, sess: session.id, name: session.name,
      ts: event.at || session.updatedAt || snapshot.sampledAt, type: event.type === 'cmd' ? 'bash' : event.type, label: event.label });
    return { id: session.id, sid: session.id, agent: session.provider, name: session.name, title: session.name, dir: session.project,
      projectId: session.projectId, status: session.status === 'work' ? 'work' : 'rest', lastAt: session.updatedAt || 0,
      taskStart: session.status === 'work' ? session.updatedAt : 0, createdAt: session.updatedAt || 0,
      last: session.events.length ? { type: session.events.at(-1).type === 'cmd' ? 'bash' : session.events.at(-1).type, label: session.events.at(-1).label } : null,
      usage: { model: session.model || session.provider, in: session.inputTokens, out: session.outputTokens, ctx: session.contextUsed, ctxMax: session.contextMax, cost: null, at: session.updatedAt },
      counts: session.counts, subs: [], doneSubs: [], todos: [], observed: true,
      observation: { status: session.status, partial: session.partial, content: snapshot.permissions.content, sampledAt: snapshot.sampledAt } };
  });
  return { k: 'snap', sessions, stats, feed: feed.sort((a, b) => a.ts - b.ts).slice(-100) };
}
