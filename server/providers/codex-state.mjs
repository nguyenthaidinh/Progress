// Only ownership and continuation IDs survive a restart. No prompts, auth tokens or approvals are persisted here.
import fs from 'node:fs';
import path from 'node:path';

const idOk = (s) => typeof s === 'string' && /^[\w-]{1,200}$/.test(s);
const dirKey = (s) => process.platform === 'win32' ? path.resolve(s).toLowerCase() : path.resolve(s);
export function createCodexState(dataDir) {
  const file = dataDir && path.join(dataDir, 'codex-threads.json'), owners = new Map(), aliases = new Map();
  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.version === 1) {
        for (const x of (Array.isArray(data.owners) ? data.owners : []).slice(-200)) if (idOk(x?.sid) && typeof x.dir === 'string' && path.isAbsolute(x.dir)) owners.set(x.sid, x.dir);
        for (const x of (Array.isArray(data.aliases) ? data.aliases : []).slice(-100)) if (typeof x?.key === 'string' && x.key.length <= 8192 && owners.has(x.sid)) aliases.set(x.key, x.sid);
      }
    } catch { /* Missing or corrupt state: external threads will be forked, never assumed owned. */ }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, owners: [...owners].map(([sid, dir]) => ({ sid, dir })), aliases: [...aliases].map(([key, sid]) => ({ key, sid })) }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return {
    has: (sid) => owners.has(sid),
    owns: (sid, dir) => !!dir && owners.has(sid) && dirKey(owners.get(sid)) === dirKey(dir),
    resolve: (key, dir) => { const sid = aliases.get(key); return sid && owners.has(sid) && dirKey(owners.get(sid)) === dirKey(dir) ? sid : null; },
    remember(sid, dir, key) {
      if (!idOk(sid) || !path.isAbsolute(dir) || (key && (typeof key !== 'string' || key.length > 8192))) throw new Error('Invalid Codex thread metadata');
      const before = [new Map(owners), new Map(aliases)];
      owners.set(sid, dir);
      if (key) aliases.set(key, sid);
      while (owners.size > 200) owners.delete(owners.keys().next().value);
      for (const [k, v] of aliases) if (!owners.has(v)) aliases.delete(k);
      while (aliases.size > 100) aliases.delete(aliases.keys().next().value);
      try { save(); } catch (e) {
        owners.clear(); aliases.clear(); for (const [k, v] of before[0]) owners.set(k, v); for (const [k, v] of before[1]) aliases.set(k, v);
        throw e;
      }
    },
  };
}
