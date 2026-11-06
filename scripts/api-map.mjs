// Keep the local API inventory tied to its executable registry; this script never invokes an operation.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OFFICE_OPERATIONS } from '../src/shared/contracts/api.js';

const file = fileURLToPath(new URL('../docs/API-CONTRACT.md', import.meta.url));
const doc = fs.readFileSync(file, 'utf8');
const start = '<!-- api-map:start -->', end = '<!-- api-map:end -->';
if (!doc.includes(start) || !doc.includes(end)) throw new Error('API map markers are missing');
const rows = Object.entries(OFFICE_OPERATIONS).map(([name, op]) =>
  `| \`${name}\` | ${op.method} | \`${op.path}\` | ${op.access} | ${op.capability} | ${op.localOnly ? 'yes' : ''} | ${Object.keys(op.fields).join(', ') || '—'} |`);
const table = ['| Operation | Method | Path | Access | Capability | Local only | Parameters |',
  '| --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
const from = doc.indexOf(start) + start.length, to = doc.indexOf(end, from);
if (to < from) throw new Error('Invalid API map marker order');
const next = doc.slice(0, from) + '\n\n' + table + '\n\n' + doc.slice(to);
if (process.argv.includes('--check')) {
  if (next !== doc) { console.error('API map is out of date: node scripts/api-map.mjs'); process.exitCode = 1; }
} else { fs.writeFileSync(file, next); console.log(`API map: ${rows.length} operations.`); }
