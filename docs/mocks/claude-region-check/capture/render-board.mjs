// Renders each <section class="part"> of a board HTML to its own PNG.
//   node render-board.mjs <board.html> <outdir> [scale=2] [name-prefix]
// Fonts: the kit's Inter / Noto Sans SC / JetBrains Mono via fonts.conf (FONTCONFIG_FILE).
import { chromium } from '/var/tmp/region-gate-mock/today/node_modules/playwright/index.mjs';
import path from 'node:path';

const [html, out, scaleArg] = process.argv.slice(2);
const scale = Number(scaleArg ?? 2);
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--allow-file-access-from-files'],
  env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/region-gate-mock/fonts.conf' },
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: scale });
await page.goto('file://' + path.resolve(html));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
const parts = await page.$$('section.b-part');
for (const part of parts) {
  const id = await part.getAttribute('id');
  const file = path.join(out, `${id}.png`);
  await part.screenshot({ path: file });
  console.log(file);
}
await browser.close();
