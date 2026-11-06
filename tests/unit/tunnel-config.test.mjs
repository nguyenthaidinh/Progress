import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readTunnelConfig, publicOrigin, tunnelArgs, tunnelConfigKey, restoredTunnel } from '../../server/tunnel-config.mjs';

const settings = { OFFICE_PUBLIC_URL: 'https://office.example.com', OFFICE_TUNNEL_TOKEN_FILE: path.resolve('private-token.txt'), OFFICE_ACCESS_TEAM_DOMAIN: 'https://my-team.cloudflareaccess.com', OFFICE_ACCESS_AUD: 'application-audience' };
test('Quick tunnel defaults and protocol are explicit; incomplete managed settings fail closed', () => {
  assert.deepEqual(readTunnelConfig({}), { mode: 'quick', protocol: 'auto' });
  assert.equal(readTunnelConfig({ OFFICE_TUNNEL_PROTOCOL: 'http2' }).protocol, 'http2');
  assert.throws(() => readTunnelConfig({ OFFICE_TUNNEL_PROTOCOL: 'invalid' }));
  for (const key of Object.keys(settings)) assert.throws(() => readTunnelConfig({ ...settings, [key]: '' }));
});
test('Public origins cannot add credentials, ports, paths, IPs or rebinding names', () => {
  assert.equal(publicOrigin('https://OFFICE.example.com/'), 'https://office.example.com');
  for (const value of ['http://office.example.com', 'https://user:secret@office.example.com', 'https://office.example.com:4310', 'https://office.example.com/pin', 'https://office.example.com/?x=1', 'https://office.example.com/#x', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://office.local', 'not a URL']) assert.throws(() => publicOrigin(value));
  assert.throws(() => readTunnelConfig({ ...settings, OFFICE_ACCESS_TEAM_DOMAIN: 'https://my-team.cloudflareaccess.com.evil.example' }));
  assert.throws(() => readTunnelConfig({ ...settings, OFFICE_TUNNEL_TOKEN_FILE: 'relative.txt' }));
});
test('Managed command uses a token file; reuse binds origin, policy, protocol and token-file revision', () => {
  const config = readTunnelConfig(settings), key = tunnelConfigKey(config, 'revision-1');
  const args = tunnelArgs(config, 4317);
  assert.ok(args.includes('--token-file')); assert.equal(args.at(-1), settings.OFFICE_TUNNEL_TOKEN_FILE);
  assert.ok(!args.includes('--token')); assert.ok(!args.includes('--url'));
  const saved = { configKey: key, url: config.url };
  assert.equal(restoredTunnel(saved, config, key), true);
  assert.equal(restoredTunnel(saved, config, tunnelConfigKey(config, 'revision-2')), false);
  assert.equal(restoredTunnel({ ...saved, url: 'https://other.example.com' }, config, key), false);
  assert.equal(restoredTunnel({ url: config.url }, config, key), false);
  const quick = readTunnelConfig({}), quickKey = tunnelConfigKey(quick);
  assert.equal(restoredTunnel({ url: 'https://example.trycloudflare.com' }, quick, quickKey), true);
  assert.equal(restoredTunnel({ url: 'https://example.trycloudflare.com' }, { ...quick, protocol: 'http2' }, 'different'), false);
});
