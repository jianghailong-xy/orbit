import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import prior from '../p2-keyboard-window/menu-held-frames.config.mjs';

// The Menu fix's own held-frames probe (p2-keyboard-window, unchanged), with its results in KW2_RESULTS.
const results = process.env.KW2_RESULTS;
export default defineConfig({
  ...prior,
  testDir: fileURLToPath(new URL('../p2-keyboard-window', import.meta.url)),
  outputDir: results,
  reporter: [['list'], ['json', { outputFile: `${results}/report.json` }]],
});
