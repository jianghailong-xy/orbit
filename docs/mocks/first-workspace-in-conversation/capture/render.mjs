// node render.mjs <board.html> [out.png] [scale]  — shoots .board at the given device scale (default 2).
import { chromium } from '/var/tmp/first-ws-mock/today/node_modules/playwright/index.mjs';
const [src, out = src.replace(/\.html$/, '.png'), scale = '2'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/first-ws-mock/fonts.conf' },
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: Number(scale) });
await page.goto('file://' + src);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.locator('.board').screenshot({ path: out });
const size = await page.locator('.board').boundingBox();
console.log(out, Math.round(size.width), 'x', Math.round(size.height));
await browser.close();
