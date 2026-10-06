import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

export default defineConfig({
  ...baseline,
  testMatch: 'choices*.browser.mjs',
  testIgnore: [],
  outputDir: '../.choices-results',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.choices-results/report.json', import.meta.url)) }]],
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4177' },
  webServer: {
    ...baseline.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 4177 --strictPort',
    url: 'http://127.0.0.1:4177',
  },
});
