// A read-only scene source: only validated observation snapshots from this page's same-origin parent are accepted.
import { state } from '../core/state.js';
import { $, el } from '../core/env.js';
import { applyMsg, demoLog } from '../demo/demo.js';
import { setConn } from '../net/live.js';
import { closeSession, scheduleLog } from '../ui/session-drawer.js';
import { validateObservationSnapshot } from '../../shared/observation.js';
import { t as tr } from '../../i18n/index.js';
import { BROWSER_OBSERVER } from '../core/source-mode.js';

export function setup() {
  if (!BROWSER_OBSERVER) return;
  document.documentElement.dataset.observer = 'true';
  const compact = matchMedia('(max-width:720px)');
  const resize = () => document.documentElement.classList.toggle('is-phone', compact.matches); compact.addEventListener('change', resize); resize();
  state.isLocal = false; state.phoneTasks = false; state.phoneApprove = false;
  const note = el('span', 'observer-scene-label', tr('observer.readOnly')); $('clock').after(note);
  document.querySelector('#dr-session [data-close]')?.addEventListener('click', closeSession);
  addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSession(); });
  addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.kind !== 'lioops-observation' || event.data.version !== 1) return;
    const snapshot = validateObservationSnapshot(event.data.snapshot); if (!snapshot) return;
    demoLog.clear(); const feed = [], stats = { read: 0, edit: 0, cmd: 0, prompts: 0 };
    const sessions = snapshot.sessions.map(s => {
      const items = s.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'claude', text: m.text, ts: m.at || s.updatedAt || snapshot.sampledAt }));
      demoLog.set(s.id, items);
      for (const e of s.events) { stats[e.type] = (stats[e.type] || 0) + 1; feed.push({ id: `${s.id}:${feed.length}`, sess: s.id, name: s.name, ts: e.at || s.updatedAt || snapshot.sampledAt, type: e.type === 'cmd' ? 'bash' : e.type, label: e.label }); }
      stats.prompts += s.messages.filter(m => m.role === 'user').length;
      const last = s.events.at(-1), used = s.contextUsed !== null && s.contextMax !== null;
      return { id: s.id, sid: s.id, agent: s.provider, name: s.name, dir: s.project || s.name, title: s.name, status: s.status === 'work' ? 'work' : 'rest',
        lastAt: s.updatedAt || snapshot.sampledAt, taskStart: s.status === 'work' ? s.updatedAt : 0, createdAt: s.updatedAt || snapshot.sampledAt,
        last: last ? { type: last.type === 'cmd' ? 'bash' : last.type, label: last.label } : null, lastPrompt: s.messages.findLast(m => m.role === 'user')?.text || '',
        usage: used ? { model: s.model || s.provider, in: s.inputTokens, out: s.outputTokens, ctx: s.contextUsed, ctxMax: s.contextMax, cost: null } : null,
        counts: s.counts, subs: [], doneSubs: [], todos: [], observed: true };
    });
    applyMsg({ k: 'snap', sessions, feed: feed.sort((a, b) => a.ts - b.ts).slice(-100), stats }, true); setConn(true);
    if (state.selectedId) scheduleLog();
  });
  parent.postMessage({ kind: 'lioops-observer-ready' }, location.origin);
}
