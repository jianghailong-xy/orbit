import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';
// p0-drift's announce-duplicate diagnostic (flake/announce-duplicate.browser.mjs, copied as
// probe-announce-duplicate.browser.mjs) on this tree's production build, with its JSON report kept.
const out = `/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes/out-${process.env.PROBE_LABEL || 'run'}`;
export default defineConfig({
  ...baseline,
  testMatch: 'probe-announce-duplicate.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: out,
  reporter: [['list'], ['json', { outputFile: `${out}/report.json` }]],
});
