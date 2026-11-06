import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexThreadUrl, createCodexDesktop } from '../../server/codex-desktop.mjs';

const SID = '01a19f19-8694-7560-b2ad-1f69184ed08c';
test('desktop links accept a single thread ID, never arbitrary URLs, prompts or shell fragments', async () => {
  assert.equal(codexThreadUrl(SID), `codex://threads/${SID}`);
  const desktop = createCodexDesktop({ platform: 'win32', env: {}, execute: () => assert.fail('invalid ID launched') });
  for (const id of [null, {}, '', 'new', 'NEW', '../new', 'x?prompt=run', 'x#new', "x'; exit 0; #", 'a/b', 'https://example.com', 'a'.repeat(201)]) {
    assert.equal(codexThreadUrl(id), null); assert.equal((await desktop.open(id)).code, 'invalid');
  }
});

test('Windows uses a hidden native launcher, checks protocol registration and only opens the existing thread', async () => {
  let call;
  const desktop = createCodexDesktop({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, execute: (file, args, options, done) => {
    call = { file, args, options }; done(null);
  } });
  assert.equal((await desktop.open(SID)).ok, true);
  assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(call.options.windowsHide, true); assert.equal(call.options.shell, undefined); assert.equal(call.options.timeout, 8000);
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /OpenSubKey\('codex'\)/); assert.match(script, /GetValue\('URL Protocol'/);
  assert.match(script, new RegExp(`Start-Process -FilePath 'codex://threads/${SID}'`));
  assert.doesNotMatch(script, /prompt=|turn\/start|codex:\/\/new/);
});

test('same-thread clicks share one launch and a short debounce; another simultaneous thread reports busy', async () => {
  let done, calls = 0, at = 1000;
  const desktop = createCodexDesktop({ platform: 'darwin', env: {}, now: () => at, execute: (_file, _args, _opts, cb) => { calls++; done = cb; } });
  const first = desktop.open(SID), duplicate = desktop.open(SID);
  assert.equal(first, duplicate); assert.equal(calls, 1);
  assert.equal((await desktop.open('other-thread')).code, 'busy');
  done(null); await first;
  assert.equal((await desktop.open(SID)).ok, true); assert.equal(calls, 1);
  at += 2001; const again = desktop.open(SID); assert.equal(calls, 2); done(null); await again;
});

test('disabled or unsupported environments do not start native processes', async () => {
  const execute = () => assert.fail('desktop launcher must not run');
  assert.equal((await createCodexDesktop({ platform: 'win32', env: { OFFICE_CODEX_DESKTOP: '0' }, execute }).open(SID)).code, 'disabled');
  assert.equal((await createCodexDesktop({ platform: 'unknown', env: {}, execute }).open(SID)).code, 'unsupported');
});

test('macOS and Linux pass only the fixed deep link as an argument; failures allow a later retry', async () => {
  for (const [platform, command] of [['darwin', '/usr/bin/open'], ['linux', 'xdg-open']]) {
    let calls = 0;
    const desktop = createCodexDesktop({ platform, env: {}, execute: (file, args, options, done) => {
      assert.equal(file, command); assert.deepEqual(args, [`codex://threads/${SID}`]); assert.equal(options.shell, undefined);
      done(++calls === 1 ? { code: 3 } : null);
    } });
    assert.equal((await desktop.open(SID)).code, 'unavailable'); assert.equal((await desktop.open(SID)).ok, true); assert.equal(calls, 2);
  }
});

test('synchronous launcher errors return a bounded failure and leave the next attempt usable', async () => {
  const desktop = createCodexDesktop({ platform: 'win32', env: {}, execute: () => { throw new Error('launch failed'); } });
  assert.equal((await desktop.open(SID)).code, 'failed'); assert.equal((await desktop.open(SID)).code, 'failed');
});
