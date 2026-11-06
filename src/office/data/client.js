import { CONNECTION_STATES, OFFICE_SOURCES, isOfficePacket, officeCapabilities } from '../../shared/contracts/office.js';
import { OFFICE_OPERATIONS, OfficeApiError, authorizeApiOperation, resolveApiOperation } from '../../shared/contracts/api.js';

// Owns one source and subscription. API calls follow the source lifetime, independently of stream reconnects.
// Replacing/closing a source invalidates callbacks even if its transport ignores cancellation.
export function createOfficeClient() {
  const events = new Set(), states = new Set(), requests = new Set();
  let generation = 0, revision = 0, cleanup = null, current = null, context = null, latestPacket = null;
  let snapshot = Object.freeze({ source: null, status: 'idle', receivedAt: null, capabilities: officeCapabilities() });
  function update(changes) {
    snapshot = Object.freeze({ ...snapshot, ...changes });
    for (const listener of states) listener(snapshot);
  }
  function stop() {
    generation++; latestPacket = null;
    const close = cleanup; cleanup = null;
    close?.();
  }
  function selectSource(adapter) {
    if (!adapter || !OFFICE_SOURCES.includes(adapter.source) || typeof adapter.subscribe !== 'function') throw new TypeError('Invalid office source');
    if (current === adapter) return;
    stop();
    for (const request of requests) if (!request.detached) request.controller.abort();
    current = adapter; latestPacket = null; context = Object.freeze({ source: adapter.source, revision: ++revision });
    update({ source: adapter.source, status: 'idle', receivedAt: null, capabilities: officeCapabilities(adapter.capabilities) });
  }
  const client = {
    get state() { return snapshot; },
    get context() { return context; },
    get latestPacket() { return latestPacket; },
    selectSource,
    can(name) {
      if (!current || !Object.hasOwn(OFFICE_OPERATIONS, name)) return false;
      try { authorizeApiOperation({ name, operation: OFFICE_OPERATIONS[name] }, current.source, current.capabilities); return true; } catch { return false; }
    },
    resourceUrl(name, values) {
      if (!current || typeof current.resourceUrl !== 'function') throw new OfficeApiError('unavailable');
      const spec = resolveApiOperation(name, values);
      authorizeApiOperation(spec, current.source, current.capabilities);
      if (!spec.operation.resource) throw new OfficeApiError('unsupported');
      const url = current.resourceUrl(name, spec.params);
      if (typeof url !== 'string' || !url.startsWith(`${spec.operation.path}?`)) throw new OfficeApiError('invalidResponse');
      return url;
    },
    subscribe(listener) { events.add(listener); return () => events.delete(listener); },
    subscribeState(listener) { states.add(listener); listener(snapshot); return () => states.delete(listener); },
    connect(adapter = current) {
      selectSource(adapter);
      if (current !== adapter) return;
      if (cleanup) return;
      const run = generation;
      update({ source: adapter.source, status: 'connecting', receivedAt: null, capabilities: officeCapabilities(adapter.capabilities) });
      if (run !== generation) return;
      try {
        const close = adapter.subscribe({
          onEvent(packet) {
            if (run !== generation || !isOfficePacket(packet, adapter.source)) return;
            latestPacket = packet;
            update({ receivedAt: packet.receivedAt, capabilities: officeCapabilities(adapter.capabilities) });
            for (const listener of events) { if (run !== generation) break; listener(packet); }
          },
          onStatus(status) { if (run === generation && CONNECTION_STATES.includes(status)) update({ status, capabilities: officeCapabilities(adapter.capabilities) }); },
        });
        if (typeof close !== 'function') throw new TypeError('Office subscription must return a cleanup function');
        if (run === generation) cleanup = close; else close();
      } catch (error) {
        if (run === generation) { stop(); update({ status: 'offline', capabilities: officeCapabilities() }); }
        throw error;
      }
    },
    reconnect() { stop(); if (current) client.connect(current); },
    close() {
      stop(); current = null; context = null; latestPacket = null;
      for (const request of requests) if (!request.detached) request.controller.abort();
      update({ status: 'closed', capabilities: officeCapabilities() });
    },
    async request(name, params = {}, options = {}) {
      const source = current, origin = context;
      if (options.context && options.context !== origin) throw new OfficeApiError('sourceChanged');
      if (!source || typeof source.request !== 'function') throw new OfficeApiError('unavailable');
      const spec = resolveApiOperation(name, params);
      authorizeApiOperation(spec, source.source, source.capabilities);
      const detached = options.keepalive === true && name === 'presence.update' && spec.params.focused === false;
      if (options.keepalive && !detached) throw new OfficeApiError('invalid');
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const controller = new AbortController(), abort = () => controller.abort();
      const request = { controller, detached }; requests.add(request);
      options.signal?.addEventListener('abort', abort, { once: true });
      const check = () => {
        if (origin !== context) throw new OfficeApiError('sourceChanged');
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      };
      try {
        const response = await source.request(name, spec.params, { ...options, signal: controller.signal });
        check();
        return Object.freeze({ ok: response.ok, status: response.status, json: async () => {
          check(); const data = await response.json(); check(); return data;
        } });
      } catch (error) { check(); throw error; }
      finally { requests.delete(request); options.signal?.removeEventListener('abort', abort); }
    },
  };
  return Object.freeze(client);
}
