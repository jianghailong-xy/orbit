import { defineConfig } from '@playwright/test';
import baseline from './playwright.config.mjs';
const output = process.env.PROBE_OUTPUT;
const port = Number(process.env.PROBE_PORT || 4461);
export default defineConfig({
  ...baseline,
  testMatch: process.env.PROBE_MATCH || 'probe-*.browser.mjs',
  testIgnore: [],
  globalSetup: ['./environment.mjs'],
  outputDir: output,
  reporter: [['list']],
  use: { ...baseline.use, baseURL: `http://127.0.0.1:${port}` },
  webServer: { ...baseline.webServer, command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}` },
});
