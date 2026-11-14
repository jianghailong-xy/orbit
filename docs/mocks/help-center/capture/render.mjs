// Renders a board HTML to a PNG of its full height: node render.mjs <board.html> <out.png>
import { chromium } from '/mnt/data/tmp/machines-add-mock/today/node_modules/playwright/index.mjs';
const [file, out] = process.argv.slice(2);
const b = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', timeout: 180000,
  env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/machines-add-mock/fonts.conf' },
});
const p = await b.newPage({ deviceScaleFactor: 1.5, viewport: { width: 1760, height: 1000 } });
await p.goto('file://' + file); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(500);
await p.locator('.board').screenshot({ path: out, timeout: 120000 });
await b.close();
