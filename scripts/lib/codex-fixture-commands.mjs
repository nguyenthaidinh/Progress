// Exact disposable-marker commands accepted by live tests. No arbitrary shell paths, appended commands or policies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function fixtureCommands(choice) {
  if (!['allow', 'deny'].includes(choice)) throw new Error('Unknown fixture marker');
  const command = `node approval.cjs ${choice}`;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const native = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');
  return [command, `"${ps}" -Command '${command}'`, ...(fs.existsSync(native) ? [`"${native}" -Command '${command}'`] : []),
    ...['/bin/bash', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh'].map((shell) => `${shell} -lc '${command}'`)];
}
