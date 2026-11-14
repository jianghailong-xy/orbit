// node render-02.mjs <html> <outPrefix> — one PNG per section.b-part at 2x (a 1500×1200 viewport: element shots scroll, which keeps memory low).
// Fonts: FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf (Inter + Noto Sans SC + JetBrains Mono).
import { chromium } from '/mnt/data/tmp/wyo-mock/playwright-core/index.mjs';
const [html, prefix, selector = 'section.b-part'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.setDefaultTimeout(180000);
await page.goto('file://' + html, { timeout: 180000 });
await page.evaluate(() => document.fonts.ready);
await page.evaluate(() => Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
await page.waitForTimeout(400);
const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src));
let i = 0;
for (const part of await page.locator(selector).all()) { i += 1; await part.screenshot({ path: `${prefix}-${i}.png`, timeout: 180000, animations: "disabled" }); }
console.log('parts', i, 'width', size.w, 'errors', JSON.stringify(errors), 'broken', JSON.stringify(broken));
await browser.close();
