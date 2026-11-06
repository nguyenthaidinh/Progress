// Render assistant Markdown with DOM nodes, never raw HTML.
import { el } from '../core/env.js';

function inline(text) {
  const f = document.createDocumentFragment(), re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\((?:https?:\/\/)[^)\s]+\)|https?:\/\/[^\s<>()]+)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) f.append(text.slice(at, m.index));
    const t = m[0];
    if (t[0] === '`') f.append(el('code', null, t.slice(1, -1)));
    else if (t.startsWith('**') || t.startsWith('__')) { const b = el('b'); b.append(inline(t.slice(2, -2))); f.append(b); }
    else if (t[0] === '*') { const i = el('i'); i.append(inline(t.slice(1, -1))); f.append(i); }
    else {
      const [label, href] = t[0] === '[' ? [t.slice(1, t.indexOf('](')), t.slice(t.indexOf('](') + 2, -1)] : [t, t];
      const a = el('a', null, label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; f.append(a);
    }
    at = m.index + t.length;
  }
  if (at < text.length) f.append(text.slice(at));
  return f;
}
export function md(text) {
  const f = document.createDocumentFragment(), lines = text.split('\n');
  let list = null, para = null;
  const end = () => { list = null; para = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {   // a code block (to its closing fence, or the end)
      const code = []; for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = el('pre'); pre.append(el('code', null, code.join('\n'))); f.append(pre); end(); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {   // a table: its rows (the |---| line under the head skipped)
      const rows = []; for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
      i--;
      const box = el('div', 'zc-md-table'), table = el('table');
      rows.forEach((r, k) => { const tr = el('tr'); for (const c of r) { const td = el(k ? 'td' : 'th'); td.append(inline(c)); tr.append(td); } table.append(tr); });
      box.append(table); f.append(box); end(); continue;
    }
    if (!l.trim()) { end(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { const b = el('div', `zc-md-h zc-md-h${h[1].length}`); b.append(inline(h[2])); f.append(b); end(); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) { f.append(el('hr')); end(); continue; }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (q) { const b = el('div', 'zc-md-q'); b.append(inline(q[1])); f.append(b); end(); continue; }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      const kind = /\d/.test(li[2]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== kind) { list = el(kind); if (kind === 'ol') list.start = parseInt(li[2], 10) || 1; f.append(list); }
      const item = el('li'); if (li[1].length >= 2) item.className = 'zc-md-sub'; item.append(inline(li[3])); list.append(item); para = null; continue;
    }
    if (para) para.append(el('br'), inline(l)); else { para = el('p'); para.append(inline(l)); f.append(para); list = null; }
  }
  return f;
}
