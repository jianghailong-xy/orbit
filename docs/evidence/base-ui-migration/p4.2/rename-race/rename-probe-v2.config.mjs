import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';
// Dev-only probe (not committed): the account menu's Rename and a workspace's Configure on the unminified
// dev server. TREE names the tree.
export default defineConfig({
  ...baseline,
  testMatch: 'rename-probe.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: `/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2/runs/rename-probe-out-${process.env.TREE}`,
  reporter: [['list']],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: { ...baseline.webServer, command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort', url: 'http://127.0.0.1:4173' },
});
