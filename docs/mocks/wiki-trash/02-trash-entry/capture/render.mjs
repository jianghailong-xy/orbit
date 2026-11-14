// Renders each section.b-part of a board to <prefix>-N.png.
//   FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf node render.mjs <abs board.html> <abs prefix>
const { chromium } = await import('/var/tmp/wtrash/proto/node_modules/playwright-core/index.mjs');
const [file, prefix] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + file);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
const parts = await page.$$('section.b-part');
for (let i = 0; i < parts.length; i++) await parts[i].screenshot({ path: `${prefix}-${i + 1}.png` });
await browser.close();
console.log(parts.length);
