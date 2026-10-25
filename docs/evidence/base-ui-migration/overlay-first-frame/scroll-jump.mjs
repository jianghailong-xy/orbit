// Does opening a popup scroll its owner? For each case the owner's viewport (the dialog's or drawer's scrolling
// viewport, else the page) is logged on every scroll event from the opening input until 900ms after, with the
// popup's settled box and its anchor's. Run against a dev server of each tree (reference and fix).
// usage: node scroll-jump.mjs <out.json> <browser> <desktop|phone> <label>=<port> ... -- <sample>@<query> ...
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(`${process.cwd()}/src/web/package.json`);
const { chromium, webkit } = require('@playwright/test');
const args = process.argv.slice(2);
const [out, browserName, size] = args;
const split = args.indexOf('--');
const trees = args.slice(3, split).map((entry) => entry.split('='));
const cases = args.slice(split + 1);
const browser = await (browserName === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ viewport: size === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  isMobile: size === 'phone', hasTouch: size === 'phone', deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
const page = await context.newPage();
const results = [];
for (const entry of cases) for (const [label, port] of trees) {
  const [sample, query] = entry.split('@');
  await page.goto(`http://127.0.0.1:${port}/ui-migration/choices.html?sample=${sample}&system=orbit${query ? `&${query}` : ''}`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const region = page.getByRole('region', { name: 'Appearance sample' });
  const choice = ['expiry', 'search', 'multiple'].includes(sample);
  const target = choice ? region.getByRole('combobox', { name: 'Sample choice' }) : region.getByRole('button').first();
  await page.evaluate(() => {
    const owner = document.querySelector('.orbit-overlay-viewport') ?? document.scrollingElement;
    const target = owner === document.scrollingElement ? window : owner;
    const log = [];
    const read = (event) => log.push({ t: Math.round(performance.now() - start), event, left: owner.scrollLeft, top: owner.scrollTop, width: owner.scrollWidth });
    let start = performance.now();
    window.scrollJump = { log, reset: () => { start = performance.now(); log.length = 0; read('open'); } };
    target.addEventListener('scroll', () => read('scroll'));
  });
  await page.evaluate(() => window.scrollJump.reset());
  try {
    if (sample === 'attachment') { await target.focus({ timeout: 10_000 }); await page.keyboard.press('ArrowDown'); }
    else if (size === 'phone') await target.tap({ timeout: 10_000 });
    else await target.click({ timeout: 10_000 });
  } catch (error) {
    results.push({ label, size, browser: browserName, sample, query, openFailed: error.message.split('\n')[0] });
    console.log(label, browserName, size, `${sample}@${query}`, 'open failed:', error.message.split('\n')[0]);
    continue;
  }
  await page.waitForTimeout(900);
  const settled = await page.evaluate(() => {
    const surface = [...document.querySelectorAll('.sample-surface')].at(-1);
    const box = surface?.getBoundingClientRect();
    return box && [box.x, box.y, box.width, box.height].map((v) => Math.round(v * 1000) / 1000);
  });
  const anchor = await target.boundingBox();
  const log = await page.evaluate(() => window.scrollJump.log);
  const scrolled = log.filter((row) => row.event === 'scroll');
  results.push({ label, size, browser: browserName, sample, query, scrollEvents: scrolled.length,
    maxScrollLeft: Math.max(0, ...log.map((row) => row.left)), maxScrollTop: Math.max(0, ...log.map((row) => row.top)),
    lastScroll: log.at(-1), settled, anchor: [anchor.x, anchor.y], log: log.slice(0, 80) });
  console.log(label, browserName, size, `${sample}@${query}`, 'scroll events', scrolled.length, 'max left', results.at(-1).maxScrollLeft,
    'last', JSON.stringify(log.at(-1)), 'settled', JSON.stringify(settled));
}
writeFileSync(out, JSON.stringify(results, null, 1));
await browser.close();
