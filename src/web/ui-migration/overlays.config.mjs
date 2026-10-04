import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

export default defineConfig({
  ...baseline,
  testMatch: 'overlays*.browser.mjs',
  testIgnore: [],
  outputDir: '../.overlays-results',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.overlays-results/report.json', import.meta.url)) }]],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4176' },
  webServer: {
    ...baseline.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 4176 --strictPort',
    url: 'http://127.0.0.1:4176',
  },
});
