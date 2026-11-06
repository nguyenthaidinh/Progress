import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexUsage, createCodexUsageReader, parseCodexUsageTail } from '../../server/providers/codex-usage.mjs';
import { contextBudget, quotaLeft } from '../../src/shared/token-budget.js';

const info = (ctx) => ({ total_token_usage: { input_tokens: 80000, output_tokens: 4000 }, last_token_usage: { total_tokens: ctx }, model_context_window: 100000 });
const event = (ctx, timestamp = '2026-11-02T03:00:00Z') => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: info(ctx), secret: 'NEVER_PUBLIC' } }) + '\n';

test('Context remaining uses the latest request, not accumulated tokens or account quota', () => {
  const usage = codexUsage(info(20000), 'fixture-model', 123);
  assert.deepEqual(contextBudget(usage), { usedPct: 20, leftPct: 80, used: 20000, max: 100000, left: 80000 });
  assert.equal(usage.in, 80000); assert.equal(usage.out, 4000); assert.equal(usage.cost, null);
  assert.equal(quotaLeft({ pct: 25 }), 75);
  assert.equal(contextBudget({ ctx: 0, ctxMax: 100000 }).leftPct, 100);
  assert.equal(contextBudget({ ctx: 120000, ctxMax: 100000 }).leftPct, 0);
  for (const usage of [null, {}, { ctx: null, ctxMax: 100000 }, { ctx: 5, ctxMax: 0 }, { ctx: -1, ctxMax: 100 }, { ctx: NaN, ctxMax: 100 }]) assert.equal(contextBudget(usage), null);
  assert.equal(quotaLeft({}), null); assert.equal(quotaLeft({ pct: 120 }), 0); assert.equal(quotaLeft({ pct: -10 }), 100);
});

test('Stream and stored token formats agree; unknown capacity remains unknown', () => {
  const live = codexUsage({ total: { inputTokens: 80000, outputTokens: 4000 }, last: { totalTokens: 20000 }, modelContextWindow: 100000 }, 'fixture-model', 123);
  assert.deepEqual(live, codexUsage(info(20000), 'fixture-model', 123));
  assert.equal(contextBudget(codexUsage({ total: {}, last: {}, modelContextWindow: null })), null);
  assert.equal(codexUsage(null), null);
});

test('Token history ignores other content and partial writes; compaction can increase remaining capacity', () => {
  const tail = event(80000) + '{"type":"reasoning","text":"NEVER_PUBLIC"}\n' + event(10000, '2026-11-02T03:01:00Z') + '{"type":"event_msg","payload":{"type":"token_count","info":';
  const result = parseCodexUsageTail(tail, 'fixture-model');
  assert.equal(contextBudget(result).leftPct, 90);
  assert.equal(result.at, Date.parse('2026-11-02T03:01:00Z'));
  assert.ok(!JSON.stringify(result).includes('NEVER_PUBLIC'));
  assert.equal(parseCodexUsageTail('{"type":"userMessage","payload":{"type":"token_count","info":{}}}\n'), null);
});

test('The observed-thread reader is bounded, handles append/truncate and rejects unrelated paths', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-codex-usage-'));
  const dir = path.join(home, 'sessions'); fs.mkdirSync(dir);
  const file = path.join(dir, 'rollout-fixture-id.jsonl');
  const thread = { id: 'fixture-id', path: file, model: 'fixture-model' };
  try {
    fs.writeFileSync(file, 'x'.repeat(6000) + '\n' + event(20000));
    const read = createCodexUsageReader({ home, maxBytes: 2048 });
    const first = await read(thread); assert.equal(first.ctx, 20000); assert.equal(await read(thread), first);
    fs.appendFileSync(file, event(10000)); assert.equal((await read(thread)).ctx, 10000);
    fs.writeFileSync(file, event(5000)); assert.equal((await read(thread)).ctx, 5000);
    assert.equal(await read({ ...thread, id: 'different-id' }), null);
    const outside = path.join(home, 'rollout-fixture-id.jsonl'); fs.writeFileSync(outside, event(100));
    assert.equal(await read({ ...thread, path: outside }), null);
    assert.equal(await read({ ...thread, path: '../rollout-fixture-id.jsonl' }), null);
    fs.writeFileSync(file, 'x'.repeat(6000)); assert.equal(await read(thread), null);
  } finally {
    if (path.dirname(home) === os.tmpdir()) fs.rmSync(home, { recursive: true, force: true });
  }
});
