// Portable Claude print-mode fixture. Launched via node by the test-only preload, never by production code.
import fs from 'node:fs';
import crypto from 'node:crypto';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.316 (Claude Code)'); process.exit(0); }
if (args.includes('--help')) { console.log('Usage: claude -p --output-format stream-json'); process.exit(0); }
const at = args.indexOf('--resume'), resume = at >= 0 ? args[at + 1] : null, sid = resume || crypto.randomUUID(), prompt = args[args.indexOf('-p') + 1] || '';
if (process.env.OFFICE_TEST_CLAUDE_LOG) fs.appendFileSync(process.env.OFFICE_TEST_CLAUDE_LOG, JSON.stringify({ sid, resume, prompt }) + '\n');
const emit = (x) => console.log(JSON.stringify(x));
emit({ type: 'system', subtype: 'init', session_id: sid });
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'package.json' } }] } });
setTimeout(() => emit({ type: 'result', result: `Claude workspace completed: ${prompt.slice(0, 100)}`, session_id: sid }), 80);
