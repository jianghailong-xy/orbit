import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

// The session column read from GET /sessions/listing (session-listing.browser.mjs) on a production build, in
// Chromium at the desktop size (docs/session-list-scale-design.md §3). SESSION_LISTING_OUTPUT moves the results
// and SESSION_LISTING_PORT the server, so two trees can run side by side. SESSION_LISTING_DIST serves another
// build's dist (the build before the change, for the column's reference shot), and SESSION_LISTING_SNAPSHOTS is
// where the reference shots are kept: written by a run with --update-snapshots on that build, compared on this one.
const output = process.env.SESSION_LISTING_OUTPUT || fileURLToPath(new URL('../.ui-migration-results/session-listing', import.meta.url));
const snapshots = process.env.SESSION_LISTING_SNAPSHOTS || `${output}-snapshots`;
const port = Number(process.env.SESSION_LISTING_PORT || 4174);
const dist = process.env.SESSION_LISTING_DIST ? ` --outDir ${process.env.SESSION_LISTING_DIST}` : '';
export default defineConfig({
  ...baseline,
  testMatch: 'session-listing.browser.mjs',
  testIgnore: [],
  timeout: 180_000,
  globalSetup: [],
  outputDir: output,
  snapshotPathTemplate: `${snapshots}/{arg}{ext}`,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  projects: baseline.projects.filter((project) => project.name === 'chromium-light-desktop'),
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    ...baseline.webServer,
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort${dist}`,
    url: `http://127.0.0.1:${port}`,
  },
});
