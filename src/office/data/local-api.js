import { OfficeApiError, authorizeApiOperation, resolveApiOperation } from '../../shared/contracts/api.js';

function localUrl(spec, token) {
  const query = new URLSearchParams(); if (token) query.set('k', token);
  if (spec.operation.method === 'GET') for (const [key, value] of Object.entries(spec.params)) query.set(key, String(value));
  return `${spec.operation.path}${query.size ? `?${query}` : ''}`;
}
// Local image resources retain native lazy loading. Other sources must implement their own resource transport.
export function createLocalResourceUrl({ token = '', capabilities }) {
  return (name, values) => {
    const spec = resolveApiOperation(name, values);
    authorizeApiOperation(spec, 'local-http', capabilities());
    if (!spec.operation.resource) throw new OfficeApiError('unsupported');
    return localUrl(spec, token);
  };
}

// A named operation selects the method/path. Caller data cannot supply a URL, headers, credentials or HTTP method.
export function createLocalApi({ token = '', fetch: fetcher = globalThis.fetch, capabilities }) {
  return async function request(name, values, options = {}) {
    const spec = resolveApiOperation(name, values), { operation, params } = spec;
    authorizeApiOperation(spec, 'local-http', capabilities());
    if (operation.resource) throw new OfficeApiError('unsupported');
    const keepalive = options.keepalive === true;
    if (keepalive && (name !== 'presence.update' || params.focused !== false)) throw new OfficeApiError('invalid');
    const timeoutMs = options.timeoutMs ?? operation.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 150000) throw new OfficeApiError('invalid');
    const body = operation.method === 'POST' ? JSON.stringify(params) : undefined;
    if (body && new TextEncoder().encode(body).length > 8000000) throw new OfficeApiError('invalid');
    const controller = new AbortController(), abort = () => controller.abort();
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    options.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetcher(localUrl(spec, token), {
        method: operation.method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { body }), signal: controller.signal, keepalive,
      });
      let data; try { data = await response.json(); } catch { throw new OfficeApiError('invalidResponse'); }
      // Decode before returning so cancellation/source checks cover the response body too.
      return Object.freeze({ ok: response.ok, status: response.status, json: async () => data });
    } catch (error) {
      if (timedOut) throw new OfficeApiError('timeout');
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error instanceof OfficeApiError) throw error;
      throw new OfficeApiError('unreachable');
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    }
  };
}
