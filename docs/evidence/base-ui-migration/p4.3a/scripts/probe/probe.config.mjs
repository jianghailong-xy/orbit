import { defineConfig } from '@playwright/test';
import baseline from '/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/ref/src/web/ui-migration/playwright.config.mjs';

// One-off probe config for the ref tree: tests from this directory, the tree's own build served.
const port = Number(process.env.PROBE_PORT || 4191);
export default defineConfig({
  ...baseline,
  testDir: '.',
  testMatch: ['probe-p43a.browser.mjs', 'probe2.browser.mjs', 'probe4.browser.mjs'],
  testIgnore: [],
  globalSetup: ['/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/ref/src/web/ui-migration/environment.mjs'],
  outputDir: '/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/probe/out-ref',
  reporter: [['list']],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, cwd: '/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1/ref/src/web', command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
