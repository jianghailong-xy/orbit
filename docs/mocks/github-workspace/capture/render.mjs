// node render.mjs <abs board.html> [out.png] — shoots .board at 2x with Inter / Noto Sans SC / JetBrains Mono.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire('/mnt/data/tmp/lt-mock/node_modules/');
const { chromium } = require('playwright');
const [html, out = html.replace(/\.html$/, '.png')] = process.argv.slice(2);
const fonts = '/mnt/data/tmp/gh-ws-mock/fonts';
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1720, height: 1200 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(html).href);
await page.addStyleTag({ content: `
@font-face { font-family: Inter; src: url("file://${fonts}/Inter.ttf"); font-weight: 100 900; }
@font-face { font-family: "Noto Sans SC"; src: url("file://${fonts}/NotoSansSC.ttf"); font-weight: 100 900; }
@font-face { font-family: "JetBrains Mono"; src: url("file://${fonts}/JetBrainsMono.ttf"); font-weight: 100 900; }
@font-face { font-family: BlinkMacSystemFont; src: url("file://${fonts}/Inter.ttf"); font-weight: 100 900; }
@font-face { font-family: "PingFang SC"; src: url("file://${fonts}/NotoSansSC.ttf"); font-weight: 100 900; }
` });
await page.evaluate(async () => {
  await Promise.all(['Inter', 'Noto Sans SC', 'JetBrains Mono', 'BlinkMacSystemFont', 'PingFang SC'].map((f) => document.fonts.load(`16px "${f}"`, 'Aa中')));
  await document.fonts.ready;
});
await page.waitForTimeout(200);
await page.locator('.board').screenshot({ path: out });
console.log('wrote', out, JSON.stringify([...await page.evaluate(() => [...document.fonts].map((f) => f.family + ':' + f.status))]));
await browser.close();
