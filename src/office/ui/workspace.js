// A dedicated AI workspace: private conversation history, prompt composer and approvals, separate from company chat.
import { $, el, STATIC } from '../core/env.js';
import { state } from '../core/state.js';

import { officeRequest } from '../net/api.js';
import { sendTaskRequest, taskRequestMessage } from '../net/task-request.js';
import { icon } from './icons.js';
import { md } from './markdown.js';
import { toast } from './activity.js';
import { createImageQueue, pastePromptImages, MAX_PROMPT_IMAGES } from './prompt-images.js';
import { permCard, bindPermissionActions } from './permissions.js';
import { dictate } from './task-sheet.js';
import { cacheWords } from './cache-words.js';
import { contextBudget } from '../../shared/token-budget.js';
import { createPromptCoach } from './prompt-coach.js';
import { BROWSER_OBSERVER } from '../core/source-mode.js';
import { t as tr, locale } from '../../i18n/index.js';

const ACTIVE = new Set(['starting', 'work', 'wait', 'stopping']);
const drafts = new Map(), expanded = new Set();
let root, list, search, heading, subheading, transcript, approvals, targetControls, provider, project, source, model, effort,
  modelWrap, advanced, field, thumbs, send, stop, native, feedback, counter, autoOpen, autoWrap, mic, contextLine;
let selected = '', current = null, config = null, summaries = [], allowed = false, sending = false, saving = false,
  poll = null, request = null, revision = '', stopMic = null, loading = false, initial = null, openVersion = 0, newKey = 'new', sessionMeta = null, promptCoach = null;
const draft = () => {
  const key = selected || newKey;
  if (!drafts.has(key)) drafts.set(key, { text: '', images: [], agent: '', dir: '', sid: '', model: '', effort: '' });
  return drafts.get(key);
};
const agentName = (agent) => agent === 'codex' ? 'Codex' : 'Claude';
const lastTurn = () => current?.turns.at(-1);
const busyTurn = () => ACTIVE.has(lastTurn()?.status);
const agent = () => current?.agent || draft().agent;
const time = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
function rememberSelection(open = true) {
  const next = new URL(location.href); if (selected && open && !root?.hidden) next.searchParams.set('work', selected); else next.searchParams.delete('work');
  history.replaceState(null, '', next);
}
const button = (text, cls, action, glyph) => {
  const b = el('button', cls); b.type = 'button'; if (glyph) b.append(icon(glyph)); b.append(el('span', null, text));
  b.addEventListener('click', action); return b;
};
const label = (text, input) => { const l = el('label', 'aw-label'); l.append(el('span', null, text), input); input.setAttribute('aria-label', text); return l; };
async function api(operation, params = {}, signal) {
  const response = await officeRequest(operation, params, { signal });
  const data = await response.json();
  if (!response.ok || !data.ok) throw Object.assign(new Error(data.message || tr(`workspace.errors.${data.code || 'connection'}`)), { code: data.code });
  return data;
}
const imageQueue = createImageQueue({ images: () => draft().images, current: () => !!root && !root.hidden,
  changed: () => { drawImages(); sync(); promptCoach?.schedule(); }, busy: () => { if (root) sync(); },
  limit: (n) => toast(tr('chat.task.imageLimit', { n })), error: () => toast(tr('chat.task.imageFailed')) });

function sync() {
  if (!root) return;
  const d = draft(), active = busyTurn(), waiting = loading || sending || saving || imageQueue.pending || promptCoach?.busy;
  field.maxLength = active ? 2000 : 4000;
  send.disabled = !!waiting || !allowed || (!field.value.trim() && !d.images.length) || (!selected && !(d.sid || d.dir))
    || (!!selected && !current) || (active && (!!d.images.length || !lastTurn()?.task)) || field.value.length > field.maxLength || lastTurn()?.status === 'interrupted';
  send.lastElementChild.textContent = tr(sending ? 'chat.task.sending' : active ? 'workspace.sendNote' : 'workspace.send');
  field.disabled = !!sending;
  counter.textContent = `${field.value.length}/${field.maxLength}`;
  stop.hidden = !active; stop.disabled = lastTurn()?.status === 'stopping';
  native.hidden = agent() !== 'codex' || !current?.sid;
  provider.disabled = project.disabled = source.disabled = !!sending || !!selected;
  if (!selected && d.sid) project.disabled = true;
  model.disabled = effort.disabled = !!sending;
  targetControls.hidden = !!selected;
  root.querySelector('.aw-source').hidden = !!selected;
  modelWrap.hidden = agent() !== 'codex';
  autoWrap.hidden = agent() !== 'codex' || !config?.desktop?.canConfigure;
  autoOpen.disabled = !!sending || saving || !config?.desktop?.enabled;
  thumbs.setAttribute('aria-busy', String(!!imageQueue.pending));
  mic.disabled = !!sending || !!promptCoach?.busy;
  for (const b of root.querySelectorAll('.aw-conversation,.aw-new,.aw-header-new')) b.disabled = !!sending;
  const budget = sessionMeta?.agent === 'codex' ? contextBudget(sessionMeta.usage) : null;
  const cache = sessionMeta?.agent !== 'codex' ? cacheWords(sessionMeta?.cache, document.documentElement.classList.contains('is-phone') ? 'chatShort' : 'chat') : { text: '', state: 'none' };
  contextLine.textContent = budget ? tr('chat.codex.contextLeft', { pct: budget.leftPct }) : cache.text;
  contextLine.hidden = !contextLine.textContent; contextLine.dataset.state = budget ? 'context' : cache.state;
  contextLine.title = budget ? tr('chat.codex.contextNote') : '';
  root.querySelector('.aw-hint').textContent = tr(active && d.images.length ? 'workspace.waitImages' : 'workspace.composerHint', { n: MAX_PROMPT_IMAGES });
}
function options(select, items, value) {
  select.replaceChildren(...items.map(([v, text, disabled]) => { const o = el('option', null, text); o.value = v; o.disabled = !!disabled; return o; })); select.value = value;
}
function configure() {
  if (!config) return;
  const d = draft(); d.agent ||= config.codex?.available && config.codex?.enabled ? 'codex' : 'claude'; d.dir ||= config.projects[0]?.dir || '';
  if (d.dir && !config.projects.some((p) => p.dir === d.dir)) config.projects.push({ dir: d.dir, name: d.dir.split(/[\\/]/).at(-1) });
  options(provider, [['codex', 'Codex', !config.codex?.available || !config.codex?.enabled], ['claude', 'Claude Code']], d.agent);
  options(project, config.projects.length ? config.projects.map((p) => [p.dir, `${p.name} · ${p.dir}`]) : [['', tr('workspace.noProjects')]], d.dir);
  options(source, [['', tr('workspace.fresh')], ...config.sessions.filter((s) => s.agent === d.agent).map((s) => [s.sid, s.name])], d.sid);
  options(model, [['', tr('chat.codex.defaultModel')], ...(config.codex?.models || []).map((m) => [m.id, m.name])], d.model);
  configureEfforts(); autoOpen.checked = !!config.desktop?.autoOpen; sync();
}
function configureEfforts() {
  const d = draft(), chosen = config?.codex?.models?.find((m) => m.id === d.model);
  options(effort, [['', tr('chat.codex.defaultEffort')], ...(chosen?.efforts || []).map((e) => [e, e])], d.effort);
  effort.closest('label').hidden = !d.model || agent() !== 'codex';
}
function drawImages() {
  thumbs.replaceChildren(...draft().images.map((src, i) => {
    const item = el('span', 'aw-image'), img = el('img'); img.src = src; img.alt = tr('chat.task.imageAlt', { n: i + 1 });
    const remove = button('×', 'aw-image-remove', () => { draft().images.splice(i, 1); drawImages(); sync(); });
    remove.setAttribute('aria-label', tr('chat.task.removeImage', { n: i + 1 })); item.append(img, remove); return item;
  }));
}
function drawList() {
  const text = search.value.trim().toLowerCase();
  const rows = summaries.filter((c) => `${c.title} ${c.dir} ${c.agent}`.toLowerCase().includes(text));
  list.replaceChildren(...rows.map((c) => {
    const row = button('', 'aw-conversation', () => selectConversation(c.id)); row.replaceChildren(); row.dataset.id = c.id;
    row.setAttribute('aria-current', String(c.id === selected));
    const line = el('div', 'aw-conversation-meta'); line.append(el('span', `aw-agent is-${c.agent}`, agentName(c.agent)), el('small', `aw-state is-${c.status}`, tr(`workspace.status.${c.status}`)));
    row.append(line, el('b', null, c.title), el('small', 'aw-project-name', state.streamer ? tr('workspace.project') : c.dir.split(/[\\/]/).at(-1)));
    return row;
  }));
  if (!rows.length) list.append(el('p', 'aw-list-empty', tr(text ? 'workspace.noMatches' : 'workspace.noConversations')));
}
function message(name, text, cls, at) {
  const box = el('article', `aw-message ${cls}`), meta = el('div', 'aw-message-meta'); meta.append(el('b', null, name), el('time', null, time(at)));
  box.append(meta); const content = el('div', cls === 'is-user' ? 'aw-prompt-text' : 'zc-md');
  if (cls === 'is-user') content.textContent = text; else content.append(md(text)); box.append(content); return box;
}
function readableStep(text) {
  const at = text.indexOf(' -Command '); return at < 0 ? text : text.slice(at + 10).replace(/^['"]|['"]$/g, '');
}
function drawConversation(force = false) {
  const signature = JSON.stringify(current);
  if (!force && signature === revision) return;
  revision = signature;
  heading.textContent = current ? current.title : tr('workspace.newTitle');
  subheading.textContent = current ? `${agentName(current.agent)} · ${state.streamer ? tr('workspace.project') : current.dir}` : tr('workspace.newHint');
  const bottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  transcript.replaceChildren();
  if (!current) {
    const welcome = el('div', 'aw-welcome'); welcome.append(icon('sparkle'), el('h3', null, tr('workspace.welcome')), el('p', null, tr('workspace.welcomeHint'))); transcript.append(welcome);
  }
  for (const turn of current?.turns || []) {
    const prompt = message(tr('chat.you'), turn.prompt, 'is-user', turn.at);
    if (turn.images) prompt.append(el('small', 'aw-image-count', tr('workspace.imageCount', { n: turn.images })));
    transcript.append(prompt);
    for (const note of turn.notes || []) transcript.append(message(tr('workspace.yourNote'), note.text, 'is-user', note.at));
    const progress = el('details', 'aw-progress'), summary = el('summary'); progress.dataset.turn = turn.id;
    progress.open = ACTIVE.has(turn.status) || expanded.has(turn.id);
    summary.append(el('i', `aw-status-dot is-${turn.status}`), el('span', null, tr(`workspace.status.${turn.status}`)), el('small', null, tr('workspace.steps', { n: turn.n || 0 })));
    progress.append(summary);
    const steps = el('ol'); for (const text of turn.steps) { const li = el('li'); li.append(el('code', null, readableStep(text))); steps.append(li); }
    if (!turn.steps.length) progress.append(el('p', null, tr(ACTIVE.has(turn.status) ? 'workspace.noSteps' : 'workspace.noStepsDone'))); else progress.append(steps);
    progress.addEventListener('toggle', () => { if (progress.open) expanded.add(turn.id); else expanded.delete(turn.id); });
    transcript.append(progress);
    if (turn.result) transcript.append(message(agentName(current.agent), turn.result, 'is-ai', turn.endedAt || turn.at));
    if (turn.error) transcript.append(el('p', 'aw-error', turn.error));
    if (turn.status === 'interrupted') transcript.append(el('p', 'aw-error', tr('workspace.errors.workspaceInterrupted')));
  }
  const approval = lastTurn()?.approval;
  // Preserve answers already selected in an inline approval while the rest of the conversation refreshes.
  if (approvals.dataset.id !== (approval?.id || '')) {
    approvals.dataset.id = approval?.id || ''; approvals.replaceChildren();
    if (approval) { const card = permCard(approval); card.classList.replace('perm-card', 'aw-permission'); approvals.append(card); }
  }
  approvals.hidden = !approval;
  if (bottom || force) transcript.scrollTop = transcript.scrollHeight;
  sync();
}
async function refresh() {
  request?.abort(); const controller = request = new AbortController(), id = selected;
  try {
    const sourceSid = !id && draft().sid;
    const data = await api('workspace.read', id ? { id } : sourceSid ? { source: sourceSid } : {}, controller.signal);
    if (request !== controller || selected !== id || root.hidden) return;
    summaries = data.conversations; current = data.conversation; sessionMeta = data.session || null; allowed = data.allowed; loading = false;
    drawList(); drawConversation(); sync();
    if (!allowed) feedback.textContent = tr('chat.task.notAllowed');
    else if (data.error) feedback.textContent = tr(`workspace.errors.${data.error}`);
  } catch (error) {
    if (error.name === 'AbortError' || request !== controller || root.hidden) return;
    loading = false; feedback.textContent = error.message || tr('workspace.errors.connection'); sync();
  }
}
function selectConversation(id = '') {
  if (sending) return;
  stopMic?.(); stopMic = null; imageQueue.invalidate(); promptCoach?.reset(); selected = id; if (!id) newKey = 'new'; current = null; sessionMeta = null; revision = ''; loading = !!id;
  root.classList.remove('aw-show-list'); field.value = draft().text; feedback.textContent = ''; drawImages(); configure(); drawConversation(true); drawList();
  rememberSelection();
  void refresh(); field.focus({ preventScroll: true });
}
async function submit() {
  sync(); if (send.disabled) return;
  const d = draft(), was = selected || newKey, active = busyTurn(), text = field.value.trim() || tr('chat.to.photoOnly');
  const body = active ? { workspace: true, conversationId: selected, task: lastTurn().task, text } : {
    workspace: true, ...(selected ? { conversationId: selected } : d.sid ? { sid: d.sid, agent: d.agent } : { dir: d.dir, agent: d.agent, fresh: true }),
    text, images: [...d.images], ...(agent() === 'codex' && d.model ? { model: d.model, effort: d.effort } : {}),
  };
  sending = true; feedback.textContent = ''; stopMic?.(); stopMic = null; sync();
  try {
    const result = await sendTaskRequest(body, active ? 'steer' : 'start');
    if (!result?.ok) { feedback.textContent = result?.code?.startsWith('workspace') ? tr(`workspace.errors.${result.code}`) : taskRequestMessage(result); return; }
    drafts.set(was, { ...d, text: '', images: [] });
    promptCoach.reset();
    selected = result.conversationId || selected; current = null; revision = ''; field.value = draft().text; drawImages(); configure();
    advanced.open = false;
    rememberSelection();
    await refresh();
  } catch { feedback.textContent = tr('workspace.errors.connection'); }
  finally { sending = false; sync(); }
}
function build() {
  root = el('section', 'aw-workspace'); root.id = 'ai-workspace'; root.hidden = true; root.setAttribute('role', 'region'); root.setAttribute('aria-label', tr('workspace.title'));
  const top = el('header', 'aw-header'), brand = el('div', 'aw-brand'), words = el('div'); words.append(el('h2', null, tr('workspace.title')), el('p', null, tr('workspace.subtitle'))); brand.append(icon('sparkle'), words);
  const history = button(tr('workspace.history'), 'aw-button aw-history-toggle', () => root.classList.toggle('aw-show-list'), 'list');
  history.setAttribute('aria-label', tr('workspace.history'));
  const close = button(tr('common.close'), 'aw-button aw-close', closeWorkspace, 'x'); close.setAttribute('aria-label', tr('workspace.close'));
  const add = button(tr('workspace.new'), 'aw-button aw-header-new', () => selectConversation(''), 'clipboard'); add.setAttribute('aria-label', tr('workspace.new'));
  top.append(brand, add, history, close);
  const sidebar = el('aside', 'aw-sidebar'); search = el('input', 'aw-search'); search.type = 'search'; search.placeholder = tr('workspace.search'); search.setAttribute('aria-label', tr('workspace.search')); search.addEventListener('input', drawList);
  list = el('div', 'aw-conversations'); list.setAttribute('aria-label', tr('workspace.history'));
  sidebar.append(button(tr('workspace.new'), 'aw-button aw-new', () => selectConversation(''), 'clipboard'), search, list);
  const main = el('div', 'aw-main'), context = el('div', 'aw-context'), titles = el('div'); heading = el('h3'); subheading = el('p'); contextLine = el('small', 'aw-context-cache'); contextLine.hidden = true; titles.append(heading, subheading, contextLine);
  const actions = el('div', 'aw-context-actions');
  stop = button(tr('chat.card.stop'), 'aw-button aw-stop', async () => { try { await api('tasks.stop', { id: lastTurn()?.task }); feedback.textContent = tr('workspace.stopping'); void refresh(); } catch (error) { feedback.textContent = error.message; } });
  native = button(tr('chat.codex.openDesktop'), 'aw-button aw-native', async () => { try { await api('tasks.openCodex', { sid: current.sid }); toast(tr('chat.codex.desktopOpened')); } catch (error) { toast(error.message); } });
  actions.append(native, stop); context.append(titles, actions);
  targetControls = el('div', 'aw-targets'); provider = el('select'); project = el('select');
  provider.addEventListener('change', () => { promptCoach.reset(); Object.assign(draft(), { agent: provider.value, sid: '', model: '', effort: '' }); sessionMeta = null; configure(); });
  project.addEventListener('change', () => { promptCoach.reset(); draft().dir = project.value; sync(); });
  targetControls.append(label(tr('workspace.agent'), provider), label(tr('workspace.project'), project));
  advanced = el('details', 'aw-advanced'); advanced.append(el('summary', null, tr('workspace.options')));
  const optional = el('div', 'aw-options'); source = el('select'); source.addEventListener('change', () => { promptCoach.reset(); const s = config.sessions.find((s) => s.sid === source.value); draft().sid = source.value; if (s) draft().dir = s.dir; configure(); void refresh(); });
  const sourceLabel = label(tr('workspace.source'), source); sourceLabel.classList.add('aw-source'); optional.append(sourceLabel);
  modelWrap = el('div', 'aw-models'); model = el('select'); effort = el('select');
  model.addEventListener('change', () => { draft().model = model.value; draft().effort = ''; configureEfforts(); }); effort.addEventListener('change', () => { draft().effort = effort.value; });
  modelWrap.append(label(tr('chat.codex.model'), model), label(tr('chat.codex.effort'), effort)); optional.append(modelWrap);
  autoWrap = el('label', 'aw-auto'); autoOpen = el('input'); autoOpen.type = 'checkbox'; autoWrap.append(autoOpen, el('span', null, tr('chat.codex.desktopAutoOpen')));
  autoOpen.addEventListener('change', async () => { saving = true; sync(); try { config.desktop = (await api('tasks.desktop', { on: autoOpen.checked })).desktop; } catch (error) { autoOpen.checked = config.desktop.autoOpen; toast(error.message); } finally { saving = false; sync(); } });
  optional.append(autoWrap); advanced.append(optional);
  transcript = el('div', 'aw-transcript'); transcript.setAttribute('role', 'log'); transcript.setAttribute('aria-label', tr('workspace.messages'));
  approvals = el('div', 'aw-approvals'); approvals.hidden = true; bindPermissionActions(approvals);
  const composer = el('form', 'aw-composer'); composer.addEventListener('submit', (event) => { event.preventDefault(); void submit(); });
  thumbs = el('div', 'aw-images'); field = el('textarea', 'aw-prompt'); field.rows = 3; field.maxLength = 4000; field.placeholder = tr('workspace.placeholder'); field.setAttribute('aria-label', tr('workspace.prompt'));
  field.addEventListener('input', () => { draft().text = field.value; sync(); promptCoach.schedule(); });
  field.addEventListener('paste', (event) => pastePromptImages(event, (files) => imageQueue.add(files), !sending));
  field.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Escape') closeWorkspace(); if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void submit(); } });
  const upload = el('input'); upload.type = 'file'; upload.accept = 'image/*'; upload.multiple = true; upload.hidden = true;
  upload.addEventListener('change', () => { if (!sending) imageQueue.add([...upload.files]); upload.value = ''; });
  const tools = el('div', 'aw-tools'), left = el('div', 'aw-tool-buttons');
  mic = button(tr('chat.task.mic'), 'aw-button', () => { if (stopMic) { stopMic(); stopMic = null; } else stopMic = dictate(mic, field, () => { draft().text = field.value; sync(); }); }, 'mic');
  left.append(button(tr('chat.task.photo'), 'aw-button', () => upload.click(), 'image'), mic);
  send = button(tr('workspace.send'), 'aw-button aw-send', () => void submit(), 'send');
  counter = el('small', 'aw-counter'); tools.append(left, counter, send);
  feedback = el('p', 'aw-feedback'); feedback.setAttribute('role', 'status');
  const hint = el('small', 'aw-hint', tr('workspace.composerHint', { n: MAX_PROMPT_IMAGES }));
  promptCoach = createPromptCoach({ input: field, photos: () => draft().images.length, enabled: () => allowed && !sending,
    current: () => !root.hidden, key: () => `${selected || newKey}:${agent()}:${draft().sid}:${draft().dir}`,
    changed: () => { draft().text = field.value; sync(); }, error: (message) => toast(message, 7000) });
  promptCoach.element.classList.add('aw-coach');
  composer.append(promptCoach.element, thumbs, field, upload, tools, hint, feedback);
  main.append(context, targetControls, advanced, transcript, approvals, composer); root.append(top, sidebar, main); $('app').append(root);
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); closeWorkspace(); } });
  root.addEventListener('focusin', fitViewport);
}
function fitViewport() {
  if (!root) return;
  const viewport = window.visualViewport, on = !root.hidden && document.documentElement.classList.contains('is-phone') && viewport && viewport.height < innerHeight - 120;
  root.classList.toggle('aw-keyboard', !!on);
  root.style.top = on ? `${viewport.offsetTop}px` : ''; root.style.height = on ? `${viewport.height}px` : ''; root.style.bottom = on ? 'auto' : '';
}
export function closeWorkspace() {
  if (!root) return;
  openVersion++;
  root.hidden = true; clearInterval(poll); poll = null; request?.abort(); imageQueue.invalidate(); promptCoach.reset(); stopMic?.(); stopMic = null;
  fitViewport();
  state.covered = false; $('btn-give-work')?.setAttribute('aria-pressed', 'false'); $('btn-give-work')?.focus({ preventScroll: true });
  rememberSelection(false);
}
export async function openWorkspace(options = {}) {
  if (BROWSER_OBSERVER || STATIC || new URLSearchParams(location.search).has('demo')) return;
  if (sending && (options.to || options.text || options.conversationId || options.newConversation)) { toast(tr('workspace.waitSending')); return; }
  if (!root) build();
  const version = ++openVersion;
  if ($('zchat') && !$('zchat').hidden) $('btn-chat')?.click();
  for (const side of document.querySelectorAll('.ph-open')) side.classList.remove('ph-open');
  document.documentElement.classList.remove('ph-approve');
  root.hidden = false; state.covered = document.documentElement.classList.contains('is-phone'); $('btn-give-work')?.setAttribute('aria-pressed', 'true');
  loading = true; feedback.textContent = tr('workspace.loading'); sync();
  try {
    const nextConfig = await api('tasks.metadata');
    if (version !== openVersion || root.hidden) return;
    config = nextConfig; allowed = config.allowed;
    if (options.to || options.text) {
      const s = config.sessions.find((s) => s.id === options.to?.id || s.sid === options.to?.sid);
      if ((options.to?.id || options.to?.sid) && !s) throw new Error(tr('workspace.errors.workspaceMissing'));
      const history = s?.sid && !options.newConversation ? await api('workspace.read') : null;
      if (version !== openVersion || root.hidden) return;
      const existing = history?.conversations.find((c) => c.sid === s.sid && c.agent === s.agent);
      stopMic?.(); stopMic = null; imageQueue.invalidate(); promptCoach.reset(); current = null; sessionMeta = null; revision = '';
      if (existing) selected = existing.id;
      else { selected = ''; newKey = `new:${s?.agent || options.agent || ''}:${s?.sid || options.to?.dir || ''}`; }
      const d = draft();
      Object.assign(d, { ...(typeof options.text === 'string' && { text: options.text }), agent: s?.agent || options.agent || d.agent, sid: s?.sid || '', dir: s?.dir || options.to?.dir || d.dir });
    }
    if (options.conversationId && selected !== options.conversationId) { promptCoach.reset(); selected = options.conversationId; current = null; sessionMeta = null; revision = ''; }
    if (options.newConversation && !options.to) { imageQueue.invalidate(); promptCoach.reset(); selected = ''; newKey = 'new'; current = null; sessionMeta = null; revision = ''; }
    field.value = draft().text; drawImages(); configure(); loading = false; feedback.textContent = ''; await refresh();
    if (version !== openVersion || root.hidden) return;
    rememberSelection();
    if (!poll) poll = setInterval(() => { if (!sending && !document.hidden) void refresh(); }, 2500);
    promptCoach.schedule();
    field.focus({ preventScroll: true });
  } catch (error) { if (version !== openVersion || root.hidden) return; loading = false; feedback.textContent = error.message; sync(); }
}
export function setup() {
  if (STATIC || new URLSearchParams(location.search).has('demo')) return;
  window.visualViewport?.addEventListener('resize', fitViewport); window.visualViewport?.addEventListener('scroll', fitViewport);
  const give = $('btn-give-work'); if (give) { give.hidden = false; give.addEventListener('click', () => void openWorkspace()); }
  addEventListener('lioops:workspace-refresh', () => { if (root && !root.hidden) void refresh(); });
  addEventListener('focus', () => { if (root && !root.hidden) void refresh(); });
  initial = new URLSearchParams(location.search).get('work'); if (initial) void openWorkspace({ conversationId: initial });
}
