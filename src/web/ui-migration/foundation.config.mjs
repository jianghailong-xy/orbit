import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

// Development-only fixture: no business route or production build entry is added.
export default defineConfig({
  ...baseline,
  testMatch: 'foundation*.browser.mjs',
  testIgnore: [],
  outputDir: '../.foundation-results',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.foundation-results/report.json', import.meta.url)) }]],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4174' },
  webServer: {
    ...baseline.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
  },
});
