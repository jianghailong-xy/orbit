// node capture/render.mjs <dir> — shoots each .board[data-png] of <dir>/board.html to <dir>/<data-png>.png at 2x.
import { chromium } from '/root/tmp-34pb25/s3/node_modules/playwright/index.mjs';
const dir = process.argv[2];
const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell' });
const page = await browser.newPage({ viewport: { width: 1900, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`file://${dir}/board.html`);
await page.evaluate(() => document.fonts.ready);
for (const part of await page.locator('.board[data-png]').all()) {
  const name = await part.getAttribute('data-png');
  await part.screenshot({ path: `${dir}/${name}.png` });
  const box = await part.boundingBox();
  console.log(name, Math.round(box.width), 'x', Math.round(box.height));
}
console.log('errors', errors);
await browser.close();
