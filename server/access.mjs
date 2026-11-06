// Validate Access at the untrusted listener, before PIN pages, assets and API handlers. Never trust a header's presence.
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function createAccessGate(config, { jwks } = {}) {
  if (config.error) return async () => false;
  if (config.mode !== 'managed') return async () => true;
  const keys = jwks || createRemoteJWKSet(new URL('/cdn-cgi/access/certs', config.teamDomain), {
    timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 600_000,
  });
  return async (req) => {
    const token = req.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || token.length > 16_384 || !token) return false;
    try {
      await jwtVerify(token, keys, { issuer: config.teamDomain, audience: config.audience,
        algorithms: ['RS256'], requiredClaims: ['exp', 'iat'], clockTolerance: 5 });
      return true;
    } catch { return false; } // Neither JWTs, identity claims nor verification errors enter logs or API responses.
  };
}
