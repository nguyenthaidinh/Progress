// Deterministic protocol peer for integration tests. Runs no commands and calls no model.
import readline from 'node:readline';
const rows = new Map(), turns = new Map(), waiting = new Map();
let next = 0;
const stamp = () => Math.floor(Date.now() / 1000);
const row = (id) => ({ id, cwd: process.env.OFFICE_CODEX_TEST_CWD || process.cwd(), name: 'Codex fixture', preview: 'Test project', model: 'fixture-model', path: process.env.OFFICE_CODEX_TEST_USAGE_FILE || null, source: 'vscode', status: { type: 'idle' }, createdAt: stamp(), updatedAt: stamp() });
rows.set('external-codex-fixture', row('external-codex-fixture'));
rows.set('codex-no-token-fixture', { ...row('codex-no-token-fixture'), name: 'Codex no token data' });
turns.set('external-codex-fixture', [{ id: 'old-turn', status: 'completed', startedAt: stamp(), items: [{ id: 'old-user', type: 'userMessage', content: [{ type: 'text', text: 'Previous work' }] }] }]);
const send = (x) => process.stdout.write(JSON.stringify(x) + '\n');
const notify = (method, params) => send({ method, params });
function end(sid, status, text) {
  const turn = turns.get(sid)[0]; turn.status = status;
  const message = { id: `${turn.id}-reply`, type: 'agentMessage', text };
  turn.items.push(message); notify('item/completed', { threadId: sid, item: message });
  rows.get(sid).status = { type: 'idle' };
  notify('turn/completed', { threadId: sid, turn });
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m.method) {
    const request = waiting.get(m.id); if (!request) return;
    const { sid, question } = request;
    waiting.delete(m.id); notify('serverRequest/resolved', { threadId: sid, requestId: m.id });
    if (question) { end(sid, 'completed', `Answer received: ${m.result?.answers?.mode?.answers?.join(', ') || 'none'}`); return; }
    end(sid, m.result?.decision === 'cancel' ? 'interrupted' : 'completed', m.result?.decision === 'accept' ? '**Codex completed** the fixture task.' : 'Command was denied.'); return;
  }
  const p = m.params || {}, reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': reply({ userAgent: 'fixture' }); break;
    case 'initialized': break;
    case 'thread/list': reply({ data: [...rows.values()], nextCursor: null }); break;
    case 'model/list': reply({ data: [{ model: 'fixture-model', displayName: 'Fixture model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] }); break;
    case 'account/rateLimits/read': reply({ rateLimits: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: stamp() + 3600 } } }); break;
    case 'thread/read': reply({ thread: rows.get(p.threadId) }); break;
    case 'thread/turns/list': reply({ data: turns.get(p.threadId) || [], nextCursor: null }); break;
    case 'thread/backgroundTerminals/list': reply({ data: [], nextCursor: null }); break;
    case 'thread/backgroundTerminals/terminate': reply({ terminated: true }); break;
    case 'thread/start': case 'thread/fork': case 'thread/resume': {
      const id = m.method === 'thread/resume' ? p.threadId : `office-codex-${++next}`;
      const t = rows.get(id) || row(id); rows.set(id, t); reply({ thread: t }); break;
    }
    case 'turn/start': {
      if ((p.model && p.model !== 'fixture-model') || (p.effort && !['low', 'high'].includes(p.effort))) { send({ id: m.id, error: { code: -32602, message: 'Unknown fixture model/effort' } }); break; }
      const turn = { id: `turn-${++next}`, status: 'inProgress', startedAt: stamp(), items: [{ id: `user-${next}`, type: 'userMessage', content: p.input }] };
      turns.set(p.threadId, [turn]); rows.get(p.threadId).status = { type: 'active', activeFlags: [] };
      reply({ turn }); notify('turn/started', { threadId: p.threadId, turn });
      notify('thread/tokenUsage/updated', { threadId: p.threadId, turnId: turn.id, tokenUsage: { total: { inputTokens: 80000, outputTokens: 4000 }, last: { totalTokens: 20000 }, modelContextWindow: 100000 } });
      setTimeout(() => {
        if (turn.status !== 'inProgress') return;
        const prompt = p.input.find((x) => x.type === 'text')?.text || '';
        if (prompt.includes('fixture-question')) {
          const id = `question-${turn.id}`; waiting.set(id, { sid: p.threadId, question: true });
          send({ id, method: 'item/tool/requestUserInput', params: { threadId: p.threadId, turnId: turn.id,
            questions: [{ id: 'mode', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] } }); return;
        }
        const item = { id: `cmd-${turn.id}`, type: 'commandExecution', command: prompt.includes('fixture-risky') ? 'rm -rf /fixture-only' : 'npm test', status: 'inProgress' };
        turn.items.push(item); notify('item/started', { threadId: p.threadId, item });
        const id = `approval-${turn.id}`; waiting.set(id, { sid: p.threadId });
        send({ id, method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId: turn.id, itemId: item.id, command: item.command, reason: 'Fixture approval', availableDecisions: ['accept', 'cancel'] } });
      }, 150);
      break;
    }
    case 'turn/steer': {
      const turn = turns.get(p.threadId)?.[0];
      if (turn?.id !== p.expectedTurnId || turn.status !== 'inProgress') { send({ id: m.id, error: { code: -32602, message: 'Turn changed' } }); break; }
      const item = { id: `steer-${++next}`, type: 'userMessage', content: p.input };
      turn.items.push(item); reply({ turnId: turn.id }); notify('item/completed', { threadId: p.threadId, item }); break;
    }
    case 'turn/interrupt': reply({}); for (const [id, r] of waiting) if (r.sid === p.threadId) waiting.delete(id); setTimeout(() => end(p.threadId, 'interrupted', 'Stopped.'), 1500); break;
    default: send({ id: m.id, error: { code: -32601, message: 'Unsupported fixture method' } });
  }
});
