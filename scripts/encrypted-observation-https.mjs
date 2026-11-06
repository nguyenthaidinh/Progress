// External-network acceptance is opt-in and shares fixture ciphertext only, never a real project or PC API.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--run')) {
  console.log('Runs the encrypted observation browser test through a temporary real HTTPS relay tunnel. Requires build:web and cloudflared; fixture data only. Add --run.');
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url)), 'test', '--config', 'playwright.observer.config.ts', 'encrypted-observation.spec.ts'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, LIOOPS_C_RELAY_HTTPS: '1', E2E_PORT: process.env.E2E_PORT || '4478', E2E_OUT: process.env.E2E_OUT || 'test-results-c-https' },
  });
  child.on('error', () => { process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
}
