// Reads selected File objects locally. No fetch, credentials, filesystem writes or raw log messages leave this worker.
import { observationSnapshot, readObservationFile, OBSERVATION_LIMITS } from '../shared/observation.js';
const cache = new Map(); let signature = '', generation = 0;
self.onmessage = async ({ data }) => {
  if (data?.kind === 'clear') { generation++; cache.clear(); signature = ''; return; }
  if (data?.kind !== 'read' || !Number.isSafeInteger(data.id) || !Array.isArray(data.files)) return;
  const current = ++generation;
  if (data.reset) { cache.clear(); signature = ''; }
  const sessions = []; let failed = 0;
  const live = new Set();
  for (const [index, entry] of data.files.slice(0, OBSERVATION_LIMITS.files).entries()) {
    live.add(entry.key);
    try {
      const old = cache.get(entry.key), fingerprint = `${entry.file.size}:${entry.file.lastModified}`;
      const s = old?.fingerprint === fingerprint ? old.session : await readObservationFile(entry.file, { key: entry.key, sampledAt: data.sampledAt });
      if (current !== generation) return;
      cache.set(entry.key, { fingerprint, session: s }); if (s) sessions.push(s);
    }
    catch { failed++; }
    if (index % 8 === 7) self.postMessage({ kind: 'progress', id: data.id, count: index + 1 });
  }
  for (const key of cache.keys()) if (!live.has(key)) cache.delete(key);
  const snapshot = observationSnapshot(sessions, data.sampledAt);
  const next = JSON.stringify([data.files.map(e => [e.key, e.file.size, e.file.lastModified]), snapshot.sessions.map(s => [s.id, s.status]), failed]);
  if (next === signature) self.postMessage({ kind: 'unchanged', id: data.id });
  else { signature = next; self.postMessage({ kind: 'snapshot', id: data.id, snapshot, failed }); }
};
