// node render.cjs <out-dir> <board.html> [...] — screenshots each .board at 2x into <out-dir>/<name>.png
const { chromium } = require('/var/tmp/landing-mock-render/node_modules/playwright-core');
const path = require('path');
(async () => {
  const [outDir, ...files] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  for (const file of files) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('file://' + path.resolve(file), { waitUntil: 'load' });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
    await page.waitForTimeout(200);
    const out = path.join(outDir, path.basename(file).replace(/\.html$/, '.png'));
    await page.locator('.board').screenshot({ path: out });
    const box = await page.locator('.board').boundingBox();
    console.log(`wrote ${out} (${Math.round(box.width)}x${Math.round(box.height)} css px)`);
    for (const e of errors) console.log('  page error: ' + e);
    await page.close();
  }
  await browser.close();
})();
