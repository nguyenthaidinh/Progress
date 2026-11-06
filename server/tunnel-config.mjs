// Explicit Quick/managed tunnel configuration. Partial or invalid managed settings never fall back to a public tunnel.
import path from 'node:path';
import crypto from 'node:crypto';

export function publicOrigin(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid public HTTPS origin');
  const u = new URL(input);
  const dns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash
    || !dns.test(u.hostname) || u.hostname.endsWith('.local') || u.hostname === 'localhost') throw new Error('Invalid public HTTPS origin');
  return u.origin;
}
export function readTunnelConfig(env = process.env) {
  const protocol = env.OFFICE_TUNNEL_PROTOCOL || 'auto';
  if (!['auto', 'http2', 'quic'].includes(protocol)) throw new Error('OFFICE_TUNNEL_PROTOCOL must be auto, http2 or quic');
  const names = ['OFFICE_PUBLIC_URL', 'OFFICE_TUNNEL_TOKEN_FILE', 'OFFICE_ACCESS_TEAM_DOMAIN', 'OFFICE_ACCESS_AUD'];
  const managed = names.some((name) => !!env[name]);
  if (!managed) return { mode: 'quick', protocol };
  if (!names.every((name) => !!env[name])) throw new Error('Managed tunnel requires OFFICE_PUBLIC_URL, OFFICE_TUNNEL_TOKEN_FILE, OFFICE_ACCESS_TEAM_DOMAIN and OFFICE_ACCESS_AUD');
  const url = publicOrigin(env.OFFICE_PUBLIC_URL), teamDomain = publicOrigin(env.OFFICE_ACCESS_TEAM_DOMAIN);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(new URL(teamDomain).hostname)) throw new Error('Invalid Cloudflare Access team domain');
  if (!path.isAbsolute(env.OFFICE_TUNNEL_TOKEN_FILE)) throw new Error('OFFICE_TUNNEL_TOKEN_FILE must be an absolute path');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(env.OFFICE_ACCESS_AUD)) throw new Error('Invalid Cloudflare Access audience');
  return { mode: 'managed', protocol, url, teamDomain, audience: env.OFFICE_ACCESS_AUD, tokenFile: path.resolve(env.OFFICE_TUNNEL_TOKEN_FILE) };
}
export const tunnelConfigKey = (config, tokenRevision = '') => crypto.createHash('sha256').update(JSON.stringify({ ...config, tokenRevision })).digest('hex');
export function tunnelArgs(config, port) {
  const args = ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--protocol', config.protocol];
  return config.mode === 'managed' ? [...args, 'run', '--token-file', config.tokenFile] : [...args, '--url', `http://127.0.0.1:${port}`];
}
export function restoredTunnel(saved, config, key) {
  if (saved?.configKey && saved.configKey !== key) return false;
  if (config.mode === 'managed') return saved?.configKey === key && saved.url === config.url;
  return (saved?.configKey === key || (!saved?.configKey && config.protocol === 'auto')) && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(saved?.url || '');
}
