// Durable receipts for browser task submissions. A crash between reservation and acknowledgement leaves an
// uncertain receipt: the caller can inspect the office, but the server never replays that operation automatically.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const requestIdOk = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
export function taskFingerprint(operation, b) {
  return crypto.createHash('sha256').update(JSON.stringify({ operation,
    agent: b.agent || '', sid: b.sid || '', dir: b.dir || '', task: b.task || '', text: b.text || '',
    images: b.images || [], fresh: !!b.fresh, model: b.model || '', effort: b.effort || '',
    ...(b.workspace === true && { workspace: true, conversationId: b.conversationId || '' }),
  })).digest('hex');
}
const unknown = (id) => [409, { ok: false, code: 'requestUncertain', requestId: id }];
const receiptResult = ([status, out]) => [status, {
  ok: !!out.ok, ...(out.code && { code: out.code }),
  ...(requestIdOk(out.conversationId) && { conversationId: out.conversationId }),
  ...(out.task && { task: { id: out.task.id, sid: out.task.sid || null, agent: out.task.agent || 'claude', at: out.task.at } }),
}]; // Never persist prompts, images, directory paths, model output or authentication data.

export function createTaskRequests(dataDir, { max = 10_000 } = {}) {
  const file = path.join(dataDir, 'task-requests.json'), entries = new Map(), active = new Map();
  let broken = false;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > max) throw new Error('Invalid receipts');
    for (const row of saved.entries) {
      if (!requestIdOk(row?.id) || !/^[a-f0-9]{64}$/.test(row.fingerprint) || !Number.isFinite(row.at)
        || !['pending', 'done', 'uncertain'].includes(row.state)
        || (row.state === 'done' && (!Array.isArray(row.result) || !Number.isInteger(row.result[0]) || typeof row.result[1]?.ok !== 'boolean'))
        || entries.has(row.id)) throw new Error('Invalid receipt');
      entries.set(row.id, { ...row, state: row.state === 'pending' ? 'uncertain' : row.state });
    }
  } catch (e) { if (e.code !== 'ENOENT') broken = true; } // Corruption must not erase protection and permit a replay.
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, entries: [...entries.values()] })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  return {
    get(id) {
      if (!requestIdOk(id)) return [400, { ok: false, code: 'requestId' }];
      if (broken) return [503, { ok: false, code: 'requestStore' }];
      const row = entries.get(id);
      if (!row) return [404, { ok: false, code: 'requestMissing', requestId: id }];
      return [200, { ok: true, requestId: id, state: row.state, at: row.at,
        ...(row.result && { status: row.result[0], result: row.result[1] }) }];
    },
    async run(id, fingerprint, execute) {
      if (!requestIdOk(id)) return [400, { ok: false, code: 'requestId' }];
      if (broken) return [503, { ok: false, code: 'requestStore' }];
      const previous = entries.get(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return [409, { ok: false, code: 'requestConflict', requestId: id }];
        if (active.has(id)) return active.get(id);
        return previous.state === 'done' ? [previous.result[0], { ...previous.result[1], requestId: id, requestState: 'done' }] : unknown(id);
      }
      // Receipts are never evicted: an old identifier must never silently become a new task.
      if (entries.size >= max) return [503, { ok: false, code: 'requestCapacity' }];
      const row = { id, fingerprint, at: Date.now(), state: 'pending' };
      entries.set(id, row);
      try { save(); } catch { broken = true; return [503, { ok: false, code: 'requestStore' }]; }
      const work = (async () => {
        try {
          const result = await execute();
          // The adapter reports transport failures as `codex`; it cannot prove whether turn/start was accepted.
          if (!result[1].ok && result[1].code === 'codex') {
            row.state = 'uncertain'; save(); return unknown(id);
          }
          row.state = 'done'; row.result = receiptResult(result);
          save();
          return [result[0], { ...result[1], requestId: id, requestState: 'done' }];
        } catch {
          row.state = 'uncertain'; delete row.result;
          try { save(); } catch { broken = true; }
          return unknown(id);
        } finally { active.delete(id); }
      })();
      active.set(id, work);
      return work;
    },
  };
}
