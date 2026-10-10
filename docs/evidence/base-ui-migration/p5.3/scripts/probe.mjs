// probe.mjs SCENARIO: drive one tree's build (PORT) to a state with the P0 + P5.3 fixtures, then dump the boxes and the
// computed styles of what SELECTORS (a JSON list, env) match. For finding where the replaced and the Orbit controls part.
const WT = '/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833';
const { chromium, webkit } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP53Fixtures, P53_PATHS } = await import(`${WT}/src/web/ui-migration/p53-fixtures.mjs`);
const port = process.env.PORT || 4373;
const browserName = process.env.BROWSER || 'chromium';
const theme = process.env.THEME || 'light';
const phone = process.env.SIZE === 'phone';
const scenario = (await import(process.argv[2])).default;
const selectors = JSON.parse(process.env.SELECTORS || '[]');
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: theme,
  viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await installFixedDate(page);
await installFixtures(page, { theme });
const fixtures = await installP53Fixtures(page);
await page.goto(P53_PATHS.session);
await page.waitForSelector('.composer-field textarea');
await page.waitForTimeout(800);
await scenario(page, { phone, fixtures });
await page.waitForTimeout(600);
const dump = await page.evaluate((selectors) => {
  const props = ['display', 'position', 'width', 'height', 'minWidth', 'maxWidth', 'padding', 'margin', 'borderRadius', 'border', 'borderBottom', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'lineHeight', 'gap', 'cursor', 'boxShadow', 'zIndex', 'outline', 'opacity', 'whiteSpace'];
  return selectors.map((selector) => ({ selector, matches: [...document.querySelectorAll(selector)].filter((el) => el.getBoundingClientRect().width > 0).slice(0, 14).map((el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return { cls: String(el.className).replace(/css-var-\S+|css-dev-only\S+/g, '').trim().slice(0, 90), role: el.getAttribute('role'), text: (el.textContent || '').trim().slice(0, 40),
      rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100), ...Object.fromEntries(props.map((p) => [p, s[p]])) };
  }) }));
}, selectors);
for (const { selector, matches } of dump) { console.log('== ' + selector); for (const m of matches) console.log(JSON.stringify(m)); }
console.log('active', await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160)));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();
