const WEB = '/root/.orbit/worktrees/01a210f8-5eb8-74b2-813e-7544d211ca50/src/web';
const { chromium } = await import(`${WEB}/../../node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate, PATHS } = await import(`${WEB}/ui-migration/fixtures.mjs`);
import { readFileSync } from 'node:fs';
const out = process.argv[2];
const browser = await chromium.launch();
const ic=(box,g,ml)=>`.workspace-header .workspace-header-more,.workspace-header .workspace-header-share{width:${box}px!important;height:${box}px!important;font-size:${g}px!important}.workspace-header .workspace-header-more + .workspace-header-share{margin-left:${ml}px!important}`;
const variants = { i16: '', i18: ic(30,18,-8), i20: ic(32,20,-8) };
for (const [name, css] of Object.entries(variants)) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 760 }, deviceScaleFactor: 2, baseURL: 'http://localhost:4199', locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  await installFixedDate(page); await installFixtures(page, { theme: 'light' });
  await page.route('**/__mockfonts/**', (r) => r.fulfill({ body: readFileSync('/mnt/tmp/band-glass-mock/fonts/' + r.request().url().split('/').pop()), contentType: 'font/ttf' }));
  page.on('requestfailed', r => console.log('FAILED', r.url(), r.failure()?.errorText)); await page.goto(PATHS.session);
  await page.addStyleTag({ content: "@font-face{font-family:BlinkMacSystemFont;src:url(/__mockfonts/Inter.ttf);font-weight:100 900}" + css });
  try { await page.waitForSelector('.workspace-name', { timeout: 45000 }); } catch { await page.screenshot({ path: out + '/dbg.png' }); throw new Error('no title ' + page.url()); }
  await page.waitForTimeout(1500); await page.evaluate(() => document.fonts.ready);
  const m = await page.evaluate(() => { const t = document.querySelector('.workspace-name'); const b = document.querySelector('.workspace-sessions p, .msg-text, .md p'); return { title: getComputedStyle(t).fontSize, body: b ? getComputedStyle(b).fontSize : null }; });
  console.log(name, JSON.stringify(m));
  const box = await page.locator('.workspace-main, .workspace-pane, .workspace-conversation').first().boundingBox().catch(() => null);
  await page.screenshot({ path: `${out}/icon-${name}.png`, clip: { x: 560, y: 0, width: 880, height: 120 } });
  await ctx.close();
}
await browser.close();
