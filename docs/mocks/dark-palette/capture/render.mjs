// Renders board.html to board.png at 2x:  node docs/mocks/dark-palette/capture/render.mjs [fontDir]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..');
const WT = path.resolve(dir, '../../..');
const fontDir = process.argv[2] ?? '/mnt/tmp/acp-mock/fonts';
const { chromium } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1880, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(`file://${dir}/board.html`);
await page.addStyleTag({ content: ['Inter', 'NotoSansSC', 'JetBrainsMono'].map((f) =>
  `@font-face{font-family:'${{ Inter: 'Inter', NotoSansSC: 'Noto Sans SC', JetBrainsMono: 'JetBrains Mono' }[f]}';src:url("file://${fontDir}/${f}.ttf");font-weight:100 900}`).join('\n') });
await page.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load().catch(() => {}))); await document.fonts.ready; });
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
await page.locator('.board').screenshot({ path: `${dir}/board.png` });
console.log([...await page.evaluate(() => [...document.fonts].map((f) => `${f.family}:${f.status}`))].join(' '));
await browser.close();
