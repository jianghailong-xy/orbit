// node render.mjs <html> <outPrefix> [selector]
import { chromium } from '/mnt/data/tmp/wyo-mock/playwright-core/index.mjs';
const [html, prefix, selector = 'section.b-part'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/mnt/data/ms-playwright/chromium-1243/chrome-linux64/chrome', env: { ...process.env, FONTCONFIG_FILE: '/mnt/data/tmp/d-fonts/fonts.conf' } });
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('file://' + html);
await page.evaluate(() => document.fonts.ready);
const size = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
await page.setViewportSize({ width: Math.max(1500, size.w), height: size.h });
await page.waitForTimeout(300);
await page.evaluate(() => window.drawMarks?.());
let i = 0;
for (const part of await page.locator(selector).all()) { i += 1; await part.screenshot({ path: `${prefix}-${i}.png` }); }
console.log('parts', i, 'errors', JSON.stringify(errors));
await browser.close();
