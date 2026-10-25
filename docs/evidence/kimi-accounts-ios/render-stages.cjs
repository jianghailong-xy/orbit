// Renders the evidence comparison board (file://) into one PNG per stage — compare-1.png … — at 1x (an
// overview: the screens themselves are beside it at 2x), the first with the board's title and note above
// it: one long board is unreadable on a phone. squeeze.py then keeps each to a 256-colour palette.
// node render-stages.cjs <abs compare.html> <out dir>
const path = require('path');
const { chromium } = require('/var/tmp/kimi-accounts-ios/node_modules/playwright');
const FONTS = '/var/tmp/kimi-accounts-ios/fonts';
(async () => {
  const [html, out] = process.argv.slice(2);
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1900, height: 1200 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  await page.goto('file://' + html);
  await page.addStyleTag({ content: `
    @font-face { font-family: "Inter"; src: url("file://${FONTS}/Inter.ttf"); font-weight: 100 900; }
    @font-face { font-family: "Noto Sans SC"; src: url("file://${FONTS}/NotoSansSC.ttf"); font-weight: 100 900; }
    @font-face { font-family: "Noto Sans CJK SC"; src: url("file://${FONTS}/NotoSansSC.ttf"); font-weight: 100 900; }
    @font-face { font-family: "PingFang SC"; src: url("file://${FONTS}/NotoSansSC.ttf"); font-weight: 100 900; }
    @font-face { font-family: "JetBrains Mono"; src: url("file://${FONTS}/JetBrainsMono.ttf"); font-weight: 100 900; }
    body { width: max-content; }` });
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('600 15px Inter'), document.fonts.load('600 15px "Noto Sans SC"', '中文')]);
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => img.decode().catch(() => null)));
  });
  const missing = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')));
  if (missing.length) console.log('missing images:', missing.join(', '));
  const stages = await page.$$('.m-stage');
  const head = await page.$('.m-sheet');
  const sheetBox = await head.boundingBox();
  for (let i = 0; i < stages.length; i++) {
    const box = await stages[i].boundingBox();
    // The first stage takes the title and note above it along.
    const top = i === 0 ? sheetBox.y : box.y - 14;
    const clip = { x: sheetBox.x, y: top, width: sheetBox.width, height: box.y + box.height + 14 - top };
    const file = path.join(out, `compare-${i + 1}.png`);
    await page.screenshot({ path: file, clip, fullPage: true });
    console.log('wrote', file, Math.round(clip.width), 'x', Math.round(clip.height));
  }
  await browser.close();
})();
