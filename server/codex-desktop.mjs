// Open an existing local Codex conversation using the documented desktop deep link, without sending another prompt.
import { execFile } from 'node:child_process';
import path from 'node:path';

export const codexThreadUrl = (sid) => typeof sid === 'string' && /^[\w-]{1,200}$/.test(sid) && sid.toLowerCase() !== 'new'
  ? `codex://threads/${sid}` : null;

export function createCodexDesktop({ platform = process.platform, env = process.env, execute = execFile, now = Date.now } = {}) {
  const supported = ['win32', 'darwin', 'linux'].includes(platform), enabled = env.OFFICE_CODEX_DESKTOP !== '0' && supported;
  let opening = null, last = null;
  return {
    info: () => ({ enabled, supported }),
    open(sid) {
      const url = codexThreadUrl(sid);
      if (!url) return Promise.resolve({ ok: false, code: 'invalid' });
      if (!enabled) return Promise.resolve({ ok: false, code: supported ? 'disabled' : 'unsupported' });
      if (opening) return opening.sid === sid ? opening.promise : Promise.resolve({ ok: false, code: 'busy' });
      if (last?.sid === sid && now() - last.at < 2000) return Promise.resolve({ ok: true });
      let file, args;
      if (platform === 'win32') {
        file = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        // Do not show the Windows "choose an app" dialog when the protocol is not installed.
        // sid is one validated path segment; neither arbitrary URLs nor shell commands are accepted.
        const script = `$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('codex'); if($null -eq $key -or $null -eq $key.GetValue('URL Protocol',$null)){exit 3}; $key.Close(); try{Start-Process -FilePath '${url}' -ErrorAction Stop}catch{exit 1}`;
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      } else { file = platform === 'darwin' ? '/usr/bin/open' : 'xdg-open'; args = [url]; }
      const promise = new Promise((resolve) => {
        try {
          execute(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 8192 }, (error) => {
            if (!error) last = { sid, at: now() };
            resolve(error ? { ok: false, code: error.code === 3 ? 'unavailable' : 'failed' } : { ok: true });
          });
        } catch { resolve({ ok: false, code: 'failed' }); }
      });
      opening = { sid, promise };
      void promise.then(() => { if (opening?.promise === promise) opening = null; });
      return promise;
    },
  };
}
