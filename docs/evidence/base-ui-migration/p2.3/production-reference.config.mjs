import baseline from './playwright.config.mjs';
export default {
  ...baseline,
  testMatch: 'feedback-production.browser.mjs',
  use: { ...baseline.use, baseURL: 'http://127.0.0.1:14379' },
  webServer: { ...baseline.webServer,
    command: 'npm run preview -- --host 127.0.0.1 --port 14379 --strictPort',
    url: 'http://127.0.0.1:14379',
  },
};
