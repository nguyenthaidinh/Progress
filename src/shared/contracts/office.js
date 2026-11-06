// Internal live-data contract. Legacy payloads retain their shape; this is not a remote command protocol.
export const OFFICE_PROTOCOL_VERSION = 1;
export const OFFICE_SOURCES = Object.freeze(['local-http', 'browser-log', 'demo', 'encrypted-relay']);
export const CONNECTION_STATES = Object.freeze(['idle', 'connecting', 'connected', 'reconnecting', 'offline', 'unauthorized', 'closed']);
const CAPABILITIES = ['observe', 'content', 'accountQuota', 'systemMetrics', 'taskStart', 'taskStop', 'approve', 'writeState', 'localAdmin', 'openApp'];
export function officeCapabilities(value = {}) {
  return Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, value?.[key] === true])));
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const session = value => record(value) && id(value.id);
const kinds = new Set(['snap', 'lang', 'sess', 'gone', 'ev', 'stats', 'perm', 'permDone', 'todos', 'phone', 'acctlogin',
  'acctswitch', 'acctmove', 'chat', 'workspace', 'chatact', 'limits', 'sysauto', 'trophies', 'tenure', 'vi']);

// Check the fields the existing renderer dereferences. Provider details remain owned by the local backend.
// Relay inputs will need their own public schema: legacy snapshots can contain local-only connection metadata.
export function isLocalLiveMessage(value) {
  if (!record(value) || !kinds.has(value.k)) return false;
  if (value.k === 'snap') return Array.isArray(value.sessions) && value.sessions.every(session)
    && (value.feed === undefined || Array.isArray(value.feed)) && (value.perms === undefined || Array.isArray(value.perms))
    && (value.todos === undefined || Array.isArray(value.todos));
  if (value.k === 'sess') return session(value.s);
  if (value.k === 'ev') return session(value.s) && record(value.e);
  if (value.k === 'stats') return record(value.stats) && (value.s === undefined || session(value.s));
  if (value.k === 'gone' || value.k === 'permDone') return id(value.id);
  if (value.k === 'perm') return record(value.p) && id(value.p.id);
  if (value.k === 'todos') return Array.isArray(value.todos);
  if (value.k === 'trophies') return record(value.t);
  if (value.k === 'vi') return typeof value.from === 'string' && typeof value.to === 'string';
  return true;
}

export function officePacket(message, source, receivedAt = Date.now()) {
  if (!OFFICE_SOURCES.includes(source) || !Number.isSafeInteger(receivedAt) || receivedAt < 0 || !isLocalLiveMessage(message)) return null;
  return Object.freeze({ version: OFFICE_PROTOCOL_VERSION, source, receivedAt, message });
}
export function isOfficePacket(value, source) {
  return record(value) && value.version === OFFICE_PROTOCOL_VERSION && value.source === source
    && OFFICE_SOURCES.includes(source) && Number.isSafeInteger(value.receivedAt) && value.receivedAt >= 0 && isLocalLiveMessage(value.message);
}
