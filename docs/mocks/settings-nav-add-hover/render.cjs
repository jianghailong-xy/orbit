// node docs/mocks/settings-nav-add-hover/render.cjs  → 01-board.png at 2x, pointer on the wikova row of panel 3.
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules/playwright'));
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, '01-board.html'));
  await page.evaluate(() => document.fonts.ready);
  const target = page.locator('#p3 .settings-nav-row', { hasText: 'wikova' });
  const box = await target.boundingBox();
  const x = box.x + 120, y = box.y + box.height / 2;
  await page.evaluate(({ x, y }) => {
    const frame = document.querySelector('#p3 .frame').getBoundingClientRect();
    const c = document.createElement('div');
    c.className = 'cursor';
    c.style.left = x - frame.left + 'px';
    c.style.top = y - frame.top + 'px';
    c.innerHTML = '<svg viewBox="0 0 16 24" width="16" height="24"><path d="M1 1 L1 19 L5.5 14.5 L8.5 22 L11 21 L8 13.5 L14 13.5 Z" fill="#000" stroke="#fff" stroke-width="1.2"/></svg>';
    document.querySelector('#p3 .frame').appendChild(c);
  }, { x, y });
  await page.mouse.move(x, y);
  await page.screenshot({ path: path.join(__dirname, '01-board.png'), fullPage: true });
  await browser.close();
})();
