// Local consent surface. A random per-start bearer is carried in a fragment, never a cookie/query or LAN listener.
import http from 'node:http';
import { readJson, json } from '../relay/server.mjs';
import { randomSecret } from '../src/shared/remote/crypto.js';
import en from '../src/i18n/locales/en/remote.js';
import vi from '../src/i18n/locales/vi/remote.js';
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LioOps Connector</title><link rel="stylesheet" href="/control.css"></head><body><main><h1>LioOps Connector</h1><p id="intro"></p><p id="status" role="status"></p><section id="scope" hidden><h2 id="scope-title"></h2><pre id="projects"></pre><label><input type="checkbox" id="allow-content"><span id="content-label"></span></label><label><input type="checkbox" id="allow-quota"><span id="quota-label"></span></label><label><input type="checkbox" id="allow-metrics"><span id="metrics-label"></span></label><button id="apply"></button></section><a id="invite" target="_blank" rel="noreferrer noopener" hidden></a><section id="pending" hidden><p id="compare"></p><code id="fingerprint"></code><button id="approve"></button><button id="reject"></button></section><button id="revoke" hidden></button><p id="note"></p></main><script src="/control.js"></script></body></html>';
const script = `
const token = new URLSearchParams(location.hash.slice(1)).get('control'); history.replaceState(null, '', '/');
const $ = id => document.getElementById(id); let pending, busy = false, refreshing = false, actionVersion = 0, copy, dirty = false, revision;
async function request(action, body = {}) {
  const response = await fetch('/control/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(action === 'status' ? 10000 : 45000) });
  if (!response.ok) throw new Error('unavailable'); return response.json();
}
async function refresh() {
  if (busy || refreshing) return; refreshing = true; const version = actionVersion;
  try {
    const data = await request('status'); if (busy || version !== actionVersion) return;
    copy = data.copy; pending = data.state.pending;
    $('intro').textContent = data.state.protocol === 2 ? copy.pcDIntro : copy.pcIntro; $('note').textContent = copy.pcNote;
    if (data.state.runtime) $('note').textContent += ' · LioOps Connector ' + copy.memory + ': ' + Math.round(data.state.runtime.rssBytes / 1048576) + ' MB';
    $('scope').hidden = data.state.protocol !== 2 || data.state.revoked;
    if (data.state.protocol === 2) {
      $('scope-title').textContent = copy.projectScope; $('projects').textContent = data.state.projects.join(String.fromCharCode(10));
      $('content-label').textContent = copy.allowContent; $('quota-label').textContent = copy.allowQuota; $('metrics-label').textContent = copy.allowMetrics; $('apply').textContent = copy.applyPermissions;
      if (!dirty) { revision = data.state.revision; $('allow-content').checked = data.state.permissions.content; $('allow-quota').checked = data.state.permissions.accountQuota; $('allow-metrics').checked = data.state.permissions.systemMetrics; }
    }
    $('status').textContent = copy[data.state.status === 'unavailable' ? 'unavailable' : data.state.revoked ? 'revoked' : data.state.paired ? 'trusted' : pending ? 'pending' : 'waiting'];
    $('invite').hidden = !data.inviteURL; if (data.inviteURL) $('invite').href = data.inviteURL; else $('invite').removeAttribute('href'); $('invite').textContent = copy.openInvite;
    $('pending').hidden = !pending; $('fingerprint').textContent = pending?.fingerprint || ''; $('compare').textContent = copy.compare;
    $('approve').textContent = copy.approve; $('reject').textContent = copy.reject; $('revoke').textContent = copy.revoke;
    $('revoke').hidden = data.state.revoked || !data.state.paired;
  } catch { if (!busy && version === actionVersion) $('status').textContent = copy?.unavailable || 'LioOps'; }
  finally { refreshing = false; }
}
async function action(name, body) {
  if (busy) return; busy = true; actionVersion++;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try { await request(name, body); } catch { $('status').textContent = copy?.unavailable || 'LioOps'; }
  finally { busy = false; dirty = false; for (const b of document.querySelectorAll('button')) b.disabled = false; await refresh(); }
}
$('approve').onclick = () => pending && action('approve', { fingerprint: pending.fingerprint, epoch: pending.epoch });
$('reject').onclick = () => action('revoke'); $('revoke').onclick = () => action('revoke');
for (const id of ['allow-content', 'allow-quota', 'allow-metrics']) $(id).onchange = () => { dirty = true; };
$('apply').onclick = () => action('permissions', { expectedRevision: revision, permissions: { content: $('allow-content').checked, accountQuota: $('allow-quota').checked, systemMetrics: $('allow-metrics').checked } });
void refresh(); setInterval(refresh, 1000);
`;
const css = 'body{margin:0;padding:32px;background:#101923;color:#dce7f6;font:15px/1.7 system-ui}main{max-width:640px;margin:5vh auto;padding:28px;border:1px solid #34495e;border-radius:18px}code{display:block;overflow-wrap:anywhere;padding:16px;background:#1c3042}button,a{display:inline-block;margin:16px 10px 0 0;padding:10px 16px;background:#79c7ba;color:#082e2a;border:0;border-radius:8px;font:inherit;cursor:pointer}a[hidden],section[hidden],button[hidden]{display:none}p:last-child{color:#92a9bf;font-size:13px}label{display:block;margin:10px 0}input{margin-right:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}h2{font-size:16px}';
export async function createControl(connector, { port = 0, language = 'vi' } = {}) {
  const token = randomSecret(); let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) { json(res, 403, { ok: false }); return; }
    if (req.method === 'GET') {
      const asset = req.url === '/' ? ['text/html; charset=utf-8', html] : req.url === '/control.js' ? ['application/javascript', script] : req.url === '/control.css' ? ['text/css', css] : null;
      if (!asset) { json(res, 404, { ok: false }); return; } res.writeHead(200, { 'Content-Type': asset[0] }); res.end(asset[1]); return;
    }
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { ok: false }); return; }
    try {
      const body = await readJson(req, 2000);
      if (req.url === '/control/status') { json(res, 200, { ok: true, state: connector.state, inviteURL: connector.inviteURL, copy: language === 'vi' ? vi : en }); return; }
      if (req.url === '/control/approve' && Object.keys(body).sort().join(',') === 'epoch,fingerprint') await connector.approve(body.fingerprint, body.epoch);
      else if (req.url === '/control/revoke' && Object.keys(body).length === 0) await connector.revoke();
      else if (req.url === '/control/permissions' && Object.keys(body).sort().join(',') === 'expectedRevision,permissions') await connector.setPermissions(body.permissions, body.expectedRevision);
      else { json(res, 400, { ok: false }); return; }
      json(res, 200, { ok: true });
    } catch { json(res, 409, { ok: false }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/#control=${token}`, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
