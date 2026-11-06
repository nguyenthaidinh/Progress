import { isLocalLiveMessage, officeCapabilities, officePacket } from '../../shared/contracts/office.js';
import { createLocalApi, createLocalResourceUrl } from './local-api.js';

// Local source with named APIs and grants derived from backend snapshots. Browser EventSource owns SSE reconnection;
// long-poll owns one request, one retry/visibility wait and a request deadline, all cancelled together.
export function createLocalHttpSource({ token = '', polling = false, fetch: fetcher = globalThis.fetch,
  EventSource: Stream = globalThis.EventSource, document: page = globalThis.document, now = Date.now,
  retryMs = 1000, requestTimeoutMs = 35000 } = {}) {
  const query = new URLSearchParams(); if (token) query.set('k', token);
  const reads = { observe: true, content: true, accountQuota: true, systemMetrics: true };
  let capabilities = officeCapabilities(reads), owner = false, known = false, tasks = false, approve = false;
  function resetPermissions() { known = owner = tasks = approve = false; capabilities = officeCapabilities(reads); }
  function permissions(message) {
    if (message.k === 'snap') {
      known = typeof message.local === 'boolean'; owner = known && message.local;
      tasks = known && message.phoneTasks === true; approve = known && message.phoneApprove === true;
    } else if (message.k === 'phone') { tasks = message.tasks === true; approve = message.approve === true; }
    capabilities = officeCapabilities({ ...reads, writeState: known, localAdmin: known && owner,
      taskStart: known && (owner || tasks), taskStop: known && (owner || tasks), openApp: known && (owner || tasks), approve: known && (owner || approve) });
  }
  return Object.freeze({
    source: 'local-http',
    get capabilities() { return capabilities; },
    request: createLocalApi({ token, fetch: fetcher, capabilities: () => capabilities }),
    resourceUrl: createLocalResourceUrl({ token, capabilities: () => capabilities }),
    subscribe({ onEvent, onStatus }) {
      let active = true, stream = null, request = null, deadline = null, resume = null, hasSnapshot = false;
      function deliver(message, updatePermissions = true) {
        if (!active || !isLocalLiveMessage(message) || !hasSnapshot && message.k !== 'snap') return false;
        if (message.k === 'snap') hasSnapshot = true;
        if (updatePermissions) permissions(message);
        onEvent(officePacket(message, 'local-http', now()));
        if (active) onStatus('connected');
        return true;
      }
      function close() {
        if (!active) return;
        active = false;
        resetPermissions();
        if (stream) { stream.onopen = stream.onerror = stream.onmessage = null; stream.close(); }
        request?.abort(); clearTimeout(deadline); resume?.();
      }
      function wait(visible, ms) {
        return new Promise(resolve => {
          let timer;
          const finish = () => { clearTimeout(timer); page?.removeEventListener('visibilitychange', changed); resume = null; resolve(); };
          const changed = () => { if (!page?.hidden) finish(); };
          resume = finish;
          if (visible) page.addEventListener('visibilitychange', changed); else timer = setTimeout(finish, ms);
        });
      }
      async function poll() {
        let since = -1, failures = 0;
        while (active) {
          if (page?.hidden) await wait(true);
          if (!active) break;
          const params = new URLSearchParams(query); params.set('since', String(since));
          const controller = new AbortController(); request = controller;
          deadline = setTimeout(() => controller.abort(), requestTimeoutMs);
          let batch;
          try {
            const response = await fetcher(`/api/live?${params}`, { cache: 'no-store', signal: request.signal });
            if (!active) break;
            if (response.status === 401 || response.status === 403) { close(); capabilities = officeCapabilities(); onStatus('unauthorized'); break; }
            if (!response.ok) throw new Error('Live response failed');
            batch = await response.json();
            const reset = batch?.msgs?.[0]?.k === 'snap';
            if (!Number.isSafeInteger(batch?.seq) || batch.seq < 0 || !Array.isArray(batch.msgs)
              || !batch.msgs.every(isLocalLiveMessage) || !hasSnapshot && !reset
              || !reset && (batch.seq < since || batch.seq === since && batch.msgs.length > 0)) throw new Error('Invalid live batch');
          } catch {
            if (!active) break;
            capabilities = officeCapabilities(reads); onStatus('reconnecting');
            clearTimeout(deadline); request = null;
            if (!active) break;
            await wait(false, Math.min(15000, retryMs * 2 ** Math.min(failures++, 4)));
            continue;
          } finally { clearTimeout(deadline); }
          if (!active) break;
          request = null; since = batch.seq; failures = 0;
          // Apply the batch's final grant state before any UI callback can issue another operation.
          for (const message of batch.msgs) permissions(message);
          if (batch.msgs.length === 0) permissions({});
          for (const message of batch.msgs) { if (!active) break; deliver(message, false); }
          if (active && hasSnapshot) onStatus('connected');
          // A broken proxy returning empty batches immediately must not cause a hot request loop.
          if (active && batch.msgs.length === 0) await wait(false, 250);
        }
      }
      onStatus('connecting');
      if (polling || typeof Stream !== 'function') {
        void poll().catch(() => { if (active) { onStatus('offline'); close(); } });
      } else {
        stream = new Stream(`/stream${query.size ? `?${query}` : ''}`);
        stream.onopen = () => { if (active) { hasSnapshot = false; resetPermissions(); onStatus('connecting'); } };
        stream.onerror = () => { if (active) { hasSnapshot = false; resetPermissions(); onStatus(stream.readyState === 2 ? 'offline' : 'reconnecting'); } };
        stream.onmessage = event => {
          if (!active || typeof event.data !== 'string') return;
          let message; try { message = JSON.parse(event.data); } catch { return; }
          deliver(message);
        };
      }
      return close;
    },
  });
}
