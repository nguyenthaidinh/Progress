// C reads one user-selected JSONL. No directory discovery, provider login, Next.js or task execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseObservation, observationSnapshot, OBSERVATION_LIMITS, logFileAllowed } from '../src/shared/observation.js';
import { publicObservation } from '../src/shared/remote/contract.js';
export async function selectLog(file) {
  if (!path.isAbsolute(file) || !logFileAllowed(path.basename(file))) throw new Error('Select an absolute session JSONL path');
  const real = await fs.realpath(file), stat = await fs.stat(real, { bigint: true });
  if (!stat.isFile() || real !== path.resolve(file)) throw new Error('Symlinks/junction aliases are not accepted for the selected log');
  if (stat.ino === 0n) throw new Error('Filesystem must provide a stable file identity');
  return { file: real, dev: String(stat.dev), ino: String(stat.ino) };
}
export async function readSelectedLog(selection, projectId, sampledAt = Date.now()) {
  if (await fs.realpath(selection.file) !== selection.file) throw new Error('Selected path changed');
  const handle = await fs.open(selection.file, 'r');
  try {
    const stat = await handle.stat({ bigint: true }), size = Number(stat.size);
    if (!stat.isFile() || String(stat.dev) !== selection.dev || String(stat.ino) !== selection.ino) throw new Error('Selected file was replaced; select it again');
    if (!Number.isSafeInteger(size)) throw new Error('Selected log is too large to address safely');
    const max = OBSERVATION_LIMITS.bytes, partial = size > max;
    let text;
    if (!partial) { const bytes = Buffer.alloc(Math.min(size, max)); const result = await handle.read(bytes, 0, bytes.length, 0); text = bytes.subarray(0, result.bytesRead).toString('utf8'); }
    else {
      const head = Buffer.alloc(OBSERVATION_LIMITS.head), tail = Buffer.alloc(max - head.length);
      const a = await handle.read(head, 0, head.length, 0), b = await handle.read(tail, 0, tail.length, size - tail.length);
      const first = head.subarray(0, a.bytesRead).toString('utf8'), last = tail.subarray(0, b.bytesRead).toString('utf8');
      text = first.slice(0, first.lastIndexOf('\n') + 1) + last.slice(last.indexOf('\n') + 1);
    }
    const session = parseObservation(text, { name: path.basename(selection.file), key: projectId, modifiedAt: Number(stat.mtimeMs), sampledAt, partial });
    // Reserve headroom for nested JOSE/base64 expansion even when every character is four-byte UTF-8.
    if (session) {
      session.messages = session.messages.slice(-20).map(message => ({ ...message, text: message.text.slice(0, 1000) }));
      session.events = session.events.slice(-20).map(event => ({ ...event, label: event.label.slice(0, 200) }));
    }
    const snap = observationSnapshot(session ? [session] : [], sampledAt);
    return publicObservation({ projectId, sampledAt, sessions: snap.sessions });
  } finally { await handle.close(); }
}
