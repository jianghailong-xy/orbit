// Cuts each phone frame (and the runner-row cut-outs and the Plan usage sheet) out of the iOS design board
// docs/mocks/kimi-accounts/02-ios.html at 2x, for the evidence's side-by-side comparison.
// node frames.cjs <abs board html> <out dir>
const path = require('path');
const fs = require('fs');
const KIT = '/var/tmp/kimi-accounts-ios';
const { chromium } = require(path.join(KIT, 'node_modules/playwright'));
const FONTS = path.join(KIT, 'fonts');
(async () => {
  const [html, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2000, height: 1200 } });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto('file://' + html);
  await page.addStyleTag({ content: `
    @font-face { font-family: "Inter"; src: url("file://${FONTS}/Inter.ttf"); font-weight: 100 900; }
    @font-face { font-family: "Noto Sans SC"; src: url("file://${FONTS}/NotoSansSC.ttf"); font-weight: 100 900; }
    @font-face { font-family: "Noto Sans CJK SC"; src: url("file://${FONTS}/NotoSansSC.ttf"); font-weight: 100 900; }
    @font-face { font-family: "PingFang SC"; src: url("file://${FONTS}/NotoSansSC.ttf"); font-weight: 100 900; }
    @font-face { font-family: BlinkMacSystemFont; src: url("file://${FONTS}/Inter.ttf"); font-weight: 100 900;
      unicode-range: U+0000-02FF, U+2000-206F, U+2190-21FF, U+2026, U+20AC, U+2122; }
    @font-face { font-family: "JetBrains Mono"; src: url("file://${FONTS}/JetBrainsMono.ttf"); font-weight: 100 900; }
    @font-face { font-family: SFMono-Regular; src: url("file://${FONTS}/JetBrainsMono.ttf"); font-weight: 100 900; }
    body { width: max-content; }` });
  await page.evaluate(async () => {
    await Promise.all([document.fonts.load('600 15px Inter'), document.fonts.load('600 15px "Noto Sans SC"', '中文'),
      document.fonts.load('600 20px "JetBrains Mono"')]);
    await document.fonts.ready;
    if (typeof window.drawMarks === 'function') window.drawMarks();
  });
  await page.waitForTimeout(400);
  const phones = await page.$$('.ph');
  for (let i = 0; i < phones.length; i++) {
    const file = path.join(out, `design-p${String(i + 1).padStart(2, '0')}.png`);
    await phones[i].screenshot({ path: file });
    const box = await phones[i].boundingBox();
    console.log('wrote', file, Math.round(box.width), 'x', Math.round(box.height));
  }
  const cuts = await page.$$('#cuts > *');
  for (let i = 0; i < cuts.length; i++) {
    const file = path.join(out, `design-cut-${'abc'[i] || i}.png`);
    await cuts[i].screenshot({ path: file });
    console.log('wrote', file);
  }
  const sheet = await page.$('#sheet');
  if (sheet) {
    await sheet.screenshot({ path: path.join(out, 'design-plan-usage.png') });
    console.log('wrote design-plan-usage.png');
  }
  await browser.close();
})();
