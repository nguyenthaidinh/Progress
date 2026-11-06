// Identify a saved tunnel by its executable, command and OS creation marker before reusing or terminating its PID.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args,
  { timeout: 15_000, windowsHide: true, maxBuffer: 128 * 1024 }, (err, out) => err ? reject(err) : resolve(String(out).trim())));
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function tunnelIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === 'win32') {
      // Only the validated numeric PID enters this script; no paths or shell command strings are interpolated.
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){[pscustomobject]@{file=$p.ExecutablePath;command=$p.CommandLine;born=$p.CreationDate.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress}`]);
      const p = JSON.parse(out);
      return p.file && p.command && p.born ? { file: p.file.toLowerCase(), born: p.born, command: digest(p.command) } : null;
    }
    if (process.platform === 'linux') {
      const [file, command, stat] = await Promise.all([fs.readlink(`/proc/${pid}/exe`), fs.readFile(`/proc/${pid}/cmdline`), fs.readFile(`/proc/${pid}/stat`, 'utf8')]);
      return { file, command: digest(command), born: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    }
    const out = await run('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm=', '-o', 'args=']);
    const m = /^(.{24})\s+(.+)$/.exec(out);
    return m ? { file: m[2], command: digest(m[2]), born: m[1] } : null;
  } catch { return null; }
}
export const sameTunnelIdentity = (a, b) => !!a && !!b && ['file', 'born', 'command'].every((k) => typeof a[k] === 'string' && a[k].length > 0 && a[k] === b[k]);
export const quickTunnelUrl = (url) => typeof url === 'string' && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url);
