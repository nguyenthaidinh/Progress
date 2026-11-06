import { getOfficeClient, officeClient, markEncryptedRendererReady } from '../data/runtime.js';
import { OFFICE_SOURCE } from '../core/source-mode.js';
import { replay } from '../core/env.js';
import { state } from '../core/state.js';
import { applyMsg } from '../demo/demo.js';
import { setConn } from './live.js';
import { clearObservedSession, openSession, scheduleLog } from '../ui/session-drawer.js';

const client = officeClient;
let renderReady = false;
let restoreView = null;
client.subscribe(packet => {
  if (!renderReady || replay.on) return;
  const selected = state.selectedId;
  applyMsg(packet.message, packet.source === 'encrypted-relay');
  if (packet.source === 'encrypted-relay' && selected && !packet.message.sessions?.some(session => session.id === selected)) clearObservedSession();
  if (restoreView && restoreView.context !== client.context) restoreView = null;
  if (packet.source === 'encrypted-relay' && client.state.capabilities.content && restoreView) {
    const previous = restoreView; restoreView = null;
    if (!state.selectedId && packet.message.sessions?.some(session => session.id === previous.id)) openSession(previous.id);
  }
  if (packet.source === 'encrypted-relay' && state.selectedId) scheduleLog();
});
client.subscribeState(connection => {
  const previous = state.connection;
  state.connection = connection;
  if (restoreView && restoreView.context !== client.context) restoreView = null;
  // The renderer has not been initialized when this module is imported.
  if (connection.status === 'idle') return;
  setConn(connection.status === 'connected');
  if (renderReady && connection.source === 'encrypted-relay' && !connection.capabilities.observe) {
    if (client.context && state.selectedId) restoreView = { context: client.context, id: state.selectedId };
    clearObservedSession(); applyMsg({ k: 'snap', sessions: [], feed: [], stats: {} }, true);
  } else if (renderReady && connection.source === 'encrypted-relay' && !connection.capabilities.content) {
    restoreView = null;
    if (previous?.capabilities.content) clearObservedSession();
  }
  if (connection.status === 'unauthorized' && connection.source === 'local-http') location.reload();
});
let listening = false;
export function disconnect() { client.close(); }
export function reconnect() { if (['local-http', 'encrypted-relay'].includes(OFFICE_SOURCE)) getOfficeClient().reconnect(); }
export function connect() {
  if (!['local-http', 'encrypted-relay'].includes(OFFICE_SOURCE)) return;
  renderReady = true;
  if (!listening) {
    listening = true;
    addEventListener('pagehide', disconnect);
    addEventListener('pageshow', event => { if (event.persisted) connect(); });
  }
  getOfficeClient().connect();
  if (OFFICE_SOURCE === 'encrypted-relay') markEncryptedRendererReady();
  if (OFFICE_SOURCE === 'encrypted-relay' && client.latestPacket && client.state.capabilities.observe) applyMsg(client.latestPacket.message, true);
}
