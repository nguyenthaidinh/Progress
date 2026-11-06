import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tunnelIdentity, sameTunnelIdentity, quickTunnelUrl } from '../../server/tunnel-process.mjs';

test('Native process identity includes a creation marker and rejects a reused or incomplete identity', async () => {
  const a = await tunnelIdentity(process.pid), b = await tunnelIdentity(process.pid);
  assert.ok(a?.born); assert.ok(a?.file); assert.ok(a?.command);
  assert.equal(sameTunnelIdentity(a, b), true);
  assert.equal(sameTunnelIdentity(a, { ...a, born: 'reused-pid' }), false);
  assert.equal(sameTunnelIdentity({}, {}), false);
  assert.equal(await tunnelIdentity('123; invalid'), null);
  assert.equal(await tunnelIdentity(-1), null);
});
test('Only exact HTTPS Quick Tunnel origins can be restored', () => {
  assert.equal(quickTunnelUrl('https://office-test.trycloudflare.com'), true);
  for (const u of ['http://office-test.trycloudflare.com', 'https://office-test.trycloudflare.com.evil.test', 'https://office-test.trycloudflare.com/path', 'https://evil.test', null]) assert.equal(quickTunnelUrl(u), false);
});
