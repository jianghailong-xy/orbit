// node render.mjs <dir>  — shoots each .board[data-png] of <dir>/board.html to <dir>/<data-png>.png at 2x.
import { chromium } from '/var/tmp/landings-chat-mock/today/node_modules/playwright/index.mjs';
const dir = process.argv[2];
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--allow-file-access-from-files'],
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/landings-chat-mock/fonts.conf' },
});
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('requestfailed', (r) => errors.push('failed ' + r.url()));
await page.goto(`file://${dir}/board.html`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
await page.evaluate(() => window.drawMarks && window.drawMarks());
await page.waitForTimeout(100);
for (const part of await page.locator('.board[data-png]').all()) {
  const name = await part.getAttribute('data-png');
  await part.screenshot({ path: `${dir}/${name}.png` });
  const box = await part.boundingBox();
  console.log(name, Math.round(box.width), 'x', Math.round(box.height));
}
console.log('errors', errors);
await browser.close();
