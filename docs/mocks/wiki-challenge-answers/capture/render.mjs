// Render a board HTML (file://) at 2x to a PNG of the whole body. usage: FONTCONFIG_FILE=… node render.mjs <board.html> <out.png>
import path from 'node:path';
import { chromium } from '/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70/node_modules/playwright/index.mjs';
const [html, out] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--font-render-hinting=none', '--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1700, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file://' + path.resolve(html));
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 }).catch(async () => {
  console.log('missing images:', await page.evaluate(() => [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.src)));
});
await page.waitForTimeout(300);
const box = await page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(document.body.scrollHeight) }; });
await page.setViewportSize({ width: box.w, height: box.h });
await page.waitForTimeout(200);
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: box.w, height: box.h } });
console.log('wrote', out, box.w, 'x', box.h, 'css px');
await browser.close();
