// Bounded opaque mailbox transport. Never retries a write; the observation handshake may be restarted with a new epoch.
import { secureOrigin, requireRemote, isSecret, WIRE_LIMIT, RemoteError } from './crypto.js';
export function relayTransport({ relay, route, token, fetch: fetcher = globalThis.fetch }) {
  const origin = secureOrigin(relay); requireRemote(isSecret(route) && isSecret(token));
  return Object.freeze({
    async call(action, body, signal) {
      requireRemote(['send', 'poll', 'close'].includes(action));
      const controller = new AbortController(), abort = () => controller.abort();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        if (action === 'send') requireRemote(typeof body === 'string' && body.length <= WIRE_LIMIT);
        const response = await fetcher(`${origin}/v1/routes/${route}/${action}`, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'send' ? { ciphertext: body } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!response.ok) throw new RemoteError(response.status === 401 || response.status === 404 ? 'revoked' : 'offline');
        const reader = response.body?.getReader(); requireRemote(reader, 'response');
        const chunks = []; let size = 0;
        try { while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; requireRemote(size <= WIRE_LIMIT + 2000, 'size'); chunks.push(value);
        } } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const result = JSON.parse(raw); requireRemote(result?.ok === true);
        if (action === 'poll') requireRemote(result.ciphertext === null || typeof result.ciphertext === 'string' && result.ciphertext.length <= WIRE_LIMIT);
        return result;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
  });
}
