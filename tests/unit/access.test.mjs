import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createAccessGate } from '../../server/access.mjs';

const config = { mode: 'managed', teamDomain: 'https://test-team.cloudflareaccess.com', audience: 'office-app' };
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] });
const gate = createAccessGate(config, { jwks });
const req = (token) => ({ headers: { 'cf-access-jwt-assertion': token } });
const now = Math.floor(Date.now() / 1000);
const sign = (claims = {}, header = {}) => new SignJWT({ iss: config.teamDomain, aud: config.audience, iat: now, exp: now + 300, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key', ...header }).sign(privateKey);
test('A valid Access signature, issuer, audience and time claims are required', async () => {
  assert.equal(await gate(req(await sign())), true);
  for (const claims of [{ iss: 'https://another.cloudflareaccess.com' }, { aud: 'other-app' }, { exp: now - 60 }, { nbf: now + 60 }, { exp: undefined }, { iat: undefined }]) assert.equal(await gate(req(await sign(claims))), false);
  assert.equal(await gate(req(await sign({}, { kid: 'unknown-key' }))), false);
});
test('Forged, missing, ambiguous or oversized JWT headers are rejected', async () => {
  const token = await sign(), parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ iss: config.teamDomain, aud: config.audience, iat: now, exp: now + 36000 })).toString('base64url');
  for (const value of [undefined, '', 'not-a-jwt', [token, token], 'x'.repeat(16_385), parts.join('.')]) assert.equal(await gate(req(value)), false);
  const hs = await new SignJWT({ iss: config.teamDomain, aud: config.audience, iat: now, exp: now + 300 }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32));
  assert.equal(await gate(req(hs)), false);
});
test('Key lookup failures deny access; quick mode retains the Office PIN gate, invalid config denies everything', async () => {
  const unavailable = createAccessGate(config, { jwks: async () => { throw new Error('Unavailable'); } });
  assert.equal(await unavailable(req(await sign())), false);
  assert.equal(await createAccessGate({ mode: 'quick' })(req()), true);
  assert.equal(await createAccessGate({ error: 'Partial managed settings' })(req(await sign())), false);
});
