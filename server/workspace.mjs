// Separate AI conversation history: bounded local storage, atomic writes and no automatic replay after a restart.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact } from './redact.mjs';

const ACTIVE = new Set(['starting', 'work', 'wait', 'stopping']);
const uuid = (s) => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
const clean = (s, max) => redact(String(s || '')).slice(0, max);
export function createWorkspace(dataDir, { changed = () => {}, now = Date.now, maxConversations = 30, maxTurns = 20 } = {}) {
  const file = path.join(dataDir, 'workspace.json'), conversations = new Map();
  let revision = 0, timer = null, fault = false;
  try {
    if (fs.statSync(file).size > 32_000_000) throw new Error('Workspace history is too large');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.conversations) || data.conversations.length > maxConversations) throw new Error('Invalid workspace history');
    for (const c of data.conversations) {
      if (!uuid(c.id) || conversations.has(c.id) || !['codex', 'claude'].includes(c.agent) || !path.isAbsolute(c.dir)
        || !Array.isArray(c.turns) || c.turns.length > maxTurns || c.turns.some((t) => !uuid(t.id) || typeof t.prompt !== 'string' || !Array.isArray(t.steps) || !Array.isArray(t.notes))) throw new Error('Invalid conversation');
      for (const t of c.turns) if (ACTIVE.has(t.status)) { t.status = 'interrupted'; t.endedAt = now(); }
      conversations.set(c.id, c);
    }
  } catch (e) { if (e.code !== 'ENOENT') fault = true; }
  function save() {
    clearTimeout(timer); timer = null;
    fs.mkdirSync(dataDir, { recursive: true });
    const text = JSON.stringify({ version: 1, conversations: [...conversations.values()] });
    if (Buffer.byteLength(text) > 32_000_000) throw new Error('Workspace history is full');
    const tmp = `${file}.tmp-${process.pid}`, fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  function touch(c, immediate = false) {
    c.updatedAt = now(); revision++; changed(revision);
    if (immediate) { try { save(); } catch { fault = true; } }
    else if (!timer) { timer = setTimeout(() => { try { save(); } catch { fault = true; } }, 400); timer.unref?.(); }
  }
  const locate = (scope) => { const c = conversations.get(scope?.conversationId), t = c?.turns.find((t) => t.id === scope?.turnId); return t ? { c, t } : null; };
  return {
    get: (id) => conversations.get(id) || null,
    hasSid: (sid) => !!sid && [...conversations.values()].some((c) => c.sid === sid),
    begin({ conversationId, agent, dir, text, images = 0, account = '' }) {
      if (fault) throw new Error('workspaceStore');
      if (!['codex', 'claude'].includes(agent) || !path.isAbsolute(dir)) throw new Error('noDir');
      const previous = new Map(conversations), original = conversationId && conversations.get(conversationId);
      if (conversationId && !original) throw new Error('workspaceMissing');
      if (original && (original.agent !== agent || original.dir !== dir)) throw new Error('workspaceMissing');
      if (original?.turns.some((t) => ACTIVE.has(t.status))) throw new Error('busy');
      if (original?.turns.at(-1)?.status === 'interrupted') throw new Error('workspaceInterrupted');
      if (!original && conversations.size >= maxConversations) {
        const oldest = [...conversations.values()].filter((c) => !c.turns.some((t) => ACTIVE.has(t.status))).sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!oldest) throw new Error('workspaceFull');
        conversations.delete(oldest.id);
      }
      const c = original ? { ...original, turns: maxTurns > 1 ? original.turns.slice(-(maxTurns - 1)) : [] } : { id: crypto.randomUUID(), agent, dir, sid: null, account,
        title: clean(text, 72).replace(/\s+/g, ' '), createdAt: now(), updatedAt: now(), turns: [] };
      const t = { id: crypto.randomUUID(), task: null, at: now(), status: 'starting', prompt: clean(text, 4000), images: Math.min(4, Math.max(0, images)), steps: [], n: 0, result: '', error: '', notes: [] };
      c.turns.push(t); c.updatedAt = now(); conversations.set(c.id, c);
      try { save(); } catch { conversations.clear(); for (const [id, c] of previous) conversations.set(id, c); fault = true; throw new Error('workspaceStore'); }
      revision++; changed(revision);
      return { conversationId: c.id, turnId: t.id };
    },
    started(scope, task) {
      const found = locate(scope); if (!found) return;
      const { c, t } = found; t.task = task.id; if (task.sid) c.sid = task.sid;
      if (t.status === 'starting') t.status = 'work'; touch(c, true);
    },
    step(scope, label, sid) {
      const found = locate(scope); if (!found || !ACTIVE.has(found.t.status)) return;
      const { c, t } = found; if (sid) c.sid = sid;
      t.steps.push(clean(label, 200)); t.steps = t.steps.slice(-40); t.n++;
      if (t.status === 'starting') t.status = 'work'; touch(c);
    },
    state(scope, status) { const x = locate(scope); if (x && ACTIVE.has(x.t.status) && ACTIVE.has(status)) { x.t.status = status; touch(x.c); } },
    desktop(scope, status) { const x = locate(scope); if (x) { x.t.desktop = status; touch(x.c); } },
    finish(scope, task) {
      const x = locate(scope); if (!x) return;
      if (task.sid) x.c.sid = task.sid;
      x.t.task ||= task.id || null; x.t.endedAt = now(); x.t.status = task.stopped ? 'stopped' : task.error ? 'failed' : 'done';
      x.t.result = clean(task.result, 16000); x.t.error = clean(task.error, 1000); touch(x.c, true);
    },
    note(task, text) { const x = this.byTask(task); if (x) { const item = locate(x); item.t.notes.push({ at: now(), text: clean(text, 2000) }); item.t.notes = item.t.notes.slice(-20); touch(item.c, true); } },
    byTask(task) { for (const c of conversations.values()) { const t = c.turns.find((t) => t.task === task); if (t) return { conversationId: c.id, turnId: t.id }; } return null; },
    snapshot(id) {
      const c = conversations.get(id), summaries = [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => ({ id: c.id, agent: c.agent, title: c.title, dir: c.dir, sid: c.sid,
        updatedAt: c.updatedAt, status: c.turns.at(-1)?.status || 'done', turns: c.turns.length }));
      return { ok: true, revision, error: fault ? 'workspaceStore' : '', conversations: summaries,
        conversation: c ? { id: c.id, agent: c.agent, title: c.title, dir: c.dir, sid: c.sid, turns: c.turns.map((t) => ({ ...t, steps: [...t.steps], notes: [...(t.notes || [])] })) } : null };
    },
    close() { clearTimeout(timer); if (!fault) try { save(); } catch { /* Leave the last complete snapshot intact. */ } },
  };
}
