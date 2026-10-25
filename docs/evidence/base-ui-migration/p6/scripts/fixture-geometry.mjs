// fixture-geometry.mjs OUT.json: the controls fixture's "Interactive controls" section on one tree's dev server (PORT), in
// one environment (BROWSER chromium|webkit, THEME light|dark, SIZE desktop|phone, as the P0 projects): the section's box
// on the page, unrounded, and every element inside it with its box relative to the section's (animations held at their
// start). Two trees' files say
// whether the section is laid out alike inside and only sits elsewhere on the page. geometry-pair.sh runs it.
const TREE = process.env.TREE;
const { chromium, webkit } = await import(`${TREE}/node_modules/playwright-core/index.mjs`);
const { writeFileSync } = await import('node:fs');
const phone = process.env.SIZE === 'phone';
const browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch();
const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PORT}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1,
  colorScheme: process.env.THEME, viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: phone, hasTouch: phone });
const page = await context.newPage();
await page.goto('/ui-migration/controls.html');
await page.getByTestId('theme').waitFor();
await page.evaluate(() => document.fonts.ready);
const record = await page.evaluate(() => {
  // A loading switch's spinner turns; every animation is held at its start so a box is the element's, not its angle.
  for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = 0; }
  const region = document.querySelector('section[aria-label="Interactive controls"]');
  const r = region.getBoundingClientRect();
  const label = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
  return { page: { scrollHeight: document.documentElement.scrollHeight }, section: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height },
    elements: [...region.querySelectorAll('*')].map((el) => { const b = el.getBoundingClientRect(); return [label(el), b.x - r.x, b.y - r.y, b.width, b.height]; }) };
});
writeFileSync(process.argv[2], JSON.stringify(record));
await browser.close();
