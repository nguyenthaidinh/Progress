// Numeric token snapshots only. Never resume an observed thread to obtain its usage.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../redact.mjs';

const count = (n) => Number.isFinite(n) && n >= 0 ? n : null;
export function codexUsage(usage, model = 'Codex', at = Date.now()) {
  if (!usage || typeof usage !== 'object') return null;
  const total = usage.total || usage.total_token_usage, last = usage.last || usage.last_token_usage;
  if (!total && !last) return null;
  return { model: redact(String(model || 'Codex')).slice(0, 120), cost: null,
    in: count(total?.inputTokens ?? total?.input_tokens), out: count(total?.outputTokens ?? total?.output_tokens),
    ctx: count(last?.totalTokens ?? last?.total_tokens), ctxMax: count(usage.modelContextWindow ?? usage.model_context_window), at };
}
export function parseCodexUsageTail(text, model, modifiedAt = null) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Ignore conversation content and reasoning; parse only token-count events.
    if (!lines[i].includes('"token_count"')) continue;
    let entry; try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.type !== 'event_msg' || entry.payload?.type !== 'token_count') continue;
    const usage = codexUsage(entry.payload.info, model, Date.parse(entry.timestamp) || modifiedAt);
    if (usage) return usage;
  }
  return null;
}
export function createCodexUsageReader({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), maxBytes = 1_048_576 } = {}) {
  const cache = new Map(), root = path.resolve(home);
  const inside = (base, file) => { const relative = path.relative(base, file); return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
  return async function read(thread) {
    const file = thread.path;
    if (!file || !path.isAbsolute(file) || !/^[\w-]{1,200}$/.test(thread.id || '') || !path.basename(file).endsWith(`-${thread.id}.jsonl`)) return null;
    const allowed = (base, target) => ['sessions', 'archived_sessions'].some((dir) => inside(path.join(base, dir), target));
    if (!allowed(root, path.resolve(file))) return null;
    let handle;
    try {
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      if (!allowed(realRoot, realFile)) return null;
      handle = await fs.open(realFile, 'r'); const stat = await handle.stat();
      if (!stat.isFile()) return null;
      const previous = cache.get(realFile);
      if (previous?.size === stat.size && previous.modified === stat.mtimeMs && previous.model === thread.model) return previous.usage;
      const start = Math.max(0, stat.size - maxBytes), bytes = Buffer.alloc(Math.min(stat.size, maxBytes));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      let text = bytes.toString('utf8', 0, bytesRead);
      if (start) { const newline = text.indexOf('\n'); text = newline < 0 ? '' : text.slice(newline + 1); }
      const usage = parseCodexUsageTail(text, thread.model, stat.mtimeMs);
      cache.set(realFile, { size: stat.size, modified: stat.mtimeMs, model: thread.model, usage });
      while (cache.size > 200) cache.delete(cache.keys().next().value);
      return usage;
    } catch { return null; } // Missing/rotated/unknown history is unavailable data, never a fabricated 100%.
    finally { await handle?.close().catch(() => {}); }
  };
}
