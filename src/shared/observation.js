// Provider-neutral, bounded observation records. This module has no network, filesystem or browser side effects.
import { redact } from './redact.js';

export const OBSERVATION_VERSION = 1;
export const OBSERVATION_LIMITS = Object.freeze({ files: 128, entries: 10000, bytes: 4 * 1024 * 1024, head: 64 * 1024, line: 256 * 1024, messages: 40, events: 40, sessions: 40 });
export const OBSERVATION_CAPABILITIES = Object.freeze({ observe: true, content: true, accountQuota: false, systemMetrics: false, taskStart: false, taskStop: false, approve: false });
const clean = (s, max = 2000) => redact(typeof s === 'string' ? s.slice(0, max) : '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const stamp = (s) => { const n = Date.parse(s); return Number.isFinite(n) ? n : null; };
const leaf = (s) => clean(s, 1000).split(/[\\/]/).filter(Boolean).at(-1) || '';
const textOf = (items, type) => typeof items === 'string' ? items : Array.isArray(items)
  ? items.filter((x) => x?.type === type && typeof x.text === 'string').map((x) => x.text).join('\n') : '';
export function observationId(provider, value) {
  let hash = 2166136261; for (const c of String(value)) { hash ^= c.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `log-${provider}-${(hash >>> 0).toString(16)}`;
}
export function logFileAllowed(name) { return typeof name === 'string' && name.length < 240 && /\.jsonl$/i.test(name) && !/(?:auth(?:entication)?|credentials?|secrets?|settings|config(?:uration)?|tokens?|login)(?:[._-]|$)/i.test(name); }

/** Parse complete, bounded JSONL records. Missing context limits remain unknown; reasoning and raw payloads are omitted. */
export function parseObservation(text, { name = 'session.jsonl', key = name, modifiedAt = null, sampledAt = Date.now(), partial = false } = {}) {
  const out = { provider: '', id: '', name: '', project: '', model: '', updatedAt: null, startedAt: null, status: 'unknown', statusQuality: 'estimated',
    inputTokens: null, outputTokens: null, contextUsed: null, contextMax: null, messages: [], events: [], counts: { read: 0, edit: 0, cmd: 0, web: 0 }, partial, invalidLines: 0 };
  const seen = new Map(); let identity = key, active = false, records = 0;
  const push = (list, value, max) => { list.push(value); if (list.length > max) list.shift(); };
  function message(role, text, at) {
    text = clean(text); if (!text || out.messages.at(-1)?.text === text && out.messages.at(-1)?.role === role) return;
    push(out.messages, { role, text, at }, OBSERVATION_LIMITS.messages);
  }
  function tool(name, input, at) {
    const n = String(name || '').toLowerCase(), type = /read|grep|glob|search|list/.test(n) ? 'read' : /edit|write|patch/.test(n) ? 'edit' : /web|fetch|browse/.test(n) ? 'web' : 'cmd';
    const target = input && typeof input === 'object' ? input.file_path || input.path || input.command || input.cmd || input.query : '';
    const label = clean(`${String(name || 'tool').slice(0, 60)}${typeof target === 'string' ? ` · ${target}` : ''}`, 220);
    push(out.events, { type, label, at }, OBSERVATION_LIMITS.events); out.counts[type]++; active = true;
  }
  const allLines = String(text || '').split('\n');
  const lines = allLines.length > OBSERVATION_LIMITS.entries ? [...allLines.slice(0, 32), ...allLines.slice(-(OBSERVATION_LIMITS.entries - 32))] : allLines;
  if (lines.length !== allLines.length) out.partial = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (++records > OBSERVATION_LIMITS.entries) { out.partial = true; break; }
    if (line.length > OBSERVATION_LIMITS.line) { out.partial = true; continue; }
    let r; try { r = JSON.parse(line); } catch { out.invalidLines++; continue; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const at = stamp(r.timestamp);
    if (r.type === 'session_meta' && r.payload && typeof r.payload === 'object') {
      out.provider = 'codex'; identity = typeof r.payload.id === 'string' ? r.payload.id.slice(0, 200) : key;
      out.project = leaf(r.payload.cwd); out.startedAt = at; continue;
    }
    if (r.type === 'turn_context' && r.payload) {
      out.provider ||= 'codex'; out.model = clean(r.payload.model, 100) || out.model; out.project ||= leaf(r.payload.cwd); continue;
    }
    if (r.type === 'event_msg' && r.payload && typeof r.payload === 'object') {
      out.provider ||= 'codex'; const p = r.payload;
      if (!['user_message', 'agent_message', 'token_count', 'task_started', 'task_complete', 'turn_aborted'].includes(p.type)) continue;
      if (at) out.updatedAt = Math.max(out.updatedAt || 0, at);
      if (p.type === 'user_message') { message('user', p.message, at); active = true; }
      if (p.type === 'agent_message') { message('assistant', p.message, at); active = false; }
      if (p.type === 'task_started') active = true;
      if (p.type === 'task_complete' || p.type === 'turn_aborted') active = false;
      if (p.type === 'token_count' && p.info && typeof p.info === 'object') {
        const total = p.info.total_token_usage, last = p.info.last_token_usage;
        out.inputTokens = count(total?.input_tokens); out.outputTokens = count(total?.output_tokens);
        out.contextUsed = count(last?.total_tokens); out.contextMax = count(p.info.model_context_window);
      }
      continue;
    }
    if (r.type === 'response_item' && r.payload && typeof r.payload === 'object') {
      out.provider ||= 'codex'; const p = r.payload;
      if (p.channel === 'analysis' || p.type === 'reasoning') continue;
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) { message(p.role, textOf(p.content, p.role === 'user' ? 'input_text' : 'output_text'), at); if (p.role === 'assistant' && p.phase !== 'commentary') active = false; }
      if (p.type === 'function_call') { let input; try { input = JSON.parse(p.arguments || '{}'); } catch { /* Only the tool name is retained. */ } tool(p.name, input, at); }
      if (at && ['message', 'function_call', 'function_call_output'].includes(p.type)) out.updatedAt = Math.max(out.updatedAt || 0, at);
      continue;
    }
    if (r.isSidechain || !['user', 'assistant', 'system'].includes(r.type) || !r.message && !r.sessionId) continue;
    out.provider ||= 'claude'; if (typeof r.sessionId === 'string') identity = r.sessionId.slice(0, 200);
    out.project ||= leaf(r.cwd); out.startedAt ||= at;
    if (r.type === 'user') { message('user', textOf(r.message?.content, 'text'), at); active = true; }
    if (r.type === 'assistant' && r.message) {
      const m = r.message, u = m.usage; out.model = clean(m.model, 100) || out.model;
      message('assistant', textOf(m.content, 'text'), at);
      for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === 'tool_use') tool(c.name, c.input, at);
      if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence') active = false;
      if (u && typeof m.id === 'string' && ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some(k => count(u[k]) !== null)) {
        const output = count(u.output_tokens), previous = seen.get(m.id), inputs = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(k => count(u[k])), input = inputs.reduce((sum, n) => sum + (n || 0), 0);
        if (previous === undefined && inputs.some(n => n !== null)) out.inputTokens = (out.inputTokens || 0) + input;
        if (output !== null) out.outputTokens = (out.outputTokens || 0) + Math.max(0, output - (previous || 0));
        seen.set(m.id, Math.max(output || 0, previous || 0)); if (inputs.some(n => n !== null)) out.contextUsed = input + Math.max(output || 0, previous || 0);
      }
    }
    if (r.type === 'system' && r.subtype === 'turn_duration') active = false;
    if (at) out.updatedAt = Math.max(out.updatedAt || 0, at);
  }
  if (!out.provider || !out.messages.length && !out.events.length && out.inputTokens === null && out.contextUsed === null) return null;
  out.updatedAt ||= Number.isFinite(modifiedAt) ? modifiedAt : null;
  const fresh = out.updatedAt && sampledAt - out.updatedAt < 120000 && sampledAt >= out.updatedAt - 30000;
  out.status = fresh ? active ? 'work' : 'rest' : 'unknown';
  out.id = observationId(out.provider, identity); out.name = out.project || name.replace(/\.jsonl$/i, '').slice(0, 50);
  out.name = clean(out.name, 80); out.contextMax = out.contextMax > 0 ? out.contextMax : null;
  return out;
}

export function observationSnapshot(sessions, sampledAt = Date.now()) {
  const unique = new Map(); for (const s of sessions.filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) if (!unique.has(s.id)) unique.set(s.id, s);
  return { version: OBSERVATION_VERSION, source: 'browser-log', sampledAt, capabilities: OBSERVATION_CAPABILITIES,
    sessions: [...unique.values()].slice(0, OBSERVATION_LIMITS.sessions).map(s => ({ ...s, status: !s.updatedAt || sampledAt - s.updatedAt >= 120000 ? 'unknown' : s.status })) };
}

// Revalidate the iframe boundary instead of accepting arbitrary scene/event messages from a parent window.
export function validateObservationSnapshot(value) {
  if (!value || value.version !== OBSERVATION_VERSION || value.source !== 'browser-log' || !Array.isArray(value.sessions)) return null;
  const sessions = [];
  for (const s of value.sessions.slice(0, OBSERVATION_LIMITS.sessions)) {
    if (!s || !['codex', 'claude'].includes(s.provider) || !/^log-(codex|claude)-[a-f0-9]{1,8}$/.test(s.id || '')) continue;
    sessions.push({ id: s.id, provider: s.provider, name: clean(s.name, 80), project: clean(s.project, 100), model: clean(s.model, 100),
      updatedAt: count(s.updatedAt), status: ['work', 'rest'].includes(s.status) ? s.status : 'unknown', contextUsed: count(s.contextUsed), contextMax: count(s.contextMax),
      inputTokens: count(s.inputTokens), outputTokens: count(s.outputTokens),
      counts: Object.fromEntries(['read', 'edit', 'cmd', 'web'].map(k => [k, count(s.counts?.[k]) || 0])),
      messages: (Array.isArray(s.messages) ? s.messages : []).slice(-OBSERVATION_LIMITS.messages).filter(m => m && ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, text: clean(m.text), at: count(m.at) })),
      events: (Array.isArray(s.events) ? s.events : []).slice(-OBSERVATION_LIMITS.events).filter(e => e && ['read', 'edit', 'cmd', 'web'].includes(e.type)).map(e => ({ type: e.type, label: clean(e.label, 220), at: count(e.at) })),
    });
  }
  return { version: OBSERVATION_VERSION, source: 'browser-log', sampledAt: count(value.sampledAt) || Date.now(), capabilities: OBSERVATION_CAPABILITIES, sessions };
}

/** Read only a bounded head/tail; a selected multi-GB log never becomes a multi-GB allocation. */
export async function readObservationFile(file, options = {}) {
  if (!logFileAllowed(file.name)) return null;
  const max = OBSERVATION_LIMITS.bytes;
  if (file.size <= max) return parseObservation(await file.text(), { ...options, name: file.name, modifiedAt: file.lastModified });
  let head = await file.slice(0, OBSERVATION_LIMITS.head).text(), tail = await file.slice(file.size - max + OBSERVATION_LIMITS.head).text();
  head = head.slice(0, head.lastIndexOf('\n') + 1); const start = tail.indexOf('\n'); tail = start >= 0 ? tail.slice(start + 1) : '';
  return parseObservation(head + tail, { ...options, name: file.name, modifiedAt: file.lastModified, partial: true });
}
