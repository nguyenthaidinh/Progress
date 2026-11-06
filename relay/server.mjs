// Trial relay: volatile opaque mailboxes only. No provider API, filesystem, content log or decryption key.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isSecret, tokenHash, WIRE_LIMIT, secureOrigin } from '../src/shared/remote/crypto.js';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function readJson(req, limit = WIRE_LIMIT + 1000) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('contentType'), { status: 415 });
  let size = 0, text = '';
  req.setEncoding('utf8');
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > limit) throw Object.assign(new Error('size'), { status: 413 }); text += chunk; }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('json'), { status: 400 }); }
}
export function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
}
export function createRelay({ adminToken, origins, now = Date.now, maxRoutes = 32, maxBytes = 8 * 1024 * 1024, pollMs = 12000 } = {}) {
  if (!isSecret(adminToken) || !origins?.length) throw new Error('Explicit relay admin token and browser origins required');
  const allowed = new Set(origins.map(secureOrigin)), routes = new Map(), rates = new Map(); let queuedBytes = 0;
  function expire(route) {
    for (const queue of Object.values(route.queues)) for (const item of queue) queuedBytes -= item.ciphertext.length;
    for (const waiter of Object.values(route.waiters)) waiter?.finish(404, { ok: false });
    routes.delete(route.id);
  }
  const sweep = setInterval(() => {
    const clock = now();
    for (const route of routes.values()) {
      if (route.expires <= clock) { expire(route); continue; }
      for (const queue of Object.values(route.queues)) while (queue.length && queue[0].at < clock - 30000) queuedBytes -= queue.shift().ciphertext.length;
    }
  }, 5000); sweep.unref();
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) { json(res, 403, { ok: false }); return; }
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const clock = now();
    for (const route of routes.values()) if (route.expires <= clock) expire(route);
    for (const [key, value] of rates) if (value.until <= clock) rates.delete(key);
    const ip = req.socket.remoteAddress, rate = rates.get(ip) || { n: 0, until: clock + 60000 };
    if (!rates.has(ip) && rates.size >= 1024 || ++rate.n > 180) { json(res, 429, { ok: false }); return; }
    rates.set(ip, rate);
    try {
      if (req.method === 'GET' && req.url === '/health') { json(res, 200, { ok: true }); return; }
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return; }
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
      if (!bearer) { json(res, 401, { ok: false }); return; }
      if (req.url === '/v1/routes') {
        if (origin || !equal(bearer, adminToken)) { json(res, 403, { ok: false }); return; }
        const body = await readJson(req, 1000);
        if (!body || Object.keys(body).sort().join(',') !== 'browserHash,connectorHash,id' || ![body.id, body.connectorHash, body.browserHash].every(isSecret)
          || body.connectorHash === body.browserHash) { json(res, 400, { ok: false }); return; }
        const previous = routes.get(body.id);
        if (previous) { json(res, equal(previous.connectorHash, body.connectorHash) && equal(previous.browserHash, body.browserHash) ? 200 : 409, { ok: equal(previous.connectorHash, body.connectorHash) && equal(previous.browserHash, body.browserHash) }); return; }
        if (routes.size >= maxRoutes) { json(res, 429, { ok: false }); return; }
        routes.set(body.id, { ...body, expires: clock + 86400000, queues: { browser: [], connector: [] }, waiters: { browser: null, connector: null } });
        json(res, 201, { ok: true }); return;
      }
      const match = /^\/v1\/routes\/([A-Za-z0-9_-]{43})\/(send|poll|close)$/.exec(req.url);
      const route = match && routes.get(match[1]); if (!route) { json(res, 404, { ok: false }); return; }
      const hash = await tokenHash(bearer), side = equal(hash, route.connectorHash) ? 'connector' : equal(hash, route.browserHash) ? 'browser' : null;
      if (!side) { json(res, 401, { ok: false }); return; }
      const body = await readJson(req);
      if (match[2] === 'close') {
        if (side !== 'connector') { json(res, 403, { ok: false }); return; }
        expire(route); json(res, 200, { ok: true }); return;
      }
      if (match[2] === 'send') {
        if (!body || Object.keys(body).join(',') !== 'ciphertext' || typeof body.ciphertext !== 'string' || body.ciphertext.length > WIRE_LIMIT
          || !/^[A-Za-z0-9_.-]+$/.test(body.ciphertext) || body.ciphertext.split('.').length !== 5) { json(res, 400, { ok: false }); return; }
        const to = side === 'browser' ? 'connector' : 'browser';
        if (route.waiters[to]) route.waiters[to].finish(200, { ok: true, ciphertext: body.ciphertext });
        else {
          // Keep a short queue; no disk spool and no queued delivery after 30 seconds.
          const queue = route.queues[to];
          while (queue.length && queue[0].at < clock - 30000) queuedBytes -= queue.shift().ciphertext.length;
          if (queue.length >= 4 || queuedBytes + body.ciphertext.length > maxBytes) { json(res, 429, { ok: false }); return; }
          queue.push({ ciphertext: body.ciphertext, at: clock }); queuedBytes += body.ciphertext.length;
        }
        json(res, 202, { ok: true }); return;
      }
      if (Object.keys(body || {}).length) { json(res, 400, { ok: false }); return; }
      const queue = route.queues[side];
      while (queue.length) {
        const item = queue.shift(); queuedBytes -= item.ciphertext.length;
        if (item.at >= clock - 30000) { json(res, 200, { ok: true, ciphertext: item.ciphertext }); return; }
      }
      if (route.waiters[side]) { json(res, 409, { ok: false }); return; }
      const finish = (status, data) => { clearTimeout(timer); route.waiters[side] = null; json(res, status, data); };
      const timer = setTimeout(() => finish(200, { ok: true, ciphertext: null }), pollMs);
      route.waiters[side] = { finish };
      res.once('close', () => { if (route.waiters[side]?.finish === finish) { clearTimeout(timer); route.waiters[side] = null; } });
    } catch (error) { json(res, error.status || 400, { ok: false }); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.maxConnections = 100;
  server.on('close', () => { clearInterval(sweep); for (const route of routes.values()) expire(route); });
  return { server, metadata: () => ({ routes: routes.size, queuedBytes }) };
}
