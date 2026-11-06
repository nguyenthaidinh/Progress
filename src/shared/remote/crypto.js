// JOSE sign-then-encrypt. Peer keys come from the local invitation/PC approval, never from the relay.
import { CompactEncrypt, compactDecrypt, SignJWT, jwtVerify, decodeJwt, generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, base64url } from 'jose';

export const WIRE_LIMIT = 256 * 1024;
const TYPE = 'lioops-observe-v1';
export const randomSecret = () => base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
export const isSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export class RemoteError extends Error { constructor(code) { super(code); this.name = 'RemoteError'; this.code = code; } }
export function requireRemote(condition, code = 'invalid') { if (!condition) throw new RemoteError(code); }
export function exact(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}
function publicJwk(value) {
  requireRemote(exact(value, ['kty', 'crv', 'x', 'y']) && value.kty === 'EC' && value.crv === 'P-256' && isSecret(value.x) && isSecret(value.y));
  return { kty: value.kty, crv: value.crv, x: value.x, y: value.y };
}
export async function validatePublic(value) {
  requireRemote(exact(value, ['id', 'sign', 'box']) && isSecret(value.id));
  const sign = publicJwk(value.sign), box = publicJwk(value.box);
  const id = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    `${await calculateJwkThumbprint(sign)}.${await calculateJwkThumbprint(box)}`))));
  requireRemote(value.id === id, 'identity'); return { id, sign, box };
}
export async function createIdentity({ extractable = false } = {}) {
  const sign = await generateKeyPair('ES256', { extractable }), box = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable });
  const signJwk = publicJwk(await exportJWK(sign.publicKey)), boxJwk = publicJwk(await exportJWK(box.publicKey));
  const id = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    `${await calculateJwkThumbprint(signJwk)}.${await calculateJwkThumbprint(boxJwk)}`))));
  return { public: { id, sign: signJwk, box: boxJwk }, sign: sign.privateKey, box: box.privateKey };
}
export async function exportIdentity(identity) {
  return { public: identity.public, sign: await exportJWK(identity.sign), box: await exportJWK(identity.box) };
}
export async function importIdentity(value) {
  const pub = await validatePublic(value.public);
  const sign = await importJWK(value.sign, 'ES256'), box = await importJWK(value.box, 'ECDH-ES');
  // Persisted private/public key mismatches fail before any peer can be accepted.
  const probe = await seal({ type: 'probe' }, { public: pub, sign, box }, pub);
  await open(probe, { public: pub, sign, box }, pub);
  return { public: pub, sign, box };
}
export async function seal(message, identity, recipient, now = Date.now()) {
  const peer = await validatePublic(recipient), iat = Math.floor(now / 1000);
  const signed = await new SignJWT({ ...message, v: message.v ?? 1 }).setProtectedHeader({ alg: 'ES256', typ: TYPE })
    .setIssuer(identity.public.id).setAudience(peer.id).setIssuedAt(iat).setExpirationTime(iat + 60).setJti(randomSecret()).sign(identity.sign);
  const result = await new CompactEncrypt(new TextEncoder().encode(signed))
    .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', cty: TYPE })
    .encrypt(await importJWK(peer.box, 'ECDH-ES'));
  requireRemote(result.length <= WIRE_LIMIT, 'size'); return result;
}
export async function open(ciphertext, identity, peer, now = Date.now()) {
  requireRemote(typeof ciphertext === 'string' && ciphertext.length <= WIRE_LIMIT && ciphertext.split('.').length === 5);
  const { plaintext, protectedHeader } = await compactDecrypt(ciphertext, identity.box, { keyManagementAlgorithms: ['ECDH-ES'], contentEncryptionAlgorithms: ['A256GCM'] });
  requireRemote(protectedHeader.cty === TYPE);
  const signed = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  // Only pairing may bootstrap a self-signed public key. Possession of the invitation and local approval are also required.
  const sender = await validatePublic(peer || decodeJwt(signed).body?.public);
  const { payload } = await jwtVerify(signed, await importJWK(sender.sign, 'ES256'), {
    algorithms: ['ES256'], typ: TYPE, issuer: sender.id, audience: identity.public.id,
    requiredClaims: ['iat', 'exp', 'jti'], maxTokenAge: 75, clockTolerance: 15, currentDate: new Date(now),
  });
  requireRemote([1, 2].includes(payload.v) && isSecret(payload.jti) && Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)
    && payload.exp - payload.iat === 60 && payload.iat <= Math.floor(now / 1000) + 15);
  return { payload, sender };
}

export function secureOrigin(value) {
  const url = new URL(value);
  requireRemote(!url.username && !url.password && !url.hash && !url.search && url.pathname === '/');
  requireRemote(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'https');
  return url.origin;
}
export async function tokenHash(token) {
  requireRemote(isSecret(token)); return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}
