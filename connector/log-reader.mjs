// Bounded head/tail reads with metadata-before-content project checks and stable file handles.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { OBSERVATION_LIMITS, logFileAllowed, parseObservation } from '../src/shared/observation.js';
import { inside, verifyDirectory } from './scope.mjs';
const max = OBSERVATION_LIMITS.bytes;
export const opaqueId = (key, value) => createHmac('sha256', key).update(value).digest('base64url');
function rows(text) {
  const result = [];
  for (const line of text.split('\n').slice(0, OBSERVATION_LIMITS.entries)) {
    if (!line.trim()) continue;
    // Skipping an unreadable row could hide a project switch before the next message.
    if (line.length > OBSERVATION_LIMITS.line) throw new Error('Unverifiable log row');
    const row = JSON.parse(line);
    if (!row || Array.isArray(row) || typeof row !== 'object') throw new Error('Unverifiable log row');
    result.push({ row, line });
  }
  return result;
}
function cwdOf(row, provider) {
  if (provider === 'codex' && ['session_meta', 'turn_context'].includes(row.type)) return row.payload?.cwd;
  if (provider === 'claude' && ['user', 'assistant', 'system'].includes(row.type)) return row.cwd;
  return undefined;
}
async function projectOf(cwd, projects) {
  if (typeof cwd !== 'string' || cwd.length > 8000 || !path.isAbsolute(cwd)) return null;
  let real; try { real = await fs.realpath(cwd); } catch { return null; }
  return projects.find(project => inside(project.path, real)) || null;
}
function quotaOf(records, sampledAt) {
  for (let i = records.length - 1; i >= 0; i--) {
    const { row } = records[i], raw = row.type === 'event_msg' && row.payload?.type === 'token_count' ? row.payload.rate_limits : null;
    if (!raw || typeof raw !== 'object') continue;
    const at = Date.parse(row.timestamp); if (!Number.isFinite(at) || at > sampledAt + 15000) continue;
    const windows = [];
    for (const key of ['primary', 'secondary']) {
      const value = raw[key]; if (!value || !Number.isFinite(value.used_percent) || value.used_percent < 0 || value.used_percent > 100) continue;
      windows.push({ key, usedPct: value.used_percent,
        minutes: Number.isSafeInteger(value.window_minutes) && value.window_minutes > 0 ? value.window_minutes : null,
        resetsAt: Number.isSafeInteger(value.resets_at) && value.resets_at > 0 && value.resets_at <= Number.MAX_SAFE_INTEGER / 1000 ? value.resets_at * 1000 : null });
    }
    if (windows.length) return { provider: 'codex', source: 'session-log', at, windows };
  }
  return null;
}
export async function inspectLog(file, root) {
  if (!logFileAllowed(path.basename(file)) || !inside(root.path, file)) return null;
  const real = await fs.realpath(file); if (path.relative(real, file) !== '' || !inside(root.path, real)) return null;
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.ino === 0n || !Number.isSafeInteger(Number(stat.size))) return null;
  return { file, root, stat, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` };
}
export async function readScopedLog(entry, projects, key, sampledAt) {
  await verifyDirectory(entry.root);
  const resolvedProjects = new Map();
  const resolveProject = async cwd => { if (!resolvedProjects.has(cwd)) resolvedProjects.set(cwd, await projectOf(cwd, projects)); return resolvedProjects.get(cwd); };
  const handle = await fs.open(entry.file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (`${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}` !== entry.signature) return null;
    const size = Number(before.size), headSize = Math.min(size, OBSERVATION_LIMITS.line), head = Buffer.alloc(headSize);
    const h = await handle.read(head, 0, headSize, 0); let headText = head.subarray(0, h.bytesRead).toString('utf8');
    if (size > headSize) headText = headText.slice(0, headText.lastIndexOf('\n') + 1);
    const header = rows(headText), provider = entry.root.provider;
    const anchor = header.find(({ row }) => provider === 'codex' ? row.type === 'session_meta' && row.payload?.id : row.sessionId && cwdOf(row, provider));
    const project = anchor && await resolveProject(cwdOf(anchor.row, provider));
    if (!project) return null; // Do not read the remaining conversation of an unapproved project.
    let text, partial = size > max, tailAnchored = true;
    if (!partial) {
      const buffer = Buffer.alloc(size); const result = await handle.read(buffer, 0, size, 0); text = buffer.subarray(0, result.bytesRead).toString('utf8');
    } else {
      const tail = Buffer.alloc(max - headSize), result = await handle.read(tail, 0, tail.length, size - tail.length);
      let tailText = tail.subarray(0, result.bytesRead).toString('utf8'); tailText = tailText.slice(tailText.indexOf('\n') + 1);
      const tailRows = rows(tailText), firstAnchor = tailRows.findIndex(({ row }) => cwdOf(row, provider) !== undefined);
      tailAnchored = firstAnchor >= 0;
      // An omitted middle may have changed project. Unanchored tail content is never shared.
      text = headText + (firstAnchor < 0 ? '' : tailRows.slice(firstAnchor).map(item => item.line).join('\n'));
    }
    const records = rows(text);
    for (const { row } of records) {
      const cwd = cwdOf(row, provider); if (cwd === undefined) continue;
      if ((await resolveProject(cwd)) !== project) return null;
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size
      || after.size === before.size && after.mtimeNs !== before.mtimeNs || await fs.realpath(entry.file) !== entry.file) return null;
    const parsed = parseObservation(text, { name: path.basename(entry.file), key: entry.file, sampledAt, partial });
    if (!parsed || parsed.provider !== provider) return null;
    const id = 'rs-' + opaqueId(key, `${provider}:${entry.file}:${before.dev}:${before.ino}`), projectId = 'pr-' + opaqueId(key, project.path);
    const messages = parsed.messages.slice(-20).map(item => ({ ...item, text: item.text.slice(0, 1000) }));
    const events = parsed.events.slice(-20).map(item => ({ ...item, label: item.label.slice(0, 200) }));
    return { session: { id, projectId, version: opaqueId(key, entry.signature), provider, name: parsed.name, project: path.basename(project.path).slice(0, 100),
      model: parsed.model, updatedAt: parsed.updatedAt, status: tailAnchored ? parsed.status : 'unknown', contextUsed: parsed.contextUsed, contextMax: parsed.contextMax,
      inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, counts: parsed.counts,
      partial: partial || parsed.partial || parsed.messages.length > 20 || parsed.events.length > 20,
      events, messages }, quota: provider === 'codex' ? quotaOf(records, sampledAt) : null };
  } finally { await handle.close(); }
}
