// Bounded, cached discovery in explicitly granted provider roots. Watch hints accelerate newly created logs.
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { logFileAllowed } from '../src/shared/observation.js';
import { inside, verifyDirectory, observationPermissions } from './scope.mjs';
import { inspectLog, readScopedLog } from './log-reader.mjs';
import { createMetricsReader } from './metrics.mjs';
import { boundObservation } from './observation-budget.mjs';
export const DISCOVERY_LIMITS = Object.freeze({ entries: 512, directories: 128, files: 128, parses: 16, bytes: 8 * 1024 * 1024, sessions: 40 });
export function createProjectObserver({ selection, key, scopeId, metrics, now = Date.now }) {
  const readMetrics = metrics || createMetricsReader({ now });
  const catalogs = new Map(), cache = new Map(), hints = new Map(), cursors = selection.logs.map(root => ({ root, queue: [root.path], dir: null, complete: false }));
  let closed = false, started = false, scanning = false, roundRobin = 0, watchers = [], directoryLimit = false;
  const stats = { scans: 0, parses: 0, cacheHits: 0, bytesReadBudget: 0 };
  function startWatchers() {
    if (started) return; started = true;
    watchers = selection.logs.flatMap(root => {
      try { const watcher = watch(root.path, { recursive: true }, (_event, name) => {
        if (closed || !name || hints.size >= DISCOVERY_LIMITS.files) return;
        const file = path.resolve(root.path, String(name));
        if (inside(root.path, file) && logFileAllowed(path.basename(file))) hints.set(file, root);
      }); watcher.on('error', () => {}); return [watcher]; } catch { return []; }
    });
  }
  async function discover() {
    startWatchers(); let remaining = DISCOVERY_LIMITS.entries;
    for (let turns = 0; remaining > 0 && cursors.length && turns < cursors.length; turns++) {
      const cursor = cursors[roundRobin++ % cursors.length];
      let budget = Math.ceil(DISCOVERY_LIMITS.entries / cursors.length);
      while (budget-- > 0 && remaining-- > 0 && !closed) {
        if (!cursor.dir) {
          if (!cursor.queue.length) { cursor.complete = true; cursor.queue.push(cursor.root.path); break; }
          const directory = cursor.queue.shift();
          try { if (await fs.realpath(directory) !== directory || !inside(cursor.root.path, directory)) continue; cursor.dir = await fs.opendir(directory); }
          catch { continue; }
        }
        const entry = await cursor.dir.read();
        if (!entry) { await cursor.dir.close(); cursor.dir = null; continue; }
        const file = path.join(cursor.dir.path, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (cursor.queue.length < DISCOVERY_LIMITS.directories && path.relative(cursor.root.path, file).split(path.sep).length <= 6) cursor.queue.push(file);
          else directoryLimit = true;
        } else if (entry.isFile() && logFileAllowed(entry.name)) catalogs.set(file, { file, root: cursor.root });
        if (catalogs.size > DISCOVERY_LIMITS.files) { const oldest = catalogs.keys().next().value; catalogs.delete(oldest); cache.delete(oldest); }
      }
    }
    for (const [file, root] of hints) { catalogs.delete(file); catalogs.set(file, { file, root }); } hints.clear();
    while (catalogs.size > DISCOVERY_LIMITS.files) { const oldest = catalogs.keys().next().value; catalogs.delete(oldest); cache.delete(oldest); }
  }
  const api = {
    get diagnostics() { return { ...stats, cachedFiles: cache.size, indexedFiles: catalogs.size, directoryLimit }; },
    async snapshot({ revision, permissions, detail = null }) {
      if (closed || scanning) throw new Error('Observer unavailable'); scanning = true;
      const sampledAt = now(), grants = observationPermissions(permissions);
      let metric = null; if (grants.systemMetrics) { try { metric = readMetrics(); } catch { /* optional telemetry is unavailable */ } }
      const base = { schema: 2, scopeId, revision, permissions: grants, sampledAt, availability: 'ok', sessions: [], details: null,
        metrics: metric, quotas: [], discovery: { limited: false, partial: false } };
      try {
        for (const root of [...selection.projects, ...selection.logs]) await verifyDirectory(root);
        if (!selection.logs.length) return { ...base, availability: 'unavailable' };
        await discover(); stats.scans++; let parsed = 0, bytes = 0; const entries = [];
        base.discovery.partial = cursors.some(cursor => !cursor.complete);
        for (const item of catalogs.values()) {
          try { const entry = await inspectLog(item.file, item.root); if (entry) entries.push(entry); else { cache.delete(item.file); catalogs.delete(item.file); } }
          catch { cache.delete(item.file); catalogs.delete(item.file); }
        }
        entries.sort((a, b) => a.stat.mtimeNs > b.stat.mtimeNs ? -1 : a.stat.mtimeNs < b.stat.mtimeNs ? 1 : 0);
        const candidates = [];
        for (const entry of entries) {
          if (closed) throw new Error('Observer closed');
          let value = cache.get(entry.file);
          if (value?.signature === entry.signature) stats.cacheHits++;
          else {
            const size = Number(entry.stat.size), budget = size > 4 * 1024 * 1024 ? 4 * 1024 * 1024 : size + Math.min(size, 256 * 1024);
            if (parsed >= DISCOVERY_LIMITS.parses || bytes + budget > DISCOVERY_LIMITS.bytes) { base.discovery.partial = true; continue; }
            bytes += budget; parsed++;
            let data = null, error = false;
            try { data = await readScopedLog(entry, selection.projects, key, sampledAt); }
            catch { error = true; } // One unreadable/transient file cannot expose content or hide healthy sessions.
            if (closed) throw new Error('Observer closed');
            value = { signature: entry.signature, data, error }; cache.set(entry.file, value); stats.parses++;
          }
          if (value?.error) base.discovery.partial = true;
          if (value?.data) candidates.push(value.data);
        }
        stats.bytesReadBudget += bytes;
        candidates.sort((a, b) => (b.session.updatedAt || 0) - (a.session.updatedAt || 0));
        base.discovery.limited = directoryLimit || candidates.length > DISCOVERY_LIMITS.sessions || catalogs.size >= DISCOVERY_LIMITS.files;
        base.sessions = candidates.slice(0, DISCOVERY_LIMITS.sessions).map(({ session }) => {
          const { messages: _messages, events, ...metadata } = session;
          const stale = !session.updatedAt || sampledAt - session.updatedAt >= 120000 || session.updatedAt > sampledAt + 15000;
          return { ...metadata, status: stale ? 'unknown' : session.status, events: grants.content ? events.slice(-3) : [] };
        });
        if (grants.accountQuota) {
          // Keep quotas per session; different account/log sources must never be merged into one allowance.
          base.quotas = candidates.slice(0, DISCOVERY_LIMITS.sessions).filter(value => value.quota).map(value => ({ ...value.quota, sessionId: value.session.id }));
        }
        if (detail) {
          const data = candidates.find(value => value.session.id === detail.id && base.sessions.some(session => session.id === detail.id));
          base.details = data && grants.content ? { id: detail.id, requestId: detail.requestId, version: data.session.version,
            messages: data.session.messages, events: data.session.events, error: null }
            : { id: detail.id, requestId: detail.requestId, version: null, messages: [], events: [], error: 'unavailable' };
        }
        if (base.discovery.partial || base.discovery.limited) base.availability = 'partial';
        return boundObservation(base);
      } catch { cache.clear(); catalogs.clear(); return { ...base, availability: 'unavailable', sessions: [], details: null, quotas: [] }; }
      finally { scanning = false; }
    },
    async close() {
      closed = true; for (const watcher of watchers) watcher.close(); watchers = [];
      while (scanning) await new Promise(resolve => setTimeout(resolve, 5));
      for (const cursor of cursors) { await cursor.dir?.close().catch(() => {}); cursor.dir = null; }
      catalogs.clear(); cache.clear(); hints.clear();
    },
  };
  return Object.freeze(api);
}
