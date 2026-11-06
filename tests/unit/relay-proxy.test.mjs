import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../../relay/server.mjs';
import { randomSecret } from '../../src/shared/remote/crypto.js';

async function fixture(t, trustProxy, remoteAddress) {
  const { server } = createRelay({ adminToken: randomSecret(), origins: ['https://ops.liotnu.com'], trustProxy });
  if (remoteAddress) server.prependListener('request', req => Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return async ip => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: { 'X-Real-IP': ip } });
    await response.body.cancel(); return response.status;
  };
}

test('an enabled loopback proxy preserves distinct client rate limits', async t => {
  const get = await fixture(t, true);
  for (let i = 0; i < 180; i++) assert.equal(await get('203.0.113.1'), 200);
  assert.equal(await get('203.0.113.1'), 429); assert.equal(await get('203.0.113.2'), 200);
});

test('forwarded client addresses cannot bypass default relay limits', async t => {
  const get = await fixture(t, false);
  for (let i = 0; i < 180; i++) assert.equal(await get('203.0.113.1'), 200);
  assert.equal(await get('203.0.113.2'), 429);
});

test('non-loopback clients cannot assert trusted proxy headers', async t => {
  const get = await fixture(t, true, '198.51.100.10');
  for (let i = 0; i < 180; i++) assert.equal(await get('203.0.113.1'), 200);
  assert.equal(await get('203.0.113.2'), 429);
});
