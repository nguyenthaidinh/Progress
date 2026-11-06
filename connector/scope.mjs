// Immutable filesystem grants. Nothing supplied by a browser is interpreted as a path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireRemote } from '../src/shared/remote/crypto.js';
export const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
export async function directoryGrant(input) {
  requireRemote(typeof input === 'string' && path.isAbsolute(input), 'scope');
  const resolved = path.resolve(input), real = await fs.realpath(resolved), stat = await fs.stat(real, { bigint: true });
  requireRemote(path.relative(real, resolved) === '' && stat.isDirectory() && stat.ino !== 0n && path.parse(real).root !== real, 'scope');
  return { path: real, dev: String(stat.dev), ino: String(stat.ino) };
}
export async function verifyDirectory(grant) {
  const real = await fs.realpath(grant.path), stat = await fs.stat(real, { bigint: true });
  requireRemote(path.relative(real, grant.path) === '' && stat.isDirectory() && String(stat.dev) === grant.dev && String(stat.ino) === grant.ino, 'scope');
}
export function observationPermissions(value) {
  requireRemote(value && Object.keys(value).sort().join(',') === 'accountQuota,content,systemMetrics'
    && Object.values(value).every(item => typeof item === 'boolean'), 'permissions');
  return { content: value.content, accountQuota: value.accountQuota, systemMetrics: value.systemMetrics };
}
export async function selectProjects({ projects, logs, permissions = { content: true, accountQuota: true, systemMetrics: false } }) {
  requireRemote(Array.isArray(projects) && projects.length > 0 && projects.length <= 16 && Array.isArray(logs) && logs.length <= 2, 'scope');
  const roots = await Promise.all(projects.map(directoryGrant));
  requireRemote(!roots.some((root, i) => roots.some((other, j) => i !== j && (inside(root.path, other.path) || inside(other.path, root.path)))), 'scope');
  const logRoots = [];
  for (const log of logs) {
    requireRemote(['codex', 'claude'].includes(log.provider) && !logRoots.some(root => root.provider === log.provider), 'scope');
    logRoots.push({ provider: log.provider, ...await directoryGrant(log.path) });
  }
  return { kind: 'projects', projects: roots, logs: logRoots, permissions: observationPermissions(permissions) };
}
export function scopeIdentity(scope) { return JSON.stringify({ kind: scope.kind, projects: scope.projects, logs: scope.logs }); }
