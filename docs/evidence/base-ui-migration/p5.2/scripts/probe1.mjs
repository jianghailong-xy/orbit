// Probe the reference (AntD) transcript images and preview: DOM and computed styles.
const WT = '/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d';
const { chromium, webkit } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP52Fixtures, installObjectUrlLog, P52_PATHS } = await import(`${WT}/src/web/ui-migration/p52-fixtures.mjs`);
const port = process.env.PORT || 4352;
const browserName = process.env.BROWSER || 'chromium';
const theme = process.env.THEME || 'light';
const phone = process.env.SIZE === 'phone';
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme,
  viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await installFixedDate(page);
const api = await installFixtures(page, { theme });
await installObjectUrlLog(page);
const p52 = await installP52Fixtures(page);
await page.goto(P52_PATHS.session);
await page.waitForSelector('.chat-assistant');
await page.waitForTimeout(1500);
const dump = await page.evaluate(() => {
  const pick = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { tag: el.tagName, cls: el.className, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), aria: el.getAttribute('aria-label'), rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100), display: s.display, position: s.position, width: s.width, height: s.height, maxW: s.maxWidth, maxH: s.maxHeight, objectFit: s.objectFit, radius: s.borderRadius, overflow: s.overflow, cursor: s.cursor, margin: s.margin, va: s.verticalAlign, outline: s.outline, transition: s.transition, bg: s.backgroundColor, color: s.color, opacity: s.opacity }; };
  const out = {};
  out.images = [...document.querySelectorAll('img')].map((img) => ({ img: pick(img), parent: pick(img.parentElement), grand: pick(img.parentElement.parentElement), src: img.src.slice(0, 40) }));
  out.covers = [...document.querySelectorAll('[class*="image-cover"], .chat-image-mask')].map((el) => ({ ...pick(el), html: el.outerHTML.slice(0, 300) }));
  out.loading = [...document.querySelectorAll('.chat-image-loading, .md-image-loading, .chat-result-image-loading, .md-image-unavailable, .chat-file')].map((el) => ({ ...pick(el), html: el.outerHTML.slice(0, 200) }));
  out.wrapHtml = [...document.querySelectorAll('.ant-image')].map((el) => el.outerHTML.replace(/src="[^"]+"/g, 'src=…').slice(0, 500));
  return out;
});
for (const [k, v] of Object.entries(dump)) { console.log('== ' + k); for (const row of v) console.log(JSON.stringify(row)); }
console.log('requests', JSON.stringify(p52.requests));
console.log('objectUrls', JSON.stringify(await page.evaluate(() => window.__p52ObjectUrls)));
await browser.close();
