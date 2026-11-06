// The internal Windows Connector stores identity and peer credentials with DPAPI CurrentUser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
function dpapi(input, decrypt) {
  const method = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::${method}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error('Credential protection timed out')); }, 30000);
    child.stdout.on('data', data => { output += data; if (output.length > 2 * 1024 * 1024) { failed = true; child.kill(); } });
    child.stderr.resume(); child.on('error', () => { clearTimeout(timer); reject(new Error('Credential protection unavailable')); });
    // exit may precede the final stdout chunk; only close guarantees the protected value was fully received.
    child.on('close', code => {
      clearTimeout(timer); const encoded = output.trim(), bytes = Buffer.from(encoded, 'base64');
      if (failed || code !== 0 || !bytes.length || bytes.toString('base64') !== encoded) reject(new Error('Credential protection failed'));
      else resolve(bytes);
    });
    child.stdin.on('error', () => {}); child.stdin.end(input.toString('base64'));
  });
}
export function secretStore(file) {
  const absolute = path.resolve(file);
  return {
    async load() {
      let raw; try { const stat = await fs.lstat(absolute); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid credential file'); raw = await fs.readFile(absolute, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const envelope = JSON.parse(raw), expected = process.platform === 'win32' ? 'dpapi-current-user' : 'posix-0600';
      if (envelope.protection !== expected || typeof envelope.data !== 'string') throw new Error('Credential protection mismatch');
      const bytes = Buffer.from(envelope.data, 'base64');
      return JSON.parse((process.platform === 'win32' ? await dpapi(bytes, true) : bytes).toString('utf8'));
    },
    async save(value) {
      await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      const bytes = Buffer.from(JSON.stringify(value)), windows = process.platform === 'win32';
      const envelope = { protection: windows ? 'dpapi-current-user' : 'posix-0600', data: (windows ? await dpapi(bytes, false) : bytes).toString('base64') };
      const temp = `${absolute}.${crypto.randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(envelope)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temp, absolute);
        if (!windows) { const directory = await fs.open(path.dirname(absolute), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
      }
      finally { await fs.rm(temp, { force: true }); }
    },
  };
}
