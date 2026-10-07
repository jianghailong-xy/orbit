import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';

// P3.2 same-commit comparison (after P3.1's p0-reference.config.mjs): the P0 page matrix, with
// screenshots read from (or, for the reference tree only, written to) P32_SNAPSHOTS instead of the
// immutable P0.2 baseline, and the preview on P32_PORT so a reference and a delivery tree can run
// side by side. Copy into src/web/ui-migration/ of the tree under test.
const snapshots = process.env.P32_SNAPSHOTS;
const output = process.env.P32_OUTPUT;
const port = Number(process.env.P32_PORT || 4173);
if (!snapshots || !output) throw new Error('Set P32_SNAPSHOTS and P32_OUTPUT');
export default defineConfig({
  ...baseline,
  // The pilot specs copied into the reference tree run under pilot.config.mjs, not in this matrix.
  testIgnore: [...new Set([...(baseline.testIgnore ?? []), 'pilot*.browser.mjs'])],
  snapshotPathTemplate: `${snapshots}/{projectName}/{arg}{ext}`,
  outputDir: output,
  reporter: [['list'], ['json', { outputFile: `${output}/report.json` }]],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
