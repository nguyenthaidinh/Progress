// Authenticated C/D observation with a bounded in-memory log cache. It cannot forward command operations.
import { createIdentity, randomSecret, seal, open, requireRemote, RemoteError } from '../../shared/remote/crypto.js';
import { invitation, validateFrame, publicObservation, observationMessage, OBSERVATION_FRESH_MS } from '../../shared/remote/contract.js';
import { relayTransport } from '../../shared/remote/transport.js';
import { officeCapabilities, officePacket } from '../../shared/contracts/office.js';
import { OfficeApiError } from '../../shared/contracts/api.js';
import { publicDObservation, dObservationMessage, validatePermissions } from '../../shared/remote/observation-v2.js';
import { createObservationCache, remoteSummary } from './observation-cache.js';
export async function createBrowserPair(invite) {
  const verified = await invitation(invite);
  return { version: 1, relay: verified.relay, route: verified.route, token: verified.token, connector: verified.connector,
    claim: verified.claim, expires: verified.expires, paired: false, projectId: null, identity: await createIdentity(), ...(verified.protocol === 2 && { protocol: 2, revision: 1 }) };
}
const delay = (signal, ms = 1000) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});
export function createEncryptedRelaySource({ record, save, fetch: fetcher = globalThis.fetch, now = Date.now, onState = () => {}, onObservation = () => {}, deferObservation = false }) {
  const transport = relayTransport({ relay: record.relay, route: record.route, token: record.token, fetch: fetcher });
  let caps = officeCapabilities(), cached = null, currentCleanup = null, rendererReady = !deferObservation, disposed = false, activate, viewGeneration = 0;
  const protocol = record.protocol === 2 ? 2 : 1, permission = () => protocol === 2 ? record.revision : 1;
  let sendRead = null;
  const detailCache = createObservationCache(body => { if (!sendRead) throw new OfficeApiError('unavailable'); return sendRead(body); });
  const source = {
    source: 'encrypted-relay',
    get capabilities() { return caps; },
    markRendererReady() { if (!disposed) { rendererReady = true; activate?.(); } },
    dispose() { disposed = true; currentCleanup?.(); record.identity = null; record.token = null; activate = null; },
    async request(name, params, options = {}) {
      if (disposed || !caps.content || name !== 'log.read' || params.agent) throw new OfficeApiError('unavailable');
      const generation = viewGeneration;
      const response = data => ({ ok: true, status: 200, json: async () => {
        if (disposed || !caps.content || generation !== viewGeneration) throw new OfficeApiError('unavailable');
        return data;
      } });
      if (protocol === 2) return response(await detailCache.read(params.id, options.signal));
      const session = cached?.sessions.find(s => s.id === params.id);
      if (!session) throw new OfficeApiError('unavailable');
      const data = { ok: true, items: session.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'claude', text: m.text, ts: m.at || session.updatedAt })) };
      return response(data);
    },
    subscribe({ onEvent, onStatus }) {
      if (disposed) { onStatus('closed'); return () => {}; }
      currentCleanup?.();
      const controller = new AbortController(); let epoch, sequence = -1, inputSeq = 0, pendingRead = null, sendingRead = false, paired = false, readySent = false, readyAt = 0, lastReceived = 0, helloAt = 0, closed = false, restartRequested = false, failures = 0, lockRelease, pollAbort;
      const empty = () => {
        viewGeneration++;
        caps = officeCapabilities(); cached = null; detailCache.clear(); onObservation(null); sendRead = null; pendingRead = null;
        onEvent(officePacket({ k: 'snap', sessions: [], feed: [], stats: {} }, source.source, now()));
      };
      const status = value => { if (!closed) { onState(value); onStatus(value); } };
      async function flushReads() {
        if (sendingRead) return; sendingRead = true;
        try { while (pendingRead && !closed) {
          const intent = pendingRead; pendingRead = null;
          if (intent.epoch !== epoch || !caps.content) continue;
          try {
            const ciphertext = await seal({ v: 2, type: 'read', route: record.route, epoch, seq: ++inputSeq, permission: permission(), body: intent.body }, record.identity, record.connector, now());
            if (closed || intent.epoch !== epoch) continue;
            await transport.call('send', ciphertext, controller.signal);
          } catch { if (!closed && intent.epoch === epoch) { empty(); status('offline'); pollAbort?.abort(); } }
        } } finally { sendingRead = false; }
      }
      async function hello() {
        requireRemote(record.paired || record.expires > now(), 'invite');
        restartRequested = false;
        epoch = randomSecret(); sequence = -1; paired = false;
        readySent = false; lastReceived = 0; inputSeq = 0;
        helloAt = now();
        const ciphertext = await seal({ v: protocol, type: 'hello', route: record.route, epoch, seq: 0, permission: permission(),
          body: { claim: record.claim, public: record.identity.public } }, record.identity, record.connector, now());
        await transport.call('send', ciphertext, controller.signal);
      }
      async function ready() {
        if (closed || !paired || !rendererReady || readySent) return;
        readySent = true; readyAt = now();
        const ciphertext = await seal({ v: protocol, type: 'ready', route: record.route, epoch, seq: 0, permission: permission(), body: {} }, record.identity, record.connector, now());
        if (!closed) await transport.call('send', ciphertext, controller.signal);
      }
      activate = () => { void ready().catch(() => status('offline')); };
      async function receive(ciphertext) {
        const { payload: frame } = await open(ciphertext, record.identity, record.connector, now());
        if (closed || restartRequested) return;
        validateFrame(frame, record.route, record.identity.public.id, { protocol, permission: protocol === 2 && frame.type === 'paired' ? null : permission() });
        requireRemote(frame.epoch === epoch, 'epoch');
        if (frame.seq <= sequence) throw new RemoteError('replay');
        requireRemote(frame.seq === sequence + 1, 'sequence');
        if (frame.type === 'paired') {
          const scope = protocol === 2 ? frame.body.scopeId : frame.body.projectId;
          requireRemote(!paired && frame.seq === 0 && (!record.projectId || scope === record.projectId) && frame.permission >= permission(), 'scope');
          if (protocol === 2) { record.permissions = validatePermissions(frame.body.permissions); record.revision = frame.permission; }
          record.paired = true; record.claim = null; record.projectId = scope;
          await save(record); if (closed) return; paired = true; onState('authenticated'); onStatus('connecting'); await ready();
        } else if (frame.type === 'observe') {
          requireRemote(paired && readySent && (protocol === 2 ? frame.body.scopeId : frame.body.projectId) === record.projectId && frame.body.sampledAt >= now() - OBSERVATION_FRESH_MS && frame.body.sampledAt <= now() + 15000, 'stale');
          if (protocol === 2) {
            cached = publicDObservation(frame.body);
            requireRemote(cached.revision === record.revision && JSON.stringify(cached.permissions) === JSON.stringify(record.permissions), 'scope');
            const available = cached.availability !== 'unavailable';
            caps = officeCapabilities({ observe: available, content: available && cached.permissions.content, accountQuota: cached.permissions.accountQuota, systemMetrics: cached.permissions.systemMetrics });
            detailCache.apply(cached); onObservation(remoteSummary(cached));
            sendRead = body => {
              if (closed || !caps.content) throw new OfficeApiError('unavailable');
              pendingRead = { body, epoch }; void flushReads();
            };
          } else { cached = publicObservation(frame.body); caps = officeCapabilities({ observe: true, content: true }); }
          lastReceived = now();
          sequence = frame.seq; failures = 0;
          onEvent(officePacket(protocol === 2 ? dObservationMessage(cached) : observationMessage(cached), source.source, now())); status('connected');
          // A signed/encrypted receipt controls observation backpressure; it cannot grant any execution capability.
          const receipt = await seal({ v: protocol, type: 'seen', route: record.route, epoch, seq: frame.seq, permission: permission(), body: {} }, record.identity, record.connector, now());
          if (!closed) await transport.call('send', receipt, controller.signal);
        } else if (frame.type === 'changed') { throw new RemoteError('scopeChanged'); }
        else if (frame.type === 'revoked') { throw new RemoteError('revoked'); }
        else throw new RemoteError('operation');
        sequence = frame.seq;
      }
      async function run() {
        status('connecting');
        while (!closed) {
          try {
            await hello();
            while (!closed && !restartRequested) {
              pollAbort = new AbortController();
              const data = await transport.call('poll', null, AbortSignal.any([controller.signal, pollAbort.signal]));
              if (closed || restartRequested) break;
              if (data.ciphertext) {
                try { await receive(data.ciphertext); }
                catch (error) { if (['sequence', 'revoked', 'scopeChanged'].includes(error.code)) throw error; /* Invalid/old/replayed envelopes do not renew freshness. */ }
              } else if (!paired ? now() - helloAt > 15000 : readySent && now() - (lastReceived || readyAt) > OBSERVATION_FRESH_MS) break;
            }
          } catch (error) {
            if (closed) break;
            if (error.code === 'invite') { empty(); status('unauthorized'); break; }
          }
          if (!closed) { empty(); status('offline'); await delay(controller.signal, Math.min(15000, 1000 * 2 ** Math.min(failures++, 4))); }
        }
      }
      // A mailbox belongs to one active tab. A second tab cannot steal its poll/epoch.
      if (globalThis.navigator?.locks) {
        void navigator.locks.request(`lioops:${record.route}`, { ifAvailable: true }, async lock => {
          if (!lock || closed) { status('offline'); return; }
          const released = new Promise(resolve => { lockRelease = resolve; });
          void run(); await released;
        }).catch(() => status('offline'));
      } else void run();
      const invalidate = value => {
        restartRequested = true; epoch = null; paired = false; readySent = false; lastReceived = 0;
        empty(); status(value); pollAbort?.abort();
      };
      const wake = () => {
        if (!closed && globalThis.document?.visibilityState === 'visible' && lastReceived && now() - lastReceived > OBSERVATION_FRESH_MS) {
          invalidate('reconnecting');
        }
      };
      globalThis.document?.addEventListener('visibilitychange', wake);
      const staleTimer = setInterval(() => { if (!closed && lastReceived && now() - lastReceived > OBSERVATION_FRESH_MS) invalidate('offline'); }, 1000);
      const cleanup = () => { if (closed) return; empty(); closed = true; controller.abort(); clearInterval(staleTimer); lockRelease?.(); globalThis.document?.removeEventListener('visibilitychange', wake); };
      currentCleanup = cleanup;
      return cleanup;
    },
  };
  return Object.freeze(source);
}
