import { officeRequest } from '../net/api.js';
// "Giao việc": giving Claude work from the group chat (server/tasks.mjs runs it on the Mac). A sheet over the chat: who
// it goes to (a conversation, carried on with its whole context as a branch of it, or a new conversation in a folder
// sessions have worked in), what to do (typed, or spoken: 🎤 in the office's language), photos (from the camera or the
// gallery, made smaller here before they go). From a phone only once the Mac allows it (the phone window).
import { el } from '../core/env.js';
import { icon } from './icons.js';
import { toast } from './activity.js';
import { avatar } from './chat-avatars.js';
import { who } from './group-chat.js';

import { sendTaskRequest, taskRequestMessage } from '../net/task-request.js';
import { createImageQueue, pastePromptImages, MAX_PROMPT_IMAGES } from './prompt-images.js';
import { t as tr, locale } from '../../i18n/index.js';


let activeSheet = null, sheetSequence = 0;

/* ---------- speaking instead of typing: the browser's speech recognition, in the office's language ---------- */
const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const canDictate = () => !!SR && window.isSecureContext;
/** 🎤 on a button: speak, and the words go into the field as they come; again to stop. -> stop() */
export function dictate(btn, field, onChange) {
  if (!canDictate()) { toast(tr('chat.task.noMic'), 6000); return null; }
  const rec = new SR(), start = field.value, sep = start && !/\s$/.test(start) ? ' ' : '';
  rec.lang = locale() === 'vi-VN' ? 'vi-VN' : 'en-US'; rec.interimResults = true; rec.continuous = true;
  let done = '';
  rec.onresult = (e) => {
    let live = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) done += e.results[i][0].transcript; else live += e.results[i][0].transcript; }
    field.value = `${start}${sep}${done}${live}`.slice(0, 4000); onChange?.();
  };
  const end = () => { btn.classList.remove('is-rec'); btn.setAttribute('aria-pressed', 'false'); };
  rec.onend = end; rec.onerror = (e) => { end(); if (e.error === 'not-allowed') toast(tr('chat.task.micBlocked'), 6000); };
  try { rec.start(); } catch { end(); return null; }
  btn.classList.add('is-rec'); btn.setAttribute('aria-pressed', 'true');
  return () => { try { rec.stop(); } catch { /* stopped */ } end(); };
}

/** Opens the sheet inside the chat window; to: { sid } (a conversation) or { dir } (a folder) to start with; text. */
export async function openTaskSheet(host, { to = null, text = '', agent = null } = {}) {
  const sequence = ++sheetSequence;
  activeSheet?.remove();
  let stopMic = null;
  const r = await officeRequest('tasks.metadata', {}).then((x) => x.json()).catch(() => null);
  if (sequence !== sheetSequence) return;
  const sheet = activeSheet = el('div', 'zc-task'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', tr('chat.task.title'));
  const head = el('div', 'zc-task-head'), close = el('button', 'zc-ib'); close.type = 'button'; close.title = tr('chat.close'); close.append(icon('x'));
  close.addEventListener('click', () => { stopMic?.(); sheet.remove(); if (activeSheet === sheet) activeSheet = null; });
  head.append(el('b', null, `📋 ${tr('chat.task.title')}`), close);
  sheet.append(head);
  if (!r?.ok) { sheet.append(el('p', 'zc-task-note', tr('drawer.unreachable'))); host.append(sheet); return; }
  if (!r.allowed) { sheet.append(el('p', 'zc-task-note', tr('chat.task.notAllowed'))); host.append(sheet); return; }
  // who it goes to: the conversations (their folder), then "a new one in…" each folder
  const toSid = to?.id ? r.sessions.find((s) => s.id === to.id)?.sid : to?.sid;
  let pick = toSid ? { sid: toSid, agent: r.sessions.find((s) => s.sid === toSid)?.agent || 'claude' } : to?.dir ? { dir: to.dir } : r.sessions[0] ? { sid: r.sessions[0].sid, agent: r.sessions[0].agent } : r.projects[0] ? { dir: r.projects[0].dir } : null;
  if (agent && !toSid && r.projects[0]) pick = { dir: to?.dir || r.projects[0].dir, agent: agent === 'codex' && r.codex?.available && r.codex?.enabled ? 'codex' : 'claude' };
  const agentLabel = el('label', 'zc-task-note', tr('chat.codex.agent'));
  const agentSelect = el('select', 'zc-task-in'); agentSelect.setAttribute('aria-label', tr('chat.codex.agent'));
  for (const [value, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) { const o = el('option', null, label); o.value = value; o.disabled = value === 'codex' && (!r.codex?.available || !r.codex?.enabled); agentSelect.append(o); }
  agentSelect.value = pick?.agent || 'claude';
  agentSelect.addEventListener('change', () => { if (pick && !pick.sid) pick.agent = agentSelect.value; sync(); });
  agentLabel.append(agentSelect);
  const modelLabel = el('label', 'zc-task-note', tr('chat.codex.model')), modelSelect = el('select', 'zc-task-in');
  modelSelect.setAttribute('aria-label', tr('chat.codex.model'));
  const autoModel = el('option', null, tr('chat.codex.defaultModel')); autoModel.value = ''; modelSelect.append(autoModel);
  for (const m of r.codex?.models || []) { const o = el('option', null, m.name); o.value = m.id; modelSelect.append(o); }
  modelLabel.append(modelSelect);
  const effortLabel = el('label', 'zc-task-note', tr('chat.codex.effort')), effortSelect = el('select', 'zc-task-in');
  effortSelect.setAttribute('aria-label', tr('chat.codex.effort')); effortLabel.append(effortSelect);
  const drawEfforts = () => {
    effortSelect.replaceChildren(); const auto = el('option', null, tr('chat.codex.defaultEffort')); auto.value = ''; effortSelect.append(auto);
    const model = r.codex?.models?.find((m) => m.id === modelSelect.value);
    for (const effort of model?.efforts || []) { const o = el('option', null, effort); o.value = effort; effortSelect.append(o); }
  };
  drawEfforts(); modelSelect.addEventListener('change', () => { drawEfforts(); sync(); });
  const limits = el('p', 'zc-task-note');
  const windows = (r.codex?.limits?.buckets || []).flatMap((b) => b.windows.map((w) => tr('chat.codex.limitWindow', { name: b.name, window: w.minutes >= 1440 ? tr('time.day', { n: w.minutes / 1440 }) : w.minutes >= 60 ? tr('time.hour', { n: w.minutes / 60 }) : tr('time.min', { n: w.minutes }),
    at: w.resetsAt ? new Date(w.resetsAt).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–', pct: Math.round(100 - w.pct) })));
  limits.textContent = windows.slice(0, 6).join('\n') || tr('chat.codex.limitsUnavailable');
  limits.style.whiteSpace = 'pre-line';
  if (r.codex?.limits?.at) limits.title = tr('chat.codex.limitsAsOf', { at: new Date(r.codex.limits.at).toLocaleString(locale()) });
  const list = el('div', 'zc-task-list');
  const option = (key, label, sub, face, sel) => {
    const b = el('button', `zc-task-o${sel ? ' is-on' : ''}`); b.type = 'button';
    const t = el('span', 'zc-men-t'); t.append(el('b', null, label), el('small', null, sub)); b.append(face, t);
    b.addEventListener('click', () => { pick = { ...key, agent: key.agent || agentSelect.value }; agentSelect.value = pick.agent; for (const x of list.querySelectorAll('.zc-task-o')) x.classList.toggle('is-on', x === b); sync(); });
    return b;
  };
  if (r.sessions.length) list.append(el('small', 'zc-task-h', tr('chat.task.conversations')));
  for (const s of r.sessions) list.append(option({ sid: s.sid, agent: s.agent || 'claude' }, s.name, `${s.agent === 'codex' ? 'Codex' : 'Claude'} · 📁 ${s.dir}`, avatar({ ...(who(s.id) || {}), key: s.id, name: s.name }, 30), pick?.sid === s.sid));
  if (r.projects.length) list.append(el('small', 'zc-task-h', tr('chat.task.newIn')));
  for (const p of r.projects) { const f = el('span', 'zc-task-folder', '📁'); list.append(option({ dir: p.dir }, p.name, p.dir, f, pick?.dir === p.dir && !pick.sid)); }
  // what to do: typed or spoken, and photos
  const field = el('textarea', 'zc-task-in'); field.rows = 4; field.maxLength = 4000; field.placeholder = tr('chat.task.placeholder'); field.value = text;
  field.addEventListener('keydown', (e) => e.stopPropagation());
  const photos = [], thumbs = el('div', 'zc-task-thumbs');
  const drawThumbs = () => thumbs.replaceChildren(...photos.map((u, i) => { const t = el('span', 'zc-task-thumb'), img = el('img'), x = el('button', null, '✕'); img.src = u; img.alt = tr('chat.task.imageAlt', { n: i + 1 }); x.type = 'button'; x.setAttribute('aria-label', tr('chat.task.removeImage', { n: i + 1 })); x.addEventListener('click', () => { photos.splice(i, 1); drawThumbs(); sync(); }); t.append(img, x); return t; }));
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.hidden = true;
  file.addEventListener('change', () => { if (!sending) imageQueue.add([...file.files]); file.value = ''; });
  field.addEventListener('paste', (event) => pastePromptImages(event, (files) => imageQueue.add(files), !sending));
  const mic = el('button', 'zc-task-tool'); mic.type = 'button'; mic.title = tr('chat.task.mic'); mic.append(icon('mic'), el('span', null, tr('chat.task.mic')));
  mic.addEventListener('click', () => { if (stopMic) { stopMic(); stopMic = null; } else stopMic = dictate(mic, field, sync); });
  const cam = el('button', 'zc-task-tool'); cam.type = 'button'; cam.title = tr('chat.task.photo'); cam.append(icon('image'), el('span', null, tr('chat.task.photo')));
  cam.addEventListener('click', () => file.click());
  const tools = el('div', 'zc-task-tools'); tools.append(mic, cam, file);
  const go = el('button', 'zc-task-go', tr('chat.task.send')); go.type = 'button';
  const note = el('p', 'zc-task-note'), status = el('p', 'zc-task-note'); status.setAttribute('role', 'status');
  const imageHint = el('p', 'zc-task-note', tr('chat.task.imageHint', { n: MAX_PROMPT_IMAGES }));
  imageHint.id = 'zc-task-image-hint'; field.setAttribute('aria-describedby', imageHint.id);
  const desktopOption = el('label', 'zc-task-desktop'), desktopAuto = el('input'); desktopAuto.type = 'checkbox';
  desktopAuto.checked = !!r.desktop?.autoOpen;
  desktopOption.append(desktopAuto, el('span', null, tr('chat.codex.desktopAutoOpen')));
  let sending = false, desktopSaving = false;
  const sync = () => {
    const codex = pick?.agent === 'codex';
    agentSelect.disabled = sending || !!pick?.sid; go.disabled = sending || desktopSaving || !!imageQueue.pending || !pick || (!field.value.trim() && !photos.length); note.textContent = tr(codex ? 'chat.codex.taskNote' : 'chat.task.note');
    desktopOption.hidden = !codex || !r.desktop?.canConfigure;
    desktopAuto.disabled = sending || desktopSaving || !r.desktop?.enabled;
    thumbs.setAttribute('aria-busy', String(!!imageQueue.pending));
    for (const control of [field, modelSelect, effortSelect, cam, mic, ...list.querySelectorAll('button'), ...thumbs.querySelectorAll('button')]) control.disabled = sending;
    modelLabel.hidden = limits.hidden = !codex; effortLabel.hidden = !codex || !modelSelect.value;
  };
  const imageQueue = createImageQueue({ images: () => photos, current: () => activeSheet === sheet && sheet.isConnected,
    changed: () => { drawThumbs(); sync(); }, busy: sync,
    limit: (n) => toast(tr('chat.task.imageLimit', { n })), error: () => toast(tr('chat.task.imageFailed')) });
  desktopAuto.addEventListener('change', async () => {
    desktopSaving = true; sync();
    try {
      const response = await officeRequest('tasks.desktop', { on: desktopAuto.checked });
      const result = await response.json();
      if (!result.ok) throw new Error(result.message || tr('drawer.unreachable'));
      r.desktop = result.desktop;
    } catch (error) { desktopAuto.checked = !!r.desktop?.autoOpen; toast(error.message || tr('drawer.unreachable')); }
    finally { desktopSaving = false; sync(); }
  });
  field.addEventListener('input', sync);
  go.addEventListener('click', async () => {
    if (sending || desktopSaving || imageQueue.pending) return;
    stopMic?.(); stopMic = null; sending = true; sync(); go.textContent = tr('chat.task.sending'); status.textContent = '';
    const res = await sendTaskRequest({ ...pick, agent: pick.agent || agentSelect.value,
      ...(pick.agent === 'codex' && modelSelect.value ? { model: modelSelect.value, effort: effortSelect.value } : {}), text: field.value.trim() || tr('chat.to.photoOnly'), images: [...photos], fresh: !!pick.dir });
    if (res?.ok) { toast(tr('chat.task.started'), 5000); sheet.remove(); if (activeSheet === sheet) activeSheet = null; return; }
    status.textContent = taskRequestMessage(res); sending = false; go.textContent = tr('chat.task.send'); sync();
  });
  sheet.append(list, agentLabel, modelLabel, effortLabel, limits, field, imageHint, thumbs, tools, note, desktopOption, status, go);
  if (r.codex?.error) sheet.append(el('p', 'zc-task-note', `Codex: ${r.codex.error}`));
  if (r.running.length) sheet.append(el('p', 'zc-task-note', tr('chat.task.running', { n: r.running.length })));
  host.append(sheet);
  sync(); setTimeout(() => field.focus({ preventScroll: true }), 50);
}
