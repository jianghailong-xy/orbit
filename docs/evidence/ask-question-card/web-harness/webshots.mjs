// node webshots.mjs <tree> <port> <outdir> — vite on the tree's own config, the evidence page, one
// picture per conversation as it renders and after a click on the question card's row.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const [tree, port, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const { createServer } = await import(`${tree}/node_modules/vite/dist/node/index.js`);
const server = await createServer({
  configFile: `${tree}/src/web/vite.config.ts`,
  root: `${tree}/src/web`,
  cacheDir: `/mnt/data/tmp/ask-question-card/vite-cache-${path.basename(tree)}`,
  server: { port: Number(port), strictPort: true, host: '127.0.0.1' },
  logLevel: 'warn',
});
await server.listen();
const require = createRequire('/var/tmp/t1-main-baseline/package.json');
const { chromium } = require('playwright-core');
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/kimi-accounts-mock/fonts.conf' },
});
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 1400 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/shot.html`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('#q5 .chat-tool-card', { timeout: 120000 });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.waitForTimeout(800);
  for (const id of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    const el = await page.$('#' + id);
    await el.screenshot({ path: path.join(out, `web-${id}-a-as-opened.png`) });
    await page.click(`#${id} .chat-tool-row`);
    await page.waitForTimeout(400);
    await el.screenshot({ path: path.join(out, `web-${id}-c-tapped.png`) });
    console.log('shot', id);
  }
  console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
} finally {
  await browser.close();
  await server.close();
}
