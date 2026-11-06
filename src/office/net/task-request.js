// Send a task once; a manual retry reuses its identifier after a lost response or page reload. Only identifiers and
// SHA-256 digests enter session storage, never prompt text, images or credentials. Reconciliation performs reads only.
import { officeContext, officeRequest } from './api.js';
import { t as tr } from '../../i18n/index.js';

const KEY = 'office-pending-task-requests', pending = new Map(), sending = new Map();
try {
  for (const r of JSON.parse(sessionStorage.getItem(KEY) || '[]').slice(0, 50)) {
    if (/^[a-f0-9]{64}$/.test(r.digest) && /^[a-f0-9-]{36}$/.test(r.id)) pending.set(r.digest, r.id);
  }
} catch { /* storage unavailable */ }
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify([...pending].filter(([digest]) => /^[a-f0-9]{64}$/.test(digest)).map(([digest, id]) => ({ digest, id })))); return true; } catch { return false; } };
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const taskRequestMessage = (r) => r?.message || tr(`chat.task.${[
  'requestId', 'requestPending', 'requestUncertain', 'requestUnknown', 'requestConflict', 'requestStore', 'requestCapacity', 'requestBrowserStore',
].includes(r?.code) ? r.code : 'unreachable'}`);

export async function sendTaskRequest(body, operation = 'start') {
  let context;
  try { context = officeContext(); } catch (error) { return { ok: false, code: 'requestUnknown', message: error.message }; }
  const serialized = JSON.stringify({ operation, body: Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))) });
  const digest = crypto.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized)))].map((x) => x.toString(16).padStart(2, '0')).join('') : serialized;
  if (sending.has(digest)) return sending.get(digest);
  if (!pending.has(digest) && pending.size >= 50) return { ok: false, code: 'requestCapacity' };
  const requestId = pending.get(digest) || uuid(); pending.set(digest, requestId);
  const stored = save();
  if (crypto.subtle && !stored) return { ok: false, code: 'requestBrowserStore' };
  const work = (async () => {
    let result;
    try {
      const response = await officeRequest(operation === 'steer' ? 'tasks.steer' : 'tasks.start', { ...body, requestId }, { context });
      result = await response.json();
    } catch (error) {
      if (['forbidden', 'invalid', 'unsupported', 'unavailable'].includes(error.code)) return { ok: false, code: error.code === 'forbidden' ? 'notAllowed' : 'requestUnknown', message: error.message };
      // A network error says nothing about whether the PC received the prompt. Never generate a replacement ID.
      try {
        if (officeContext() !== context) return { ok: false, code: 'requestUnknown' };
        const response = await officeRequest('tasks.receipt', { id: requestId }, { context, timeoutMs: 10000 });
        const receipt = await response.json();
        result = receipt.state === 'done' ? { ...receipt.result, requestState: 'done' } : { ok: false, code: receipt.state === 'pending' ? 'requestPending' : receipt.state === 'uncertain' ? 'requestUncertain' : 'requestUnknown' };
      } catch { result = { ok: false, code: 'requestUnknown' }; }
    }
    if (result?.ok || result?.requestState === 'done') { pending.delete(digest); save(); }
    return result;
  })();
  sending.set(digest, work);
  try { return await work; } finally { sending.delete(digest); }
}
