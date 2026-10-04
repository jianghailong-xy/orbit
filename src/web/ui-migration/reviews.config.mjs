import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import baseline from './playwright.config.mjs';

export default defineConfig({
  ...baseline,
  testMatch: 'reviews.check.mjs',
  testIgnore: [],
  outputDir: '../.reviews-results',
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../.reviews-results/report.json', import.meta.url)) }]],
  projects: baseline.projects.filter((project) => project.use.browserName === 'chromium').map((project) => ({
    ...project,
    use: { ...project.use, viewport: project.use.isMobile ? { width: 393, height: 844 } : { width: 1280, height: 900 } },
  })),
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:4177' },
  webServer: {
    ...baseline.webServer,
    command: 'npm run dev -- --host 127.0.0.1 --port 4177 --strictPort',
    url: 'http://127.0.0.1:4177',
  },
});
