import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';
// Probes (dev-only, not in the app's suites) on this tree's production build: the probe-*.browser.mjs
// files are copied into src/web/ui-migration for a run and removed after it. TREE names the tree.
export default defineConfig({
  ...baseline,
  testMatch: 'probe-*.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: `/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2/runs/probe-out-${process.env.TREE}`,
  reporter: [['list']],
});
