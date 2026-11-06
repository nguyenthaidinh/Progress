// Local, newline-delimited Codex App Server protocol. Never opens a network listener.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const PROJECT_CODEX = fileURLToPath(new URL('../../node_modules/@openai/codex/bin/codex.js', import.meta.url));
let projectVersion;

export function findCodex(env = process.env) {
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = env.OFFICE_CODEX_BIN ? [env.OFFICE_CODEX_BIN] : [PROJECT_CODEX,
    path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', exe),
    path.join(os.homedir(), '.local', 'bin', exe),
    ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe))];
  for (const file of candidates) {
    try { if (!file || !fs.statSync(file).isFile()) continue; } catch { continue; }
    if (/\.cmd$/i.test(file)) continue; // Never put user input through cmd.exe.
    const source = file === env.OFFICE_CODEX_BIN ? 'override' : file === PROJECT_CODEX ? 'project' : 'system';
    if (source === 'project' && projectVersion === undefined) { try { projectVersion = JSON.parse(fs.readFileSync(new URL('../../node_modules/@openai/codex/package.json', import.meta.url), 'utf8')).version; } catch { projectVersion = null; } }
    const version = source === 'project' ? projectVersion : null;
    return /\.[cm]?js$/i.test(file) ? { file: process.execPath, args: [file], source, version } : { file, args: [], source, version };
  }
  if (env.OFFICE_CODEX_BIN) return null;
  // npm's Windows shim has a JavaScript entry point that can be run without a shell.
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(file)) return { file: process.execPath, args: [file] };
  }
  return null;
}

export function createCodexRpc({ binary = findCodex, env = process.env, spawnProcess = spawn,
  onNotification = () => {}, onRequest = () => {}, onDisconnect = () => {}, timeout = 20_000, startupTimeout = 120_000,
  maxMessageBytes = 16_000_000 } = {}) {
  let current = null, seq = 0, closed = false;
  function send(c, msg) {
    if (current !== c || c.dead || !c.proc.stdin.writable) throw new Error('Codex is not connected');
    const data = JSON.stringify(msg) + '\n';
    if (Buffer.byteLength(data) > maxMessageBytes || c.proc.stdin.writableLength + Buffer.byteLength(data) > 32_000_000) throw new Error('Codex outgoing message exceeds size limit');
    c.proc.stdin.write(data);
  }
  function disconnected(c, error) {
    if (c.dead) return;
    c.dead = true;
    if (current === c) current = null;
    for (const p of c.waiting.values()) { clearTimeout(p.timer); p.reject(error); }
    c.waiting.clear();
    c.proc.kill();
    onDisconnect(error);
  }
  function request(c, method, params = {}) {
    return new Promise((resolve, reject) => {
      // A timed-out mutation may have been accepted. Drop this connection and never replay it.
      const id = ++seq, timer = setTimeout(() => {
        const error = new Error(`Codex timeout: ${method}`);
        if (/^(thread\/(list|read|turns\/list|items\/list|loaded\/list|backgroundTerminals\/list)|model\/list|account\/(read|rateLimits\/read))$/.test(method)) { c.waiting.delete(id); reject(error); }
        else disconnected(c, error);
      }, /^thread\/(start|resume|fork)$/.test(method) ? startupTimeout : timeout);
      c.waiting.set(id, { resolve, reject, timer });
      try { send(c, { id, method, params }); } catch (e) { clearTimeout(timer); c.waiting.delete(id); reject(e); }
    });
  }
  function receive(c, line) {
    if (!line.trim() || c.dead || current !== c) return;
    let msg; try { msg = JSON.parse(line); } catch { disconnected(c, new Error('Malformed Codex protocol message')); return; }
    if (!msg || typeof msg !== 'object') { disconnected(c, new Error('Malformed Codex protocol message')); return; }
    if (msg.method) {
      const fn = msg.id == null ? onNotification : onRequest;
      Promise.resolve().then(() => { if (!c.dead && current === c) return fn(msg); }).catch(() => {
        if (msg.id != null) { try { send(c, { id: msg.id, error: { code: -32603, message: 'Office could not handle this request' } }); } catch { /* disconnected */ } }
      });
      return;
    }
    const p = c.waiting.get(msg.id); if (!p) return;
    c.waiting.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'Codex request failed'), { code: msg.error.code }));
    else p.resolve(msg.result);
  }
  async function connect() {
    if (closed) throw new Error('Codex connection closed');
    let c = current;
    if (!c) {
      const bin = binary(); if (!bin) throw new Error('Codex CLI not found. Install Codex or set OFFICE_CODEX_BIN.');
      const proc = spawnProcess(bin.file, [...(bin.args || []), 'app-server', '--listen', 'stdio://'],
        { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      c = current = { proc, dead: false, buffer: '', decoder: new StringDecoder('utf8'), waiting: new Map(), ready: null };
      proc.stdout.on('data', (data) => {
        if (c.dead || current !== c) return;
        c.buffer += c.decoder.write(data);
        let end;
        while (!c.dead && (end = c.buffer.indexOf('\n')) >= 0) {
          const line = c.buffer.slice(0, end); c.buffer = c.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > maxMessageBytes) { disconnected(c, new Error('Codex message exceeds size limit')); return; }
          receive(c, line);
        }
        if (!c.dead && Buffer.byteLength(c.buffer) > maxMessageBytes) disconnected(c, new Error('Codex message exceeds size limit'));
      });
      proc.stderr.on('data', () => {}); // Drain, but don't persist prompts or credentials from diagnostics.
      proc.stdout.on('end', () => disconnected(c, new Error('Codex output closed')));
      proc.stdout.on('error', () => disconnected(c, new Error('Codex output failed')));
      proc.stdin.on('error', () => disconnected(c, new Error('Codex input closed')));
      proc.on('error', () => disconnected(c, new Error('Codex could not start')));
      proc.on('exit', () => disconnected(c, new Error('Codex process exited')));
      c.ready = request(c, 'initialize', { clientInfo: { name: 'my-office', title: 'LioOps', version: '0.2.0' }, capabilities: { experimentalApi: true } })
        .then(() => send(c, { method: 'initialized' })).catch((e) => { disconnected(c, e); throw e; });
    }
    await c.ready;
    return c;
  }
  return {
    async call(method, params) { return request(await connect(), method, params); },
    reply(id, result) { if (!current) throw new Error('Codex is not connected'); send(current, { id, result }); },
    reject(id) { if (current) send(current, { id, error: { code: -32601, message: 'This interaction is not supported by LioOps' } }); },
    close() { closed = true; if (current) disconnected(current, new Error('Office stopped')); },
  };
}
