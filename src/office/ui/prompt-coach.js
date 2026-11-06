import { officeRequest } from '../net/api.js';
// Shared prompt hints. Rules run locally; a rewrite only runs after an explicit click.
import { el } from '../core/env.js';
import { icon } from './icons.js';
import { coach, numberTasks } from '../../shared/prompt-coach.js';
import { t as tr, lang } from '../../i18n/index.js';

export function createPromptCoach({ input, photos = () => 0, enabled = () => true, quoted = () => false,
  current = () => true, key = () => '', changed = () => {}, error = () => {} }) {
  const element = el('div', 'zc-coach'), dismissed = new Set();
  element.hidden = true; element.setAttribute('role', 'status'); element.setAttribute('aria-label', tr('chat.coach.label'));
  let timer, undo = null, request = null;
  const on = () => { try { return localStorage.getItem('office-coach') !== 'off'; } catch { return true; } };
  function setDraft(text, caret = text.length) {
    input.value = text; changed(); input.focus({ preventScroll: true }); input.setSelectionRange(caret, caret);
  }
  const addLine = (line) => setDraft(`${input.value.replace(/\s+$/, '')}\n${line}`);
  const chipsFor = {
    photoBare: ['fixPhoto', 'likePhoto', 'explainPhoto', 'fillPhoto'].map((k) => [k, () => setDraft(`${tr(`chat.coach.chip.${k}Text`)}${input.value.trim()}`)]),
    vague: ['notOld', 'criteria', 'example'].map((k) => [k, () => addLine(tr(`chat.coach.chip.${k}Text`))]),
    dangling: [['quote', (h) => {
      const v = input.value, at = h.phrase ? v.indexOf(h.phrase) : -1, end = at < 0 ? v.replace(/\s+$/, '').length : at + h.phrase.length;
      setDraft(`${v.slice(0, end)} “”${v.slice(end)}`, end + 2);
    }]],
    multi: [['number', () => setDraft(numberTasks(input.value.trim(), tr('chat.coach.chip.inOrder')))]],
    tooShort: [['result', () => addLine(tr('chat.coach.chip.resultText'))]],
  };
  function draw() {
    clearTimeout(timer);
    if (request) return;
    const text = input.value;
    if (!text.trim() && !photos()) dismissed.clear();
    if (undo && text !== undo.after) undo = null;
    const show = current() && enabled() && on(), hint = show && !undo
      ? coach({ text, photos: photos(), quoted: quoted(), lang: lang() }).find((h) => !dismissed.has(h.id)) : null;
    element.hidden = !show || (!hint && !undo);
    if (element.hidden) { element.replaceChildren(); delete element.dataset.hint; return; }
    const chips = el('div', 'zc-coach-chips'), close = el('button', 'zc-coach-x'); close.type = 'button'; close.title = tr('chat.coach.close'); close.setAttribute('aria-label', close.title); close.append(icon('x'));
    const chip = (k, text, run, cls = 'zc-coach-c') => {
      const b = el('button', cls, text); b.type = 'button'; b.dataset.k = k;
      b.addEventListener('pointerdown', (e) => e.preventDefault()); b.addEventListener('click', () => run(b)); return b;
    };
    element.classList.toggle('is-done', !!undo);
    if (undo) {
      element.dataset.hint = 'rewritten';
      chips.append(chip('undo', tr('chat.coach.undo'), () => { const text = undo.before; undo = null; setDraft(text); draw(); }));
      close.addEventListener('click', () => { undo = null; draw(); });
      element.replaceChildren(el('i', 'zc-coach-ic', '✨'), el('span', 'zc-coach-t', tr('chat.coach.rewritten')), chips, close); return;
    }
    element.dataset.hint = hint.id;
    const done = () => { dismissed.add(hint.id); element.hidden = true; };
    for (const [k, run] of chipsFor[hint.id]) chips.append(chip(k, tr(`chat.coach.chip.${k}`), () => { done(); run(hint); }));
    close.addEventListener('click', done);
    element.replaceChildren(el('i', 'zc-coach-ic', '💡'), el('span', 'zc-coach-t', tr(`chat.coach.${hint.id}`, { phrase: hint.phrase || '', n: hint.n || 2 })), close, chips);
    if (text.trim()) { const ai = chip('rewrite', tr('chat.coach.rewrite'), rewrite, 'zc-coach-ai'); ai.title = tr('chat.coach.rewriteTitle'); element.append(ai); }
  }
  async function rewrite(btn) {
    const before = input.value, context = key(); if (request || !current() || !enabled() || !before.trim()) return;
    const controller = request = new AbortController(); input.readOnly = true; changed(); btn.disabled = true; btn.textContent = tr('chat.coach.rewriting'); element.classList.add('is-busy');
    try {
      const response = await officeRequest('prompt.rewrite', { text: before, lang: lang(), photos: photos() }, { signal: controller.signal });
      const result = await response.json();
      if (request !== controller || !current() || key() !== context) return;
      if (!response.ok || !result?.ok || typeof result.text !== 'string') throw new Error(result?.message || tr('drawer.unreachable'));
      if (input.value === before) { undo = { before, after: result.text }; setDraft(result.text); }
    } catch (e) { if (e.name !== 'AbortError' && request === controller && current() && key() === context) error(e.message || tr('drawer.unreachable')); }
    finally { if (request === controller) { request = null; input.readOnly = false; element.classList.remove('is-busy'); changed(); draw(); } }
  }
  return {
    element, get busy() { return !!request; }, draw,
    schedule() { clearTimeout(timer); if (!input.value.trim() && !photos()) draw(); else timer = setTimeout(draw, 400); },
    reset() { clearTimeout(timer); request?.abort(); request = null; input.readOnly = false; undo = null; dismissed.clear(); element.classList.remove('is-busy'); element.hidden = true; element.replaceChildren(); delete element.dataset.hint; },
  };
}
