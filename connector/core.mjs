// One paired browser: C's selected log or D's explicitly scoped projects. No task/shell/provider-control dispatcher.
import { createIdentity, exportIdentity, importIdentity, randomSecret, isSecret, secureOrigin, tokenHash, seal, open, requireRemote } from '../src/shared/remote/crypto.js';
import { validateFrame, OBSERVATION_RECEIPT_MS } from '../src/shared/remote/contract.js';
import { relayTransport } from '../src/shared/remote/transport.js';
import { readSelectedLog } from './observation.mjs';
import { createProjectObserver } from './project-observer.mjs';
import { scopeIdentity, observationPermissions } from './scope.mjs';
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
});
export async function createConnector({ relay, webURL, adminToken, selection, store, fetch: fetcher = globalThis.fetch, now = Date.now, intervalMs = 3000, metrics, onDiagnostic = () => {} }) {
  const diagnostic = value => { try { onDiagnostic(value); } catch { /* local diagnostics cannot break consent or observation */ } };
  relay = secureOrigin(relay); requireRemote(isSecret(adminToken));
  const web = new URL(webURL); secureOrigin(web.origin); requireRemote(!web.username && !web.password && !web.search && !web.hash);
  let saved = await store.load(), identity;
  const protocol = selection.kind === 'projects' ? 2 : 1;
  if (saved) requireRemote(saved.version === protocol, 'version');
  if (saved && !saved.peer && saved.expires <= now()) {
    try { await relayTransport({ relay: saved.relay, route: saved.route, token: saved.connectorToken, fetch: fetcher }).call('close', null, AbortSignal.timeout(3000)); } catch { /* expired invitation will not authenticate to the replacement identity */ }
    saved = null;
  }
  if (saved && !saved.revoked) {
    requireRemote(saved.relay === relay && saved.webURL === web.href && (protocol === 2 ? scopeIdentity(saved.selection) === scopeIdentity(selection)
      : saved.selection.file === selection.file && saved.selection.dev === selection.dev && saved.selection.ino === selection.ino), 'scope');
    identity = await importIdentity(saved.identity);
  } else {
    identity = await createIdentity({ extractable: true });
    saved = { version: protocol, identity: await exportIdentity(identity), relay, webURL: web.href, selection,
      route: randomSecret(), connectorToken: randomSecret(), browserToken: randomSecret(), claim: randomSecret(),
      expires: now() + 5 * 60000, projectId: randomSecret(), peer: null, revoked: false };
    if (protocol === 2) { saved.revision = 1; saved.catalogKey = randomSecret(); }
    await store.save(saved);
  }
  const transport = relayTransport({ relay, route: saved.route, token: saved.connectorToken, fetch: fetcher });
  const observer = protocol === 2 ? createProjectObserver({ selection: saved.selection, key: saved.catalogKey, scopeId: saved.projectId, metrics, now }) : null;
  const permission = () => protocol === 2 ? saved.revision : 1;
  const controller = new AbortController(), seen = new Map(); let active = null, pending = null, loop, publisher, publishing = false, approving = false, changing = false, permissionWriting = false, revocationSaved = saved.revoked, status = 'idle', writes = Promise.resolve();
  function persist() {
    const value = structuredClone(saved), result = writes.then(() => store.save(value));
    writes = result.catch(() => {}); return result;
  }
  async function register() {
    const response = await fetcher(`${relay}/v1/routes`, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: saved.route, connectorHash: await tokenHash(saved.connectorToken), browserHash: await tokenHash(saved.browserToken) }) });
    requireRemote(response.ok, 'relay'); await response.body?.cancel();
  }
  async function send(type, body, session = active) {
    if (!session || session !== active || saved.revoked || controller.signal.aborted) return;
    const seq = session.seq++;
    const ciphertext = await seal({ v: protocol, type, route: saved.route, epoch: session.epoch, seq, permission: permission(), body }, identity, saved.peer, now());
    if (session !== active || saved.revoked) return;
    await transport.call('send', ciphertext, controller.signal);
  }
  async function publish() {
    if (publishing || !active?.ready || saved.revoked) return;
    if (active.awaiting !== null) {
      if (now() - active.sentAt > OBSERVATION_RECEIPT_MS) { active = null; status = 'offline'; }
      return;
    }
    publishing = true; const session = active, started = now(); diagnostic({ event: 'snapshot.start', at: started, revision: permission() });
    try {
      const data = observer ? await observer.snapshot({ revision: saved.revision, permissions: saved.selection.permissions, detail: session.detail })
        : await readSelectedLog(saved.selection, saved.projectId, now());
      if (session !== active) return;
      session.awaiting = session.seq; session.sentAt = now(); await send('observe', data, session);
      if (session === active) status = 'connected';
    }
    catch (error) { status = 'unavailable'; diagnostic({ event: 'snapshot.failed', code: error.code || error.name, at: now() }); }
    finally { publishing = false; diagnostic({ event: 'snapshot.end', durationMs: now() - started, at: now() }); }
  }
  async function acceptHello(frame) {
    requireRemote(!saved.revoked && saved.peer && !controller.signal.aborted, 'revoked');
    const session = active = { epoch: frame.epoch, seq: 0, ready: false, awaiting: null, sentAt: 0, inputSeq: 0, detail: null }; status = 'connected';
    await send('paired', protocol === 2 ? { name: 'LioOps PC', scopeId: saved.projectId, permissions: saved.selection.permissions }
      : { name: 'LioOps PC', projectId: saved.projectId }, session);
  }
  async function receive(ciphertext) {
    requireRemote(!approving && !permissionWriting && !saved.revoked, 'pending');
    // A known peer is pinned; an invitation does not replace an approved peer.
    const { payload: frame, sender } = await open(ciphertext, identity, saved.peer, now());
    validateFrame(frame, saved.route, identity.public.id, { protocol, permission: protocol === 2 && frame.type === 'hello' ? null : permission() });
    if (frame.type === 'ready') {
      requireRemote(saved.peer && active && frame.epoch === active.epoch && !active.ready, 'receipt');
      active.ready = true; await publish(); return;
    }
    if (frame.type === 'seen') {
      requireRemote(saved.peer && active && frame.epoch === active.epoch && frame.seq === active.awaiting, 'receipt');
      active.awaiting = null; return;
    }
    if (protocol === 2 && frame.type === 'read') {
      requireRemote(saved.selection.permissions.content && active?.ready && frame.epoch === active.epoch && frame.seq === active.inputSeq + 1, 'read');
      active.inputSeq = frame.seq; active.detail = { id: frame.body.id, requestId: frame.body.requestId };
      await publish(); return;
    }
    requireRemote(frame.type === 'hello' && sender.id === frame.body.public?.id, 'operation');
    for (const [id, expiry] of seen) if (expiry < now()) seen.delete(id);
    requireRemote(!seen.has(frame.jti) && !seen.has(frame.epoch) && seen.size < 128, 'replay');
    seen.set(frame.jti, now() + 90000); seen.set(frame.epoch, now() + 90000);
    if (saved.peer) { requireRemote(sender.id === saved.peer.id, 'identity'); await acceptHello(frame); return; }
    requireRemote(!saved.revoked && saved.expires > now() && frame.body.claim === saved.claim, 'invite');
    requireRemote(!pending || pending.expires <= now() || pending.sender.id === sender.id, 'pending');
    pending = { sender, frame, expires: Math.min(saved.expires, now() + 60000) }; status = 'pending';
  }
  const api = {
    get state() { return { status, paired: !!saved.peer, revoked: saved.revoked && revocationSaved,
      ...(protocol === 2 && { protocol, revision: saved.revision, permissions: { ...saved.selection.permissions }, projects: saved.selection.projects.map(project => project.path),
        runtime: { rssBytes: process.memoryUsage.rss(), cpuMicros: process.cpuUsage().user + process.cpuUsage().system, uptimeMs: Math.floor(process.uptime() * 1000), ...observer.diagnostics } }),
      pending: pending && pending.expires > now()
      ? { fingerprint: pending.sender.id, epoch: pending.frame.epoch, expires: pending.expires } : null }; },
    get inviteURL() {
      if (saved.peer || saved.revoked || !saved.claim || saved.expires <= now()) return null;
      const link = new URL(web); link.hash = 'lioops-pair=' + encodeURIComponent(JSON.stringify({ v: 1, relay, route: saved.route, token: saved.browserToken,
        claim: saved.claim, expires: saved.expires, connector: identity.public, ...(protocol === 2 && { protocol: 2 }) })); return link.href;
    },
    async start() {
      if (loop) return;
      await register(); status = saved.peer ? 'offline' : 'waiting';
      loop = (async () => {
        while (!controller.signal.aborted && !saved.revoked) {
          try { const result = await transport.call('poll', null, controller.signal); if (result.ciphertext) { try { await receive(result.ciphertext); } catch (error) { diagnostic({ event: 'frame.rejected', code: error.code || error.name, at: now() }); } } }
          catch { if (controller.signal.aborted || saved.revoked) break; active = null; status = 'offline'; await sleep(1000, controller.signal); try { await register(); } catch { /* retry the observation connection only */ } }
        }
      })();
      publisher = setInterval(() => { void publish(); }, intervalMs);
    },
    async approve(fingerprint, epoch) {
      requireRemote(pending && pending.expires > now() && pending.sender.id === fingerprint && pending.frame.epoch === epoch && !saved.peer && !saved.revoked, 'pending');
      const approved = pending; pending = null; approving = true; saved.peer = approved.sender; saved.claim = null;
      try { await persist(); } catch (error) { saved.peer = null; status = 'unavailable'; await api.stop(); throw error; } finally { approving = false; }
      await acceptHello(approved.frame);
    },
    async setPermissions(value, expectedRevision) {
      requireRemote(protocol === 2 && !saved.revoked && !approving && !changing && expectedRevision === saved.revision, 'permissions');
      const next = observationPermissions(value), session = active, previous = saved.revision;
      changing = true; permissionWriting = true; active = null; pending = null; saved.selection.permissions = next; saved.revision++;
      try {
        await persist(); requireRemote(!saved.revoked, 'revoked');
        // A browser may receive the notice before the relay answers this send. New hellos are safe after durable consent.
        permissionWriting = false;
        if (session && saved.peer) {
          const notice = await seal({ v: 2, type: 'changed', route: saved.route, epoch: session.epoch, seq: session.seq++, permission: previous,
            body: { revision: saved.revision } }, identity, saved.peer, now());
          await transport.call('send', notice, controller.signal).catch(() => {});
        }
        status = active?.ready ? 'connected' : saved.peer ? 'offline' : 'waiting';
      } catch (error) { if (!saved.revoked) { status = 'unavailable'; await api.stop(); } throw error; }
      finally { changing = false; permissionWriting = false; }
    },
    async revoke() {
      // Durable local revocation takes effect even if the relay is unavailable or malicious.
      saved.revoked = true; saved.peer = null; saved.claim = null; pending = null; active = null; status = 'revoking';
      try { await persist(); revocationSaved = true; status = 'revoked'; }
      catch (error) { status = 'unavailable'; await api.stop(); throw error; }
      // Closing a route cancels all waits and queued ciphertext. Browser expiry independently clears stale data.
      try { await transport.call('close', null, AbortSignal.timeout(5000)); } catch { /* local revocation already persisted */ }
      await api.stop();
    },
    async stop() { controller.abort(); clearInterval(publisher); active = null; await loop; await observer?.close(); if (!saved.revoked && status !== 'unavailable') status = 'closed'; },
  };
  return Object.freeze(api);
}
