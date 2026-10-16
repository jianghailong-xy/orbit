// Renders the board. Run from this directory:
//   node render.mjs
// The board links the product's own stylesheet (../../../src/web/src/index.css) and draws the rows with
// the product's own class names, so what it shows is the app's real geometry.
import { chromium } from '/root/wikova/node_modules/playwright-core/index.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'out');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 2200, height: 1400 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(path.join(here, 'board.html')).href);
await page.waitForTimeout(400);

const shots = [
  ['board', null],
  ['1-now', '#pane-now'],
  ['2-option-a', '#pane-inline'],
  ['3-option-b', '#pane-caret'],
  ['5-grammar', '#pane-grammar'],
  ['4-phone-a', '#pane-phone'],
  ['4-phone-b', '#pane-phone-caret'],
];
for (const [name, sel] of shots) {
  await (sel ? page.locator(sel) : page.locator('#board')).screenshot({ path: path.join(out, `${name}.png`) });
  console.log('wrote', name);
}
console.log('caret columns:', await page.locator('#grammar').getAttribute('data-caret-x'));
await browser.close();
