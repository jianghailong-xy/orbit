import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

export default defineConfig({
  ...baseline,
  testMatch: 'reference-lifecycle.browser.mjs',
  testIgnore: [],
  outputDir: '../.lifecycle-results',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.lifecycle-results/report.json', import.meta.url)) }]],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:14380' },
  webServer: {
    ...baseline.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 14380 --strictPort',
    url: 'http://127.0.0.1:14380',
  },
});
