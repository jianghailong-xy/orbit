// A standalone page shaped like the tasks page -- side nav | main column | page column (flex, column) holding a header
// (a title and the toolbar) and a scrolling list, with the app's 8px ::-webkit-scrollbar -- as a matrix of structures
// and candidate fixes. Each runs on a narrow main column (the bulk bar's buttons overflow it: it gains its 8px
// scrollbar) and a wide one (no overflow), three times in fresh pages: the toolbar's filters are swapped for the bulk
// bar, then the geometry is read after two frames and again after 600 ms. Nothing in between reads layout, so the only
// layouts are the browser's own and whatever a JS fix itself forces. Prints one line per variant: tb = toolbar height,
// bar = bulk bar border box, sb = the bar's own scrollbar, ovf = the bar overflows, heads = the list heads' top,
// errors = error events (a ResizeObserver loop with undelivered notifications).
// usage (from a tree's src/web, which has @playwright/test): node min2.mjs <webkit|chromium> [variant ...]
import { webkit, chromium } from '@playwright/test';

const browserType = process.argv[2] === 'chromium' ? chromium : webkit;
const only = process.argv.slice(3);
const base = { shell: 'flex', view: 'flex', toolbar: 'flex', css: '', js: '' };
const VARIANTS = {
  // structures
  'app': {},
  'no-flex-ancestor': { shell: 'block', view: 'block' },
  'flex-shell-only': { view: 'block' },
  'flex-view-only': { shell: 'block' },
  'no-flex-at-all': { shell: 'block', view: 'block', toolbar: 'block' },
  'block-toolbar': { toolbar: 'block' },
  'grid-toolbar': { toolbar: 'grid' },
  'header-flex-column': { css: '.header { display: flex; flex-direction: column; }' },
  'header-grid': { css: '.header { display: grid; grid-template-columns: minmax(0, 1fr); }' },
  'view-grid': { css: '.view { display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); }' },
  'view-grid-block-shell': { shell: 'block', css: '.view { display: grid; grid-template-rows: auto minmax(0, 1fr); grid-template-columns: minmax(0, 1fr); }' },
  'contain-layout-header': { css: '.header { contain: layout; }' },
  'toolbar-is-scroller': { css: '.toolbar { flex-wrap: nowrap; overflow-x: auto; } .bar { overflow: visible; max-width: none; }' },
  'inner-scroller': { inner: true, css: '.bar { overflow: visible; display: block; padding: 0; } .bar-scroll { display: flex; align-items: center; gap: 8px; overflow-x: auto; padding: 4px 10px; } .bar-scroll > * { flex: none; white-space: nowrap; }' },
  // CSS-only candidates
  'reserve-min-height': { css: '.toolbar:has(> .bar) { min-height: 42px; }' },
  'overflow-scroll': { css: '.bar { overflow-x: scroll; }' },
  'fixed-34': { css: '.toolbar:has(> .bar) { height: 34px; }' },
  'hidden-scrollbar': { css: '.bar { scrollbar-width: none; } .bar::-webkit-scrollbar { display: none; }' },
  // JS candidates: in the task that inserts the bar (a React layout effect's place), force the layout -- which makes
  // WebKit settle the bar's scrollbar -- then give the toolbar the bar's height; or the same from a ResizeObserver on the
  // bar, deferred to the next frame or done inside the callback, with and without a second observer on the list body
  // as the page has (TaskListView's viewport).
  'js-commit': { js: 'commit' },
  'js-ro-raf': { js: 'ro-raf' },
  'js-ro-sync+body-ro': { js: 'ro-sync', bodyObserver: true },
  'js-ro-raf+body-ro': { js: 'ro-raf', bodyObserver: true },
};

const page = (v) => `<!doctype html><html><head><style>
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 4px; }
  body { margin: 0; font: 14px sans-serif; }
  .shell { display: ${v.shell}; height: 100vh; }
  .nav { width: 200px; flex: none; }
  .main { flex: none; min-width: 0; width: var(--main-width); height: 100vh; overflow: hidden; }
  .view { display: ${v.view}; flex-direction: column; overflow: hidden; height: 100%; padding: 24px 32px; }
  .header { flex: none; }
  .toolbar { display: ${v.toolbar}; align-items: center; flex-wrap: wrap; gap: 12px; margin: 16px 0 8px; }
  .body { flex: 1; min-height: 0; overflow-y: auto; }
  .bar { display: flex; align-items: center; gap: 8px; max-width: 100%; overflow-x: auto; padding: 4px 10px; border: 1px solid #99c; border-radius: 8px; }
  .bar > * { flex: none; white-space: nowrap; }
  .btn { height: 24px; padding: 0 7px; border: 1px solid #ccc; border-radius: 4px; background: #fff; font: inherit; }
  .filter { height: 32px; width: 120px; border: 1px solid #ccc; }
  ${v.css}
</style></head><body><div class="shell"><div class="nav">nav</div><div class="main"><div class="view">
  <div class="header"><h1 style="margin:0;font-size:20px">Tasks</h1><div class="toolbar"><div class="filter"></div><div class="filter"></div></div></div>
  <div class="body"><div class="heads" style="height:38px;background:#eee">heads</div>${'<div style="height:40px">row</div>'.repeat(30)}</div>
</div></div></div>
<script>
  const buttons = '<span>1 selected</span><button class="btn">Run</button><button class="btn">Stop</button><button class="btn">Set assignee</button><button class="btn">Delete</button><button class="btn">Clear</button>';
  const fit = () => {
    const toolbar = document.querySelector('.toolbar'), bar = document.querySelector('.bar');
    if (bar) toolbar.style.minHeight = bar.getBoundingClientRect().height + 'px';
  };
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push(e.message));
  ${v.bodyObserver ? "new ResizeObserver(() => { window.__bodyResizes = (window.__bodyResizes || 0) + 1; }).observe(document.querySelector('.body'));" : ''}
  window.swap = () => {
    const toolbar = document.querySelector('.toolbar');
    toolbar.innerHTML = ${v.inner ? `'<div class="bar"><div class="bar-scroll">' + buttons + '</div></div>'` : `'<div class="bar">' + buttons + '</div>'`};
    ${v.js === 'commit' ? 'fit();' : ''}
    ${v.js === 'ro-raf' ? "new ResizeObserver(() => requestAnimationFrame(fit)).observe(document.querySelector('.bar'), { box: 'border-box' });" : ''}
    ${v.js === 'ro-sync' ? "new ResizeObserver(fit).observe(document.querySelector('.bar'), { box: 'border-box' });" : ''}
  };
  window.measure = () => {
    const toolbar = document.querySelector('.toolbar'), bar = document.querySelector('.bar'), heads = document.querySelector('.heads');
    const scroller = document.querySelector('.bar-scroll') || (getComputedStyle(toolbar).overflowX === 'auto' ? toolbar : bar);
    return { toolbar: toolbar.getBoundingClientRect().height, bar: bar.getBoundingClientRect().height,
      scrollbar: scroller.offsetHeight - scroller.clientHeight - (parseFloat(getComputedStyle(scroller).borderTopWidth) + parseFloat(getComputedStyle(scroller).borderBottomWidth)),
      overflow: scroller.scrollWidth > scroller.clientWidth, headsTop: heads.getBoundingClientRect().top, errors: window.__errors.length };
  };
</script></body></html>`;

const browser = await browserType.launch();
console.log(`${browserType.name()} ${browser.version()}`);
const fmt = (m) => `tb ${m.toolbar} bar ${m.bar} sb ${m.scrollbar}${m.overflow ? ' ovf' : ''} heads ${m.headsTop}${m.errors ? ` errors ${m.errors}` : ''}`;
for (const name of only.length ? only : Object.keys(VARIANTS)) {
  const variant = { ...base, ...VARIANTS[name] };
  const line = [];
  for (const width of [420, 1000]) {
    const seen = new Set();
    for (let i = 0; i < 3; i += 1) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const p = await context.newPage();
      await p.setContent(page(variant).replace('var(--main-width)', `${width}px`));
      await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await p.evaluate(() => window.swap());
      const twoFrames = await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.measure())))));
      await p.waitForTimeout(600);
      const later = await p.evaluate(() => window.measure());
      seen.add(`${fmt(twoFrames)}${JSON.stringify(later) === JSON.stringify(twoFrames) ? '' : ` -> later ${fmt(later)}`}`);
      await context.close();
    }
    line.push(`${width === 420 ? 'narrow' : 'wide'}: ${[...seen].join(' | ')}`);
  }
  console.log(`${name.padEnd(22)} ${line.join('   ')}`);
}
await browser.close();
