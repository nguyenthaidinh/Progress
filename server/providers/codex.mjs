// Codex adapter: observe saved threads without resuming them; control only office-owned forks/new threads.
import path from 'node:path';
import crypto from 'node:crypto';
import { createCodexRpc, findCodex } from './codex-rpc.mjs';
import { redact } from '../redact.mjs';
import { createCodexState } from './codex-state.mjs';
import { codexUsage, createCodexUsageReader } from './codex-usage.mjs';

const clean = (x, n = 400) => redact(String(x || '')).slice(0, n);
const millis = (t) => typeof t === 'number' ? t < 1e12 ? t * 1000 : t : Date.parse(t) || 0;
export function codexLimits(data, at = Date.now()) {
  const buckets = data?.rateLimitsByLimitId ? Object.entries(data.rateLimitsByLimitId) : data?.rateLimits ? [[data.rateLimits.limitId || 'codex', data.rateLimits]] : [];
  return { at, buckets: buckets.slice(0, 12).map(([id, b]) => ({ id: clean(id, 100), name: clean(b?.limitName || id, 100), plan: clean(b?.planType, 50),
    windows: ['primary', 'secondary'].flatMap((key) => {
      const w = b?.[key]; return w && Number.isFinite(w.usedPercent) ? [{ key, pct: Math.max(0, Math.min(100, w.usedPercent)), minutes: Number(w.windowDurationMins) || 0, resetsAt: millis(w.resetsAt) }] : [];
    }) })) };
}
export function codexItem(item) {
  switch (item.type) {
    case 'userMessage': return { role: 'user', text: clean((item.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n'), 8000) };
    case 'agentMessage': return { role: 'claude', text: clean(item.text, 12000) };
    case 'commandExecution': {
      const actions = item.commandActions || [];
      const type = actions.length && actions.every((a) => a.type === 'read') ? 'read'
        : actions.length && actions.every((a) => a.type === 'search') ? 'grep'
          : actions.length && actions.every((a) => a.type === 'listFiles') ? 'glob' : 'bash';
      return { role: 'tool', type, label: clean(type === 'read' ? actions.map((a) => a.name || a.path).join(', ') : item.command, 80) };
    }
    case 'fileChange': return { role: 'tool', type: 'edit', label: clean((item.changes || []).map((x) => path.basename(x.path || '')).join(', '), 80) };
    case 'webSearch': return { role: 'tool', type: 'web', label: clean(item.query, 80) };
    case 'mcpToolCall': return { role: 'tool', type: 'mcp', label: clean(`${item.server || ''} · ${item.tool || ''}`, 80) };
    default: return null;
  }
}
export function codexStatus(thread, turn, now = Date.now()) {
  const state = thread.status;
  if (state?.type === 'active') return state.activeFlags?.some((x) => /waiting/i.test(x)) ? 'wait' : 'work';
  // A separate app-server cannot know whether another process still owns an old in-progress turn.
  // Expire that inference; never pretend an old saved thread is a live process.
  if (turn?.status === 'inProgress' && now - millis(thread.updatedAt) < 10 * 60_000) return 'work';
  return 'rest';
}

export function createCodex({ onSession = () => {}, onEvent = () => {}, onGone = () => {}, onApproval = () => {},
  onResolved = () => {}, onDone = () => {}, onStep = () => {}, onTaskState = () => {}, rpcFactory = createCodexRpc,
  binary = findCodex, now = Date.now, idleMs = 30 * 60_000, enabled = process.env.OFFICE_CODEX !== '0', dataDir = null,
  usageReader = createCodexUsageReader() } = {}) {
  const threads = new Map(), runs = new Map(), approvals = new Map(), recent = [], creating = new Map();
  const ownership = createCodexState(dataDir);
  let polling = null, timer = null, stopped = false, lastError = '', connected = false, retryAt = 0;
  let metadata = null, models = [], modelError = '', limits = null, limitsError = '', metadataAt = 0;
  const rpc = rpcFactory({ binary, onNotification: notification, onRequest: serverRequest, onDisconnect: (error) => {
    connected = false;
    lastError = clean(error?.message || 'Codex disconnected'); retryAt = now() + 30_000;
    for (const a of approvals.values()) onResolved(a.id);
    approvals.clear();
    for (const t of [...runs.values()]) finish(t, 'Codex disconnected');
  } });
  const runFor = (sid) => [...runs.values()].find((x) => x.sid === sid);
  const ownRun = ({ task, sid, dir } = {}) => task ? runs.get(task) : sid ? runFor(ownership.resolve(`thread:${sid}`, threads.get(sid)?.cwd || '') || sid)
    : dir ? runFor(ownership.resolve(`dir:${dir}`, dir)) : null;
  function publish(t, turn = null) {
    if (turn) { t.turn = turn; t.log = (turn.items || []).map(codexItem).filter(Boolean); }
    const items = t.log || [], user = items.findLast((x) => x.role === 'user'), reply = items.findLast((x) => x.role === 'claude');
    const active = runFor(t.id), counts = { read: 0, edit: 0, cmd: 0, web: 0 };
    for (const i of items) { if (i.type === 'bash') counts.cmd++; if (['read', 'grep', 'glob'].includes(i.type)) counts.read++; if (i.type === 'edit') counts.edit++; if (i.type === 'web') counts.web++; }
    const last = items.findLast((x) => x.role === 'tool');
    const waiting = [...approvals.values()].some((x) => x.sid === t.id);
    onSession({ sid: t.id, cwd: t.cwd || '', title: clean(t.name || t.preview, 80), name: path.basename(t.cwd || '') || 'Codex',
      status: waiting ? 'wait' : active ? 'work' : codexStatus(t, t.turn, now()),
      observed: !t.owned, lastAt: millis(t.updatedAt) || now(), createdAt: millis(t.createdAt) || now(),
      lastPrompt: clean(user?.text || t.preview, 90), lastReply: clean(reply?.text, 240),
      source: typeof t.source === 'string' ? t.source : 'agent', counts, last: last ? { type: last.type, label: last.label } : null,
      task: active?.id || null, usage: t.usage || null, stopping: !!active?.stopping });
  }
  function finish(t, error = '') {
    if (!runs.has(t.id)) return;
    runs.delete(t.id); clearTimeout(t.stopTimer);
    for (const [id, a] of approvals) if (a.sid === t.sid) { approvals.delete(id); onResolved(id); }
    const thread = threads.get(t.sid);
    if (thread) { thread.status = { type: 'idle' }; thread.updatedAt = now() / 1000; if (thread.turn) thread.turn.status = t.stopped ? 'interrupted' : error ? 'failed' : 'completed'; publish(thread); }
    const { commands, stopTerminal, stopSettling, stopError, ...done } = t;
    onDone({ ...done, error: clean(error), result: clean(t.result, 16000) });
  }
  function emitItem(sid, item) {
    const t = threads.get(sid); if (!t) return;
    const mapped = codexItem(item); if (!mapped) return;
    const key = item.id || `${item.type}:${mapped.label || mapped.text}`;
    // Only file approval previews need raw item data. Never retain large command outputs in every session.
    if (item.type === 'fileChange') {
      let remaining = 12_000;
      const changes = (item.changes || []).slice(0, 100).map((x) => {
        const diff = String(x.diff || '').slice(0, remaining); remaining -= diff.length;
        return { path: String(x.path || '').slice(0, 512), diff };
      });
      t.rawItems.set(key, { changes });
      while (t.rawItems.size > 32) t.rawItems.delete(t.rawItems.keys().next().value);
    }
    const sig = `${item.status || ''}:${mapped.text || mapped.label}`;
    const prev = t.seen.get(key); t.seen.set(key, sig);
    if (prev === sig) return;
    // Refresh existing streamed items rather than adding duplicate log entries.
    t.items.set(key, mapped); t.log = [...t.items.values()].slice(-160);
    for (const map of [t.items, t.seen, t.rawItems]) while (map.size > 400) map.delete(map.keys().next().value);
    const run = runFor(sid);
    if (run && item.type === 'commandExecution' && item.id) run.commands.add(item.id);
    if (mapped.role === 'claude' && run) run.result = mapped.text;
    if (prev == null && mapped.role === 'tool') {
      onEvent(sid, { type: mapped.type, label: mapped.label });
      if (run) onStep(run, mapped);
    }
    if (item.status === 'failed') onEvent(sid, { type: 'fail', label: mapped.label || 'Codex' });
  }
  function completeRun(run, turn) {
    if (run.stopSettling) { run.stopTerminal = turn; return; }
    delete run.stopTerminal;
    for (const item of turn?.items || []) emitItem(run.sid, item);
    const final = (turn?.items || []).findLast((i) => i.type === 'agentMessage' && i.phase !== 'commentary');
    if (final) run.result = clean(final.text, 16000);
    run.stopped = turn?.status === 'interrupted' && !run.stopError;
    finish(run, run.stopError || (!['completed', 'interrupted'].includes(turn?.status) ? turn?.error?.message || 'Codex turn failed' : ''));
  }
  async function runTerminals(run) {
    const terminals = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await rpc.call('thread/backgroundTerminals/list', { threadId: run.sid, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Codex could not confirm its background terminals');
      terminals.push(...result.data.filter((p) => run.commands.has(p.itemId)));
      cursor = result.nextCursor;
      if (!cursor) return terminals;
    }
    throw new Error('Codex terminal list exceeded its page limit');
  }
  async function cleanRunTerminals(run) {
    // Use thread-scoped protocol IDs, never treat an opaque processId as an OS PID.
    // Leave terminals from previous turns and unrelated threads alone.
    for (const terminal of await runTerminals(run)) {
      const result = await rpc.call('thread/backgroundTerminals/terminate', { threadId: run.sid, processId: terminal.processId });
      if (!result.terminated && (await runTerminals(run)).some((p) => p.processId === terminal.processId)) throw new Error('Codex did not confirm terminal termination');
    }
  }
  async function notification({ method, params: p = {} }) {
    if (method === 'account/rateLimits/updated') { limits = codexLimits(p, now()); limitsError = ''; return; }
    const sid = p.threadId || p.thread?.id, t = threads.get(sid);
    if (method === 'serverRequest/resolved') {
      for (const [id, a] of approvals) if (a.requestId === p.requestId && (!sid || a.sid === sid)) {
        approvals.delete(id); onResolved(id);
        const run = runFor(a.sid); if (run) onTaskState(run, run.stopping ? 'stopping' : 'work');
        const thread = threads.get(a.sid); if (thread) publish(thread);
      }
      return;
    }
    if (!t) return;
    // A late event from a previous turn must not complete or alter the current task.
    const current = runFor(sid), eventTurn = p.turnId || p.turn?.id;
    if (current?.turnId && eventTurn && current.turnId !== eventTurn) return;
    t.updatedAt = now() / 1000;
    if (method === 'thread/status/changed') t.status = p.status;
    if (method === 'turn/started') { t.turn = p.turn; const run = runFor(sid); if (run) run.turnId = p.turn.id; onEvent(sid, { type: 'prompt', label: '' }); }
    if ((method === 'item/started' || method === 'item/completed') && p.item) emitItem(sid, p.item);
    if (method === 'thread/tokenUsage/updated') {
      const usage = codexUsage(p.tokenUsage, t.model, now()); if (usage) t.usage = usage;
    }
    if (method === 'turn/completed') {
      t.turn = p.turn; const run = runFor(sid);
      if (run) completeRun(run, p.turn);
      onEvent(sid, { type: p.turn?.status === 'failed' ? 'fail' : 'stop', label: '' });
    }
    publish(t);
  }
  function serverRequest(msg) {
    const p = msg.params || {}, run = runFor(p.threadId), t = threads.get(p.threadId);
    // Never answer requests belonging to an unrelated client/session.
    if (!run || !t || (p.turnId && run.turnId && p.turnId !== run.turnId)) { rpc.reject(msg.id); return; }
    const command = msg.method === 'item/commandExecution/requestApproval', file = msg.method === 'item/fileChange/requestApproval';
    const ask = msg.method === 'item/tool/requestUserInput';
    if (!command && !file && !ask) { rpc.reject(msg.id); return; }
    const id = `codex-${crypto.randomUUID()}`;
    const proposed = t.rawItems.get(p.itemId);
    const details = file ? (proposed?.changes || []).map((x) => `${x.path}\n${x.diff || ''}`).join('\n') : '';
    const network = p.networkApprovalContext ? JSON.stringify(p.networkApprovalContext) : '';
    const a = { id, requestId: msg.id, sid: p.threadId, kind: ask ? 'ask' : 'perm',
      type: command ? 'bash' : file ? 'edit' : 'ask', tool: command ? 'Bash' : file ? 'Edit' : 'AskUserQuestion',
      label: clean(command ? p.command || p.reason : file ? p.reason || p.grantRoot || 'File changes' : 'Codex'),
      detail: clean([p.command, p.reason, p.grantRoot, network, details].filter(Boolean).join('\n'), 12000),
      questions: ask ? (p.questions || []).map((q) => ({ question: clean(q.question, 1000), header: clean(q.header), secret: !!q.isSecret, options: (q.options || []).map((o) => ({ label: clean(o.label), description: clean(o.description) })), multiSelect: false })) : undefined,
      originalQuestions: ask ? p.questions : null, available: p.availableDecisions, at: now(), until: 0, remember: null };
    approvals.set(id, a); onApproval(a); onTaskState(run, 'wait', a); publish(t);
  }
  function answer(id, choice, answers = []) {
    const a = approvals.get(id); if (!a) return false;
    let result;
    if (a.kind === 'ask') {
      if (choice !== 'answer') return false;
      if (!Array.isArray(answers)) return false;
      const entries = [];
      for (const [i, q] of a.originalQuestions.entries()) {
        const answer = answers.find((x) => x?.q === i), pick = answer?.pick?.[0];
        const text = q.options?.[pick]?.label || String(answer?.other || '').trim().slice(0, 1000);
        if (!text) return false;
        entries.push([q.id, { answers: [text] }]);
      }
      result = { answers: Object.fromEntries(entries) };
    } else {
      if (!['allow', 'deny'].includes(choice)) return false;
      const available = Array.isArray(a.available) ? a.available : null;
      // Some real approvals offer cancel as the only negative decision. Never fall back to a persistent grant.
      const decision = choice === 'allow' ? 'accept' : available && !available.includes('decline') ? 'cancel' : 'decline';
      if (available && !available.includes(decision)) return false;
      result = { decision };
    }
    try { rpc.reply(a.requestId, result); } catch { return false; }
    approvals.delete(id); onResolved(id);
    const run = runFor(a.sid); if (run) onTaskState(run, 'work');
    const t = threads.get(a.sid); if (t) publish(t);
    return true;
  }
  async function readTurns(sid, limit = 1) {
    try { return (await rpc.call('thread/turns/list', { threadId: sid, limit, itemsView: 'full', sortDirection: 'desc' })).data || []; }
    catch (e) {
      if (![-32600, -32601].includes(e.code)) throw e;
      return ((await rpc.call('thread/read', { threadId: sid, includeTurns: true })).thread?.turns || []).slice(-limit).reverse();
    }
  }
  function remember(row) {
    let t = threads.get(row.id);
    if (!t) { t = { seen: new Map(), items: new Map(), rawItems: new Map(), log: [], owned: false }; threads.set(row.id, t); }
    Object.assign(t, row); t.owned = ownership.owns(row.id, t.cwd); return t;
  }
  async function refreshMetadata(force = false) {
    if (!enabled || stopped) return;
    if (metadata) return metadata;
    if (!force && metadataAt && now() - metadataAt < 120_000) return;
    metadataAt = now();
    metadata = Promise.allSettled([
      rpc.call('model/list', { limit: 100 }).then((r) => {
        models = (Array.isArray(r?.data) ? r.data : []).filter((m) => !m.hidden && typeof m.model === 'string').slice(0, 100)
          .map((m) => ({ id: m.model, name: clean(m.displayName || m.model, 120), default: !!m.isDefault,
            efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).filter((e) => typeof e === 'string'), defaultEffort: m.defaultReasoningEffort || null }));
        modelError = '';
      }).catch((e) => { modelError = clean(e.message); }),
      rpc.call('account/rateLimits/read').then((r) => { limits = codexLimits(r, now()); limitsError = ''; }).catch((e) => { limitsError = clean(e.message); }),
    ]).finally(() => { metadata = null; });
    return metadata;
  }
  async function poll() {
    if (!enabled || stopped || now() < retryAt) return;
    if (polling) return polling;
    polling = (async () => {
      const r = await rpc.call('thread/list', { limit: 30, sortKey: 'updated_at' });
      connected = true; lastError = ''; const live = new Set();
      void refreshMetadata();
      for (const row of r.data || []) {
        if ((row.source && typeof row.source === 'object') || row.ephemeral) continue; // Nested agents aren't separate desks.
        if (!runFor(row.id) && now() - millis(row.updatedAt) > idleMs) continue;
        live.add(row.id); const t = remember(row);
        const usage = await usageReader(t);
        if (usage && (!t.usage?.at || usage.at >= t.usage.at)) t.usage = usage;
        let turn;
        try { turn = (await readTurns(row.id))[0]; } catch (e) { lastError = clean(e.message); publish(t); continue; }
        if (turn) {
          const first = !t.loaded; t.loaded = true;
          if (first) for (const item of turn.items || []) { const mapped = codexItem(item); if (mapped) { const key = item.id || item.type; t.seen.set(key, `${item.status || ''}:${mapped.text || mapped.label}`); t.items.set(key, mapped); } }
          else for (const item of turn.items || []) emitItem(t.id, item);
          t.log = [...t.items.values()].slice(-160); t.turn = turn;
          for (const map of [t.items, t.seen, t.rawItems]) while (map.size > 400) map.delete(map.keys().next().value);
          // Reconcile a missed terminal notification without replaying or restarting work.
          const run = runFor(t.id);
          if (run && run.turnId === turn.id && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
            completeRun(run, turn);
          }
        }
        publish(t);
      }
      for (const [id, t] of threads) if (!live.has(id) && !runFor(id) && now() - millis(t.updatedAt) > idleMs) { threads.delete(id); onGone(id); }
    })().catch((e) => { connected = false; lastError = clean(e.message); retryAt = now() + 30_000; }).finally(() => { polling = null; });
    return polling;
  }
  async function start({ dir, text, sid = null, images = [], from = null, fresh = false, conversationKey = null, model = '', effort = '' }) {
    if (!enabled || stopped) return { ok: false, code: 'codex', message: 'Codex integration is disabled' };
    text = String(text || '').trim().slice(0, 4000);
    if (!text) return { ok: false, code: 'empty' };
    const key = conversationKey || (sid ? `thread:${sid}` : `dir:${dir}`);
    const target = (!fresh && ownership.resolve(key, dir)) || sid;
    if (creating.has(key) || (target && (runFor(target) || [...creating.values()].includes(target))) || runs.size + creating.size >= 3) return { ok: false, code: 'busy' };
    while (recent.length && now() - recent[0] > 3600_000) recent.shift();
    if (recent.length >= 12) return { ok: false, code: 'tooMany' };
    creating.set(key, target); recent.push(now());
    let run;
    try {
      const config = { cwd: dir, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' };
      if (model || effort) {
        await refreshMetadata();
        const selected = models.find((m) => m.id === model);
        if (!selected || (effort && !selected.efforts.includes(effort))) return { ok: false, code: 'codex', message: 'Model or reasoning effort is not in the Codex catalog' };
        config.model = model;
      }
      // Branch external conversations; only resume a thread created by this office instance.
      const owned = target && ownership.owns(target, dir) && !(fresh && sid);
      if (owned) {
        const saved = (await rpc.call('thread/read', { threadId: target })).thread;
        if (saved?.id !== target || !ownership.owns(target, saved.cwd)) return { ok: false, code: 'codex', message: 'Codex thread project no longer matches this conversation' };
        const latest = (await readTurns(target))[0];
        if (saved.status?.type === 'active' || latest?.status === 'inProgress') return { ok: false, code: 'busy', message: 'The previous Codex turn is still active or unconfirmed. Check it in Codex before continuing.' };
      }
      const r = await rpc.call(target ? owned ? 'thread/resume' : 'thread/fork' : 'thread/start', { ...config, ...(target ? { threadId: target } : {}) });
      const t = remember(r.thread); t.cwd ||= dir;
      ownership.remember(t.id, t.cwd, key); t.owned = true; t.model = r.model || model || t.model;
      connected = true; lastError = '';
      run = { id: `codex-task-${crypto.randomUUID()}`, sid: t.id, dir, text, at: now(), from, result: '', stopped: false, turnId: null, commands: new Set() };
      runs.set(run.id, run); publish(t);
      const input = [{ type: 'text', text }, ...images.slice(0, 4).filter((x) => /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(x) && x.length < 3_500_000).map((url) => ({ type: 'image', url }))];
      const turn = await rpc.call('turn/start', { threadId: t.id, input, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      run.turnId = turn.turn?.id || run.turnId;
      return { ok: true, task: { id: run.id, sid: run.sid, dir, text, at: run.at, agent: 'codex' } };
    } catch (e) { if (run) finish(run, e.message); return { ok: false, code: 'codex', message: clean(e.message) }; }
    finally { creating.delete(key); }
  }
  return {
    poll, start, answer, refreshMetadata,
    ownsThread: (sid) => ownership.has(sid),
    list: () => [...runs.values()].map(({ id, sid, dir, text, at }) => ({ id, sid, dir, text: clean(text, 200), at, agent: 'codex' })),
    has: (id) => runs.has(id),
    resolveRun: ownRun,
    stateOf(id) { const t = runs.get(id), a = t && [...approvals.values()].find((p) => p.sid === t.sid); return t ? { state: a ? 'wait' : 'work', approval: a?.id || null, stopping: !!t.stopping } : null; },
    async steer(target, text) {
      const t = ownRun(target), input = String(text || '').trim().slice(0, 2000);
      if (!t?.turnId || t.stopping || !input) return { ok: false, code: 'notBusy' };
      try {
        await rpc.call('turn/steer', { threadId: t.sid, expectedTurnId: t.turnId, input: [{ type: 'text', text: input }] });
        onStep(t, { label: clean(input, 100), type: 'prompt' });
        return { ok: true, how: 'now' };
      } catch (e) { return { ok: false, code: 'codex', message: clean(e.message) }; }
    },
    async stop(id) {
      const t = runs.get(id); if (!t?.turnId) return false;
      if (t.stopping) return true;
      t.stopping = true; t.stopSettling = true; onTaskState(t, 'stopping');
      try {
        // Interrupt alone can leave a Windows child running. Terminate this turn's terminals
        // before interruption can discard their handles, then catch commands started in between.
        try { await cleanRunTerminals(t); } catch (e) { t.stopError = `Could not confirm Codex commands stopped: ${clean(e.message)}`; }
        await rpc.call('turn/interrupt', { threadId: t.sid, turnId: t.turnId });
        try {
          await cleanRunTerminals(t);
          if ((await runTerminals(t)).length) throw new Error('Background terminals are still running');
        } catch (e) { t.stopError = `Could not confirm Codex commands stopped: ${clean(e.message)}`; }
      }
      catch {
        if (runs.has(id) && !t.stopTerminal) { t.stopping = false; onTaskState(t, 'work'); }
        return !!t.stopTerminal;
      }
      finally { t.stopSettling = false; if (t.stopTerminal && runs.has(id)) completeRun(t, t.stopTerminal); }
      // The acknowledgement is not completion. Wait for turn/completed, or a poll confirming it.
      if (runs.has(id)) { t.stopTimer = setTimeout(() => { if (runs.has(id)) { lastError = 'Codex has not confirmed the stop yet'; void poll(); } }, 15_000); t.stopTimer.unref?.(); }
      return true;
    },
    async log(sid, n = 120) { const turns = await readTurns(sid, 6); return turns.reverse().flatMap((t) => (t.items || []).map(codexItem).filter(Boolean).map((x) => ({ ...x, ts: millis(t.startedAt) || now() }))).slice(-n); },
    info: () => { const bin = binary(); return { enabled: enabled && !stopped, available: !!bin, connected, error: lastError, sessions: threads.size,
      runtime: bin ? { source: bin.source || 'custom', version: bin.version || null } : null, models, modelError, limits, limitsError }; },
    watch() { if (timer || stopped) return; poll(); timer = setInterval(poll, 5000); timer.unref(); },
    close() { stopped = true; clearInterval(timer); rpc.close(); },
  };
}
