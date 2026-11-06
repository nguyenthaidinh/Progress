// Named legacy operations. Only the local adapter has an implementation; these paths are never relay RPC input.
export class OfficeApiError extends Error {
  constructor(code) { super(code); this.name = 'OfficeApiError'; this.code = code; }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (max = 4000) => value => typeof value === 'string' && value.length <= max;
const nonempty = (max = 512) => value => text(max)(value) && value.length > 0;
const bool = value => typeof value === 'boolean';
const number = value => Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const oneOf = (...values) => value => values.includes(value);
const list = (check, max = 100) => value => Array.isArray(value) && value.length <= max && value.every(item => check(item));
const nullable = check => value => value === null || check(value);
function json(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean' || number(value) || text(8000000)(value)) return true;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => json(item, depth + 1));
  return record(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([key, item]) =>
    !['__proto__', 'constructor', 'prototype'].includes(key) && (item === undefined || json(item, depth + 1)));
}
const id = nonempty(), uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
const image = value => text(8000000)(value) && /^data:image\/(?:png|jpeg|webp);base64,/.test(value);
const task = { requestId: uuid, text: text(16000), sid: nonempty(2000), dir: nonempty(4000), task: id,
  agent: oneOf('claude', 'codex'), images: list(image, 4), model: text(200), effort: text(64), fresh: bool,
  chat: bool, workspace: bool, conversationId: id };
const define = (method, path, capability, fields = {}, required = [], extra = {}) => Object.freeze({
  method, path, capability, fields: Object.freeze(fields), required: Object.freeze(required),
  access: method === 'GET' ? 'read' : capability === 'localAdmin' ? 'admin' : ['taskStart', 'taskStop', 'approve', 'openApp'].includes(capability) ? 'execute' : 'write',
  localOnly: capability === 'localAdmin', timeoutMs: 30000, ...extra,
});
const get = (path, fields = {}, capability = 'observe', required = [], extra = {}) => define('GET', path, capability, fields, required, extra);
const post = (path, capability, fields, required = [], extra = {}) => define('POST', path, capability, fields, required, extra);
const tagged = (path, op, capability, fields, required = [], extra = {}) => post(path, capability,
  { op: oneOf(op), ...fields }, required, { defaults: Object.freeze({ op }), ...extra });

export const OFFICE_OPERATIONS = Object.freeze({
  'tasks.metadata': get('/api/tasks', {}, 'accountQuota'),
  'tasks.receipt': get('/api/tasks/request', { id: uuid }, 'observe', ['id']),
  'workspace.read': get('/api/workspace', { id, source: nonempty(2000) }, 'content'),
  'log.read': get('/api/log', { id, agent: text(1000) }, 'content', ['id']),
  'image.read': get('/api/image', { id }, 'content', ['id'], { resource: true }),
  'history.burn': get('/api/burn', { range: text(32) }),
  'history.wrapped': get('/api/wrapped'),
  'history.replay': get('/api/replay', { day: value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), from: integer, to: integer }, 'content'),
  'history.timeline': get('/api/timeline', { from: integer, to: integer }, 'content'),
  'system.read': get('/api/sys', { open: oneOf('1', '0') }, 'systemMetrics'),
  'cache.read': get('/api/cache'),
  'quick.read': get('/api/quick'),
  'chat.read': get('/api/chat', {}, 'content'),
  'loop.read': get('/api/loop'),
  'tenure.read': get('/api/tenure'),
  'stranded.read': get('/api/stranded', {}, 'content'),
  'provider.version': get('/api/claude-version'),
  'tunnel.read': get('/api/tunnel', {}, 'localAdmin'),
  'push.read': get('/api/push', { endpoint: text(4000) }),
  'tasks.start': post('/api/tasks', 'taskStart', task, ['requestId', 'text'], { timeoutMs: 150000, target: ['sid', 'dir', 'conversationId'] }),
  'tasks.steer': post('/api/tasks/steer', 'taskStart', task, ['requestId', 'text'], { timeoutMs: 150000, target: ['task', 'sid', 'dir', 'conversationId'] }),
  'tasks.stop': post('/api/tasks/stop', 'taskStop', { id }, ['id']),
  'tasks.openCodex': post('/api/tasks/open-codex', 'openApp', { sid: nonempty(2000) }, ['sid']),
  'tasks.desktop': post('/api/tasks/desktop', 'localAdmin', { on: bool }, ['on']),
  'tasks.allow': post('/api/tasks/allow', 'localAdmin', { on: bool }, ['on']),
  'tasks.background': post('/api/tasks/bg', 'localAdmin', { on: bool }, ['on']),
  'prompt.rewrite': post('/api/prompt/rewrite', 'taskStart', { text: text(16000), lang: oneOf('en', 'vi'), photos: integer }, ['text'], { timeoutMs: 90000 }),
  'permissions.answer': post('/api/perm', 'approve', { id, choice: oneOf('allow', 'always', 'deny', 'answer', 'approve', 'revise', 'skip'), answers: json, note: text(4000) }, ['id', 'choice']),
  'presence.update': post('/api/presence', 'approve', { page: nonempty(64), focused: bool }, ['page', 'focused']),
  'cache.write': post('/api/cache', 'localAdmin', { nudge: bool }, ['nudge']),
  'preferences.language': post('/api/prefs', 'writeState', { lang: oneOf('en', 'vi') }, ['lang']),
  'quick.write': post('/api/quick', 'writeState', { list: list(json, 12) }, ['list']),
  'todos.write': post('/api/todos', 'writeState', { op: oneOf('add', 'toggle', 'edit', 'del', 'clear'), id, text: text(4000), done: bool }, ['op']),
  'loop.stop': tagged('/api/loop', 'stop', 'taskStop', { id }, ['id']),
  'loop.hint': tagged('/api/loop', 'hint', 'taskStart', { id, text: text(4000) }, ['id', 'text']),
  'loop.config': tagged('/api/loop', 'config', 'localAdmin', { on: bool, n: integer, min: integer }),
  'tenure.config': tagged('/api/tenure', 'config', 'localAdmin', { days: integer }, ['days']),
  'tenure.official': tagged('/api/tenure', 'official', 'localAdmin', { name: text(200) }, ['name']),
  'tenure.farewell': tagged('/api/tenure', 'farewell', 'localAdmin', { name: text(200) }, ['name']),
  'stranded.open': post('/api/stranded/open', 'localAdmin', { id }, ['id']),
  'stranded.remove': post('/api/stranded/remove', 'localAdmin', { id }, ['id']),
  'session.open': post('/api/open', 'localAdmin', { id }, ['id']),
  'system.action': post('/api/sys/action', 'localAdmin', { action: oneOf('kill', 'closeIdle', 'quit', 'clean'), target: value => text(4000)(value) || integer(value), start: value => text(1000)(value) || number(value), items: list(json, 200) }, ['action'], { timeoutMs: 60000 }),
  'system.auto': post('/api/sys/auto', 'localAdmin', { hours: oneOf(0, 2, 4, 8) }, ['hours']),
  'accounts.prepare': post('/api/accounts', 'localAdmin', { name: nonempty(256) }, ['name']),
  'accounts.login': post('/api/accounts/login', 'localAdmin', { name: nonempty(256) }, ['name']),
  'accounts.code': post('/api/accounts/code', 'localAdmin', { name: nonempty(256), code: nonempty(1000) }, ['name', 'code']),
  'accounts.cancel': post('/api/accounts/cancel', 'localAdmin', { name: nonempty(256) }, ['name']),
  'accounts.rename': post('/api/accounts/rename', 'localAdmin', { name: text(256), label: text(256) }, ['name', 'label']),
  'accounts.use': post('/api/accounts/use', 'localAdmin', { name: text(256) }, ['name']),
  'accounts.auto': post('/api/accounts/auto', 'localAdmin', { on: bool, move: bool }),
  'accounts.order': post('/api/accounts/order', 'localAdmin', { order: list(text(256), 100) }, ['order']),
  'accounts.move': post('/api/accounts/move', 'localAdmin', { id, to: text(256) }, ['id', 'to']),
  'tunnel.write': post('/api/tunnel', 'localAdmin', { on: bool }, ['on']),
  'lan.write': post('/api/lan', 'localAdmin', { on: bool }, ['on']),
  'pin.rotate': post('/api/pin', 'localAdmin', { pin: text(32) }),
  'pin.change': post('/api/pin', 'writeState', { current: text(32), pin: text(32) }, ['current', 'pin']),
  'phone.approval': post('/api/phone', 'localAdmin', { approve: bool }, ['approve']),
  'remoteControl.write': post('/api/rc', 'localAdmin', { on: bool }, ['on']),
  'chat.send': tagged('/api/chat', 'send', 'writeState', { text: text(16000), sticker: nullable(integer), replyTo: nullable(text(512)) }),
  'chat.react': tagged('/api/chat', 'react', 'writeState', { id, emoji: text(32) }, ['id', 'emoji']),
  'chat.vote': tagged('/api/chat', 'vote', 'writeState', { id, i: integer }, ['id', 'i']),
  'chat.rsvp': tagged('/api/chat', 'rsvp', 'writeState', { id, yes: bool }, ['id', 'yes']),
  'chat.recall': tagged('/api/chat', 'recall', 'writeState', { id }, ['id']),
  'chat.poll': tagged('/api/chat', 'poll', 'writeState', { q: text(4000), opts: list(text(4000), 12) }, ['q', 'opts']),
  'chat.photo': tagged('/api/chat', 'photo', 'localAdmin', { data: image }, ['data']),
  'chat.say': tagged('/api/chat', 'say', 'localAdmin', { from: text(256), text: text(16000), key: text(256), sticker: nullable(integer), photo: nullable(image), pin: bool, delay: number, react: list(text(32), 20), reacts: integer, answer: list(json, 20) }, ['from']),
  'push.add': tagged('/api/push', 'add', 'writeState', { sub: json }, ['sub']),
  'push.remove': tagged('/api/push', 'remove', 'writeState', { endpoint: text(4000) }, ['endpoint']),
  'push.report': tagged('/api/push', 'report', 'writeState', { why: text(100), detail: text(1000) }, ['why']),
  'push.test': tagged('/api/push', 'test', 'writeState', { endpoint: text(4000) }),
});

export function resolveApiOperation(name, values = {}) {
  if (!Object.hasOwn(OFFICE_OPERATIONS, name)) throw new OfficeApiError('unsupported');
  const operation = OFFICE_OPERATIONS[name];
  if (!record(values)) throw new OfficeApiError('invalid');
  const params = { ...operation.defaults };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue; // Match JSON's treatment of optional form fields.
    if (!Object.hasOwn(operation.fields, key) || !operation.fields[key](value)) throw new OfficeApiError('invalid');
    params[key] = value;
  }
  if (operation.required.some(key => params[key] === undefined) || operation.target && !operation.target.some(key => params[key])) throw new OfficeApiError('invalid');
  return { name, operation, params };
}

export function authorizeApiOperation(spec, source, capabilities) {
  // C's only non-local operation reads the already-decrypted log cache; no RPC is sent to the Connector.
  if (source === 'encrypted-relay') {
    if (spec.name !== 'log.read' || capabilities?.content !== true) throw new OfficeApiError('unavailable');
    return;
  }
  if (source !== 'local-http') throw new OfficeApiError('unavailable');
  if (capabilities?.[spec.operation.capability] !== true || spec.operation.localOnly && capabilities?.localAdmin !== true) throw new OfficeApiError('forbidden');
}
