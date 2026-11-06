import test from 'node:test';
import assert from 'node:assert/strict';
import { parseObservation, observationSnapshot, validateObservationSnapshot, readObservationFile, logFileAllowed, OBSERVATION_LIMITS } from '../../src/shared/observation.js';
import { contextBudget } from '../../src/shared/token-budget.js';
const now = Date.parse('2026-11-03T04:00:00Z'), timestamp = new Date(now).toISOString();
const jsonl = (...records) => records.map(r => JSON.stringify({ timestamp, ...r })).join('\n') + '\n';
const meta = { type: 'session_meta', payload: { id: 'session-a', cwd: 'F:\\Projects\\shop' } };
const prompt = { type: 'event_msg', payload: { type: 'user_message', message: 'Check the tests' } };
const usage = { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 80000, output_tokens: 2000 }, last_token_usage: { total_tokens: 20000 }, model_context_window: 100000 } } };

test('Codex observations separate context from account allowance and have no execution capabilities', () => {
  const s = parseObservation(jsonl(meta, prompt, usage), { sampledAt: now });
  assert.equal(s.provider, 'codex'); assert.equal(s.name, 'shop'); assert.equal(s.status, 'work');
  assert.equal(contextBudget({ ctx: s.contextUsed, ctxMax: s.contextMax }).leftPct, 80);
  const result = observationSnapshot([s], now); assert.equal(result.capabilities.taskStart, false); assert.equal(result.capabilities.accountQuota, false);
  assert.equal(result.sessions[0].inputTokens, 80000);
});
test('unknown capacity is never replaced by a guessed model context window', () => {
  const s = parseObservation(jsonl(meta, prompt), { sampledAt: now });
  assert.equal(s.contextMax, null); assert.equal(contextBudget({ ctx: s.contextUsed, ctxMax: s.contextMax }), null);
  assert.equal(observationSnapshot([s], now + 130000).sessions[0].status, 'unknown');
});
test('assistant reasoning and secrets are excluded without discarding visible answers', () => {
  const s = parseObservation(jsonl(meta, prompt,
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'PRIVATE_REASONING' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE_ANALYSIS' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Done. token=super-secret-value sk-proj-0123456789' } }), { sampledAt: now });
  const text = JSON.stringify(s); assert.doesNotMatch(text, /PRIVATE_|super-secret-value|sk-proj-0123456789/); assert.match(text, /Done/); assert.equal(s.status, 'rest');
});
test('Claude streaming message copies do not double-count tokens, thinking or sidechains', () => {
  const assistant = output => ({ type: 'assistant', sessionId: 'claude-1', cwd: '/projects/api', message: { id: 'msg-1', model: 'claude-test', content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'Result' }], stop_reason: 'end_turn', usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: output } } });
  const s = parseObservation(jsonl(assistant(5), assistant(10), { ...assistant(1000), isSidechain: true }), { sampledAt: now });
  assert.equal(s.inputTokens, 120); assert.equal(s.outputTokens, 10); assert.equal(s.contextUsed, 130); assert.equal(s.contextMax, null);
  assert.equal(s.messages.length, 1); assert.doesNotMatch(JSON.stringify(s), /PRIVATE_THINKING/);
});
test('broken lines and a partially written last line do not lose valid observations', () => {
  const s = parseObservation(jsonl(meta, prompt) + '{bad}\n{"type":', { sampledAt: now });
  assert.equal(s.messages[0].text, 'Check the tests'); assert.equal(s.invalidLines, 2);
  assert.equal(parseObservation('{"type":"unknown","password":"never"}\n'), null);
});
test('credential/configuration filenames are rejected before any file read', async () => {
  for (const name of ['auth.json', 'credentials.jsonl', 'auth-backup.jsonl', 'settings.jsonl', 'token.jsonl', 'config.jsonl']) {
    assert.equal(logFileAllowed(name), false);
    assert.equal(await readObservationFile({ name, text() { throw new Error('must not read'); } }), null);
  }
  assert.equal(logFileAllowed('rollout-2026-11-03-session.jsonl'), true);
});
test('oversized files are sliced, labelled partial and never read as one allocation', async () => {
  const head = jsonl(meta), tail = 'half-line\n' + jsonl(prompt, usage), calls = [];
  const fake = { name: 'rollout.jsonl', size: 2 ** 32, lastModified: now, text() { throw new Error('whole read forbidden'); }, slice(start, end) { calls.push([start, end]); return { text: async () => start === 0 ? head : tail }; } };
  const s = await readObservationFile(fake, { sampledAt: now }); assert.equal(s.partial, true); assert.equal(s.contextUsed, 20000);
  assert.equal(calls[0][1], OBSERVATION_LIMITS.head); assert.ok(calls[1][0] > 2 ** 31);
});
test('snapshot boundary strips authority, unexpected event types and unbounded records', () => {
  const s = parseObservation(jsonl(meta, prompt, usage), { sampledAt: now });
  const result = validateObservationSnapshot({ version: 1, source: 'browser-log', sampledAt: now, capabilities: { taskStart: true }, sessions: [{ ...s, admin: true, events: [{ type: 'exec', label: 'must not execute' }], messages: [{ role: 'analysis', text: 'hidden' }] }] });
  assert.equal(result.capabilities.taskStart, false); assert.equal(result.sessions[0].admin, undefined); assert.deepEqual(result.sessions[0].events, []); assert.deepEqual(result.sessions[0].messages, []);
  assert.equal(validateObservationSnapshot({ k: 'perm', sessions: [] }), null);
});
test('a record limit keeps the newest usage snapshot and labels skipped history', () => {
  const repeated = Array.from({ length: OBSERVATION_LIMITS.entries + 2 }, () => JSON.stringify({ type: 'unknown' })).join('\n');
  const s = parseObservation(jsonl(meta, prompt) + repeated + '\n' + jsonl(usage), { sampledAt: now });
  assert.equal(s.partial, true); assert.equal(s.contextUsed, 20000);
});
test('missing output counters are unavailable rather than a reported zero', () => {
  const s = parseObservation(jsonl({ type: 'assistant', sessionId: 'missing-output', message: { id: 'msg-1', content: [{ type: 'text', text: 'Read the file' }], usage: { input_tokens: 100 } } }), { sampledAt: now });
  assert.equal(s.inputTokens, 100); assert.equal(s.outputTokens, null); assert.equal(s.contextMax, null);
});
