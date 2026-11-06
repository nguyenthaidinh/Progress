import { officeRequest } from '../net/api.js';
// Codex account allowance, separate from each conversation's context capacity.
import { $, el, STATIC } from '../core/env.js';
import { t as tr, locale } from '../../i18n/index.js';
import { quotaLeft } from '../../shared/token-budget.js';
import { togglePlan, togglePop } from './settings.js';

let info = null, loading = false, failed = false;
const date = (at) => at ? new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const duration = (w) => w.minutes >= 1440 ? tr('time.day', { n: w.minutes / 1440 }) : w.minutes >= 60 ? tr('time.hour', { n: w.minutes / 60 }) : w.minutes > 0 ? tr('time.min', { n: w.minutes }) : tr('chat.codex.quotaWindow');
const level = (left) => left <= 10 ? 'critical' : left <= 25 ? 'warn' : 'normal';
function toggle(open = $('pop-codex-usage').hidden) {
  $('pop-codex-usage').hidden = !open; $('btn-codex-usage').setAttribute('aria-expanded', String(open));
  if (open) { togglePlan(false); togglePop(false); void refresh(); }
}
function render() {
  const button = $('btn-codex-usage');
  button.hidden = !info?.enabled || !info?.available;
  if (button.hidden) { toggle(false); return; }
  const buckets = info.limits?.buckets || [], main = buckets.find((b) => b.id === 'codex') || (buckets.length === 1 ? buckets[0] : null);
  const values = (main?.windows || []).map(quotaLeft).filter((n) => n !== null), left = values.length ? Math.min(...values) : null;
  $('codex-quota-mini').textContent = left === null ? '–' : tr('chat.codex.quotaLeft', { pct: left });
  button.dataset.level = left === null ? 'normal' : level(left);
  button.title = left === null ? tr('chat.codex.limitsUnavailable') : tr('chat.codex.quotaSummary', { name: main.name || main.id, pct: left });
  $('codex-quota-bar').style.width = `${left ?? 0}%`;
  $('codex-quota-at').textContent = info.limits?.at ? tr('chat.codex.usageAsOf', { at: date(info.limits.at) }) : '';
  const rows = $('codex-quota-rows'); rows.replaceChildren();
  for (const bucket of buckets) {
    if (!bucket.windows?.length) continue;
    const group = el('section', 'codex-quota-group'); group.append(el('b', null, bucket.name || bucket.id));
    for (const window of bucket.windows) {
      const left = quotaLeft(window); if (left === null) continue;
      const row = el('div', 'codex-quota-row'), heading = el('div', 'codex-quota-heading');
      heading.append(el('span', null, duration(window)), el('b', null, tr('chat.codex.quotaLeft', { pct: left })));
      const meter = el('div', 'codex-meter'), fill = el('b'); fill.style.width = `${left}%`; meter.dataset.level = level(left);
      meter.setAttribute('role', 'progressbar'); meter.setAttribute('aria-label', `${bucket.name || bucket.id} · ${duration(window)}`);
      meter.setAttribute('aria-valuenow', String(left)); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100');
      meter.append(fill); row.append(heading, meter, el('small', null, tr('chat.codex.quotaReset', { at: date(window.resetsAt) }))); group.append(row);
    }
    rows.append(group);
  }
  $('codex-quota-empty').hidden = !!rows.children.length;
  $('codex-quota-error').hidden = !failed;
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await officeRequest('tasks.metadata', {}, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Unavailable');
    const result = await response.json(); if (!result.ok || !result.codex) throw new Error('Unavailable');
    info = result.codex; failed = !!info.limitsError || !info.connected;
  } catch { failed = true; }
  finally { loading = false; render(); }
}
export function setup() {
  if (STATIC || new URLSearchParams(location.search).has('demo')) return;
  $('btn-codex-usage').addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  $('codex-quota-close').addEventListener('click', () => { toggle(false); $('btn-codex-usage').focus(); });
  document.addEventListener('click', (e) => { if (e.target.isConnected && !e.target.closest('#pop-codex-usage, #btn-codex-usage')) toggle(false); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('pop-codex-usage').hidden) { toggle(false); $('btn-codex-usage').focus(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
}
