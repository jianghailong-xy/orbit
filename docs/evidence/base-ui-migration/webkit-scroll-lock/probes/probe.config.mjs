import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';
// Probes (dev-only, not in the app's suites) on this tree's production build: copied into
// src/web/ui-migration for a run and removed after it.
export default defineConfig({
  ...baseline,
  testMatch: 'probe-*.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: `/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes/out-${process.env.PROBE_LABEL || 'run'}`,
  reporter: [['list']],
});
