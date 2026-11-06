// Shared by the React consent surface and OfficeBoot. Pairing never depends on an event/query claiming success.
import { createBrowserPair, createEncryptedRelaySource } from './encrypted-relay.js';
import { loadBrowserPair, saveBrowserPair } from '../../shared/remote/browser-store.js';
import { invitation } from '../../shared/remote/contract.js';
import { validatePublic, secureOrigin, isSecret } from '../../shared/remote/crypto.js';
import { officeClient, selectEncryptedSource, forgetEncryptedSource } from './runtime.js';
import { validatePermissions } from '../../shared/remote/observation-v2.js';
const listeners = new Set(); let initialized;
/** @type {{status: string, invite: {relay: string}|null, fingerprint: string|null, paired: boolean, protocol:number, observation: import('./observation-cache.js').RemoteSummary|null}} */
let snapshot = { status: 'idle', invite: null, fingerprint: null, paired: false, protocol: 1, observation: null };
const update = value => { snapshot = { ...snapshot, ...value }; for (const fn of listeners) fn(); };
export const subscribeRemote = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const remoteState = () => snapshot;
export const remoteServerState = () => serverSnapshot;
const serverSnapshot = { status: 'idle', invite: null, fingerprint: null, paired: false, protocol: 1, observation: null };
function attach(record) {
  const adapter = createEncryptedRelaySource({ record, save: saveBrowserPair, deferObservation: true,
    onObservation: observation => update({ observation }),
    onState: status => update({ status, paired: record.paired, ...(record.paired && { invite: null }) }) });
  selectEncryptedSource(adapter); update({ fingerprint: record.identity.public.id, paired: record.paired, protocol: record.protocol || 1, status: 'connecting' }); officeClient.connect();
}
export function initRemoteBrowser() {
  return initialized ||= (async () => {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.has('lioops-pair')) {
      // Remove invitation secrets from the address/history before making any request.
      const raw = hash.get('lioops-pair'); history.replaceState(null, '', location.pathname + location.search);
      try { if (raw.length > 6000) throw new Error('size'); update({ invite: await invitation(JSON.parse(raw)), status: 'invited' }); }
      catch { update({ status: 'invalid' }); } return;
    }
    try {
      const record = await loadBrowserPair(); if (!record) return;
      if (record.version !== 1 || record.paired !== true || !isSecret(record.route) || !isSecret(record.token) || !isSecret(record.projectId)
        || !record.identity?.sign || record.identity.sign.extractable || !record.identity?.box || record.identity.box.extractable) throw new Error('storage');
      secureOrigin(record.relay); await validatePublic(record.connector); await validatePublic(record.identity.public);
      if (![undefined, 1, 2].includes(record.protocol)) throw new Error('storage');
      if (record.protocol === 2) { if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('storage'); validatePermissions(record.permissions); }
      attach(record);
    } catch { update({ status: 'unavailable' }); }
  })();
}
export async function requestRemotePair() {
  if (!snapshot.invite || snapshot.status !== 'invited') return;
  update({ status: 'pending' });
  try { const record = await createBrowserPair(snapshot.invite); attach(record); }
  catch { update({ status: 'unavailable' }); }
}
export function retryRemote() { if (officeClient.context?.source === 'encrypted-relay') officeClient.reconnect(); }
export async function forgetRemote() {
  forgetEncryptedSource(); update({ status: 'offline' });
  try { await saveBrowserPair(null); } catch { update({ status: 'unavailable' }); return; }
  update({ status: 'idle', paired: false, invite: null, fingerprint: null, observation: null }); location.replace(location.pathname);
}
