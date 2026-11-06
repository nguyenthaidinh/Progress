import { defineConfig } from '@playwright/test';
// Test the exported product without a PC backend, private data folder or AI installation.
process.env.LIOOPS_OBSERVER_STATIC = '1';
const port = Number(process.env.E2E_PORT || 4398);
export default defineConfig({
  testDir: 'tests/e2e', testMatch: ['observer.spec.ts', 'connection-setup.spec.ts', 'encrypted-observation.spec.ts', 'project-observation.spec.ts', 'project-permissions.spec.ts'], outputDir: process.env.E2E_OUT || 'test-results-observer-web',
  workers: 1, retries: 0, timeout: 150000, expect: { timeout: 30000 },
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, actionTimeout: 30000 },
  webServer: { command: 'node scripts/preview-web.mjs', url: `http://127.0.0.1:${port}`, env: { WEB_PORT: String(port) }, reuseExistingServer: false, timeout: 30000 },
});
