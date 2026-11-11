// unshare -n ./run-ns.sh capture.mjs [scene ...] → shots/<name>.png
import { launch, open, coordinatorEvents, settle } from '/var/tmp/coord-fold-mock/lib.mjs';
const OUT = process.env.SHOTS_OUT ?? '/var/tmp/coord-fold-mock/shots';
async function clipOf(page, maxH) {
  return page.evaluate((maxH) => {
    const nodes = [...document.querySelectorAll('.chat-user-wrap, [data-seq]')];
    const first = nodes[0].getBoundingClientRect();
    let bottom = 0, left = 1e9, right = 0;
    for (const n of nodes) { const r = n.getBoundingClientRect(); if (r.height) { bottom = Math.max(bottom, r.bottom); left = Math.min(left, r.left); right = Math.max(right, r.right); } }
    const x = Math.max(0, Math.round(left - 24));
    const h = Math.round(bottom - first.top + 40);
    return { x, y: Math.max(0, Math.round(first.top - 16)), width: Math.min(window.innerWidth - x, Math.round(right - left + 48)), height: maxH ? Math.min(h, maxH) : h };
  }, maxH);
}
async function shot(browser, name, tree, { treeShut = false, mode = 'group', click = [], theme = 'light', size = 'desktop', maxH } = {}) {
  const { page, context, errors } = await open(browser, { tree, mode, treeShut, theme, size, events: coordinatorEvents() });
  for (const sel of click) { await page.locator(sel.css).nth(sel.n ?? 0).click(); await page.waitForTimeout(150); }
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400); await settle(page);
  const clip = await clipOf(page, maxH);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(name, JSON.stringify(clip), errors.length ? errors.slice(0, 3) : 'ok');
  await context.close();
}
const G = { css: '.orbit-exchanges-line', n: 0 };
const scenes = {
  'T-open': (b) => shot(b, 'T-open', 'new', { mode: 'tree', click: [G] }),
  'T-shut': (b) => shot(b, 'T-shut', 'new', { mode: 'tree', treeShut: true, click: [G] }),
  'T-leaf': (b) => shot(b, 'T-leaf', 'new', { mode: 'tree', click: [G, { css: '.orbit-branch-body .orbit-exchange-line', n: 0 }] }),
  'T-phone': (b) => shot(b, 'T-phone', 'new', { mode: 'tree', size: 'phone', click: [G] }),
  today: (b) => shot(b, 'today', 'today'),
  'A-group': (b) => shot(b, 'A-group', 'new'),
  'A-group-open': (b) => shot(b, 'A-group-open', 'new', { click: [{ css: '.orbit-exchanges-line', n: 0 }] }),
  'A-row-open': (b) => shot(b, 'A-row-open', 'new', { click: [{ css: '.orbit-exchanges-line', n: 0 }, { css: '.orbit-exchange-line', n: 0 }] }),
  'B-rows': (b) => shot(b, 'B-rows', 'new', { mode: 'rows' }),
  'A-phone': (b) => shot(b, 'A-phone', 'new', { size: 'phone', click: [{ css: '.orbit-exchanges-line', n: 0 }] }),
  'A-dark': (b) => shot(b, 'A-dark', 'new', { theme: 'dark' }),
};
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
const browser = await launch();
try { for (const n of want) await scenes[n](browser); } finally { await browser.close(); }
