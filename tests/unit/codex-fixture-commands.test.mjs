import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCommands } from '../../scripts/lib/codex-fixture-commands.mjs';
test('Live acceptance only permits exact marker commands and known shell wrappers', () => {
  const allowed = fixtureCommands('allow');
  assert.ok(allowed.includes('node approval.cjs allow'));
  for (const command of ['node approval.cjs allow; another-command', 'node approval.cjs deny', '"C:\\untrusted\\pwsh.exe" -Command \'node approval.cjs allow\'', 'node approval.cjs allow --extra']) assert.equal(allowed.includes(command), false);
  assert.throws(() => fixtureCommands('allow; another-command'));
});
