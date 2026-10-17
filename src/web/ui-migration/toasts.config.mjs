import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

export default defineConfig({
  ...baseline,
  testMatch: 'toasts*.browser.mjs',
  testIgnore: [],
  outputDir: '../.toasts-results',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.toasts-results/report.json', import.meta.url)) }]],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:14377' },
  webServer: {
    ...baseline.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 14377 --strictPort',
    url: 'http://127.0.0.1:14377',
  },
});
