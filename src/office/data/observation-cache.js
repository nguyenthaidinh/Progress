// Only the selected transcript crosses the relay; metadata snapshots cannot turn into a generic RPC channel.
import { OfficeApiError } from '../../shared/contracts/api.js';
import { randomSecret } from '../../shared/remote/crypto.js';
/** @typedef {{revision:number, sampledAt:number, availability:string, permissions:{content:boolean,accountQuota:boolean,systemMetrics:boolean}, sessions:number, unknown:number, partial:boolean, metrics:{sampledAt:number,cpuPct:number|null,memory:{total:number,used:number,free:number}}|null, quotas:Array<{session:string,provider:string,at:number,windows:Array<{key:string,usedPct:number,minutes:number|null,resetsAt:number|null}>}>}} RemoteSummary */
/** @returns {RemoteSummary} */
export function remoteSummary(snapshot) {
  return { revision: snapshot.revision, sampledAt: snapshot.sampledAt, availability: snapshot.availability, permissions: snapshot.permissions, sessions: snapshot.sessions.length,
    unknown: snapshot.sessions.filter(session => session.status === 'unknown').length, partial: snapshot.discovery.limited || snapshot.discovery.partial || snapshot.sessions.some(session => session.partial),
    metrics: snapshot.metrics, quotas: snapshot.quotas.map(quota => ({ session: snapshot.sessions.find(session => session.id === quota.sessionId)?.name || '', provider: quota.provider, at: quota.at, windows: quota.windows })) };
}
export function createObservationCache(sendRead) {
  let snapshot = null; const waiting = new Map();
  function finish(entry, data, error) { clearTimeout(entry.timer); waiting.delete(entry.id); if (error) entry.reject(error); else entry.resolve(data); }
  function log(snapshot, id) {
    const detail = snapshot?.details, session = snapshot?.sessions.find(session => session.id === id);
    if (!detail || detail.id !== id || detail.error || detail.version !== session?.version) return null;
    return { ok: true, partial: session.partial, items: detail.messages.map(message => ({ role: message.role === 'user' ? 'user' : 'claude', text: message.text, ts: message.at || session.updatedAt })) };
  }
  return Object.freeze({
    clear() { snapshot = null; for (const entry of [...waiting.values()]) finish(entry, null, new OfficeApiError('unavailable')); },
    apply(next) {
      snapshot = next;
      for (const entry of [...waiting.values()]) {
        if (!snapshot.permissions.content || !snapshot.sessions.some(session => session.id === entry.id)) { finish(entry, null, new OfficeApiError('unavailable')); continue; }
        if (snapshot.details?.id !== entry.id || snapshot.details.requestId !== entry.requestId) continue;
        const value = log(snapshot, entry.id); finish(entry, value, value ? null : new OfficeApiError('unavailable'));
      }
    },
    async read(id, signal) {
      if (!snapshot?.permissions.content || !snapshot.sessions.some(session => session.id === id)) throw new OfficeApiError('unavailable');
      const cached = log(snapshot, id); if (cached) return cached;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      let entry = waiting.get(id);
      if (!entry) {
        for (const old of [...waiting.values()]) finish(old, null, new OfficeApiError('unavailable'));
        if (waiting.size >= 4) throw new OfficeApiError('unavailable');
        entry = { id, requestId: randomSecret() };
        entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
        entry.timer = setTimeout(() => finish(entry, null, new OfficeApiError('timeout')), 30000);
        waiting.set(id, entry); Promise.resolve().then(() => sendRead({ op: 'log', id, requestId: entry.requestId })).catch(() => {
          if (waiting.get(id) === entry) finish(entry, null, new OfficeApiError('unavailable'));
        });
      }
      return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); }, cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
        entry.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
    },
  });
}
