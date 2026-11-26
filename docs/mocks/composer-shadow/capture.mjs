// Shoots the real session page's composer three ways (today, flat, small shadow) in light and dark,
// idle and focused. Run through ns.sh (vite preview of this tree's build on :4199).
const WT = new URL('../../..', import.meta.url).pathname;
const WEB = `${WT}src/web`;
const { chromium } = await import(`${WT}node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate, PATHS } = await import(`${WEB}/ui-migration/fixtures.mjs`);
import { readFileSync, writeFileSync } from 'node:fs';
const out = process.argv[2];
const FONTS = '/mnt/tmp/band-glass-mock/fonts/';
const variants = {
  today: '',
  flat: '.composer-box,.composer-box:focus-within,.composer-box:has(.composer-attach-btn[data-popup-open],.composer-model-chip[data-popup-open],.orbit-select[data-open]){box-shadow:none!important}',
  small: '.composer-box{box-shadow:0 1px 3px rgba(31,35,41,.06)!important}.composer-box:focus-within{box-shadow:0 2px 6px rgba(31,35,41,.08)!important}',
};
const browser = await chromium.launch();
const meta = {};
for (const theme of ['light', 'dark']) for (const [name, css] of Object.entries(variants)) for (const focus of [false, true]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 820 }, deviceScaleFactor: 2, baseURL: 'http://localhost:4199', locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  await installFixedDate(page); await installFixtures(page, { theme });
  await page.route('**/__mockfonts/**', (r) => r.fulfill({ body: readFileSync(FONTS + r.request().url().split('/').pop()), contentType: 'font/ttf' }));
  await page.goto(PATHS.session);
  await page.addStyleTag({ content: '@font-face{font-family:BlinkMacSystemFont;src:url(/__mockfonts/Inter.ttf);font-weight:100 900}' + css });
  await page.waitForSelector('.composer-box', { timeout: 45000 });
  if (focus) await page.click('.composer-box textarea');
  else await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(1200); await page.evaluate(() => document.fonts.ready);
  const b = await page.locator('.composer-box').boundingBox();
  const clip = { x: Math.max(0, b.x - 40), y: b.y - 70, width: b.width + 80, height: Math.min(820 - (b.y - 70), b.height + 130) };
  const key = `${theme}-${name}-${focus ? 'focus' : 'idle'}`;
  meta[key] = { box: b, clip, shadow: await page.evaluate(() => getComputedStyle(document.querySelector('.composer-box')).boxShadow) };
  await page.screenshot({ path: `${out}/${key}.png`, clip });
  console.log(key, JSON.stringify(meta[key]));
  await ctx.close();
}
writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 1));
await browser.close();
