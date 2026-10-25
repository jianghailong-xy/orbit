// ro-mechanism-probe.mjs OUT.json: choices.browser.mjs's "multiple labels search, toggle, collapse, remove and clear" case,
// step by step (the steps of p6/scripts/ro-loop-probe.mjs), on one tree's choices fixture (dev server on PORT) in WebKit
// with the phone projects' context options (390x844, touch, reduced motion, service workers blocked), THEME light|dark,
// RUNS times. Unlike the P6 probe it tells the page's ResizeObservers apart: every observer gets a number when it is
// constructed, and the log records, in order, each construction (with the function that constructed it), each
// observe / unobserve / disconnect, each callback (its observer, the entries, the list's side), every animation frame
// and the "ResizeObserver loop" error event, so the error can be put on the observation the browser skipped.
const TREE = process.env.TREE;
const { webkit } = await import(`${TREE}/node_modules/playwright-core/index.mjs`);
const { writeFileSync } = await import('node:fs');
const runs = Number(process.env.RUNS || 3);
const theme = process.env.THEME || 'light';
const browser = await webkit.launch();
const out = { tree: TREE, theme, runs: [] };
for (let run = 0; run < runs; run++) {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PORT}`, locale: 'en-US', timezoneId: 'UTC',
    deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block', colorScheme: theme, viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    const log = (window.__roLog = []);
    let frame = 0;
    const tick = () => { frame++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const push = (entry) => { if (log.length < 1500) log.push({ t: Math.round(performance.now() * 10) / 10, frame, step: window.__step, ...entry }); };
    const describe = (el) => `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
    const depth = (el) => { let d = 0; for (let n = el; n.parentNode; n = n.parentNode) d++; return d; };
    const side = () => document.querySelector('.orbit-choice-positioner')?.getAttribute('data-side') ?? null;
    const Native = window.ResizeObserver;
    let next = 0;
    window.ResizeObserver = class extends Native {
      constructor(callback) {
        const id = ++next;
        super((entries, observer) => {
          push({ kind: 'callback', id, side: side(), entries: entries.map((entry) => [describe(entry.target), depth(entry.target),
            Math.round(entry.contentRect.width * 100) / 100, Math.round(entry.contentRect.height * 100) / 100]) });
          const result = callback(entries, observer);
          push({ kind: 'callback-end', id, side: side() });
          return result;
        });
        this.__id = id;
        const by = (new Error().stack || '').split('\n').slice(1, 4).map((line) => line.split('@')[0] || line.trim()).join(' < ');
        push({ kind: 'new', id, by, side: side() });
      }
      observe(target, options) { push({ kind: 'observe', id: this.__id, target: describe(target), depth: depth(target) }); return super.observe(target, options); }
      unobserve(target) { push({ kind: 'unobserve', id: this.__id, target: describe(target) }); return super.unobserve(target); }
      disconnect() { push({ kind: 'disconnect', id: this.__id }); return super.disconnect(); }
    };
    window.addEventListener('error', (event) => push({ kind: 'error', message: event.message, side: side() }), true);
  });
  const page = await context.newPage();
  const errors = [];
  let step = 'load';
  page.on('pageerror', (error) => errors.push({ step, message: error.message }));
  const at = async (name, action) => { step = name; await page.evaluate((s) => { window.__step = s; }, name).catch(() => {}); await action(); };
  const anchorBox = () => page.evaluate(() => {
    const field = document.querySelector('section[aria-label="Multiple choices"] .orbit-select.orbit-multi');
    const list = document.querySelector('.orbit-choice-positioner');
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
    return { field: box(field), list: box(list), side: list?.getAttribute('data-side') ?? null, viewport: innerHeight, scrollY };
  });
  const boxes = {};
  try {
    await page.goto('/ui-migration/choices.html');
    await page.getByTestId('theme').filter({ hasText: theme }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const region = page.getByRole('region', { name: 'Multiple choices', exact: true });
    const input = region.getByRole('combobox', { name: 'Labels', exact: true });
    const valueIs = (want) => page.waitForFunction((w) => document.querySelector('section[aria-label="Multiple choices"] output[aria-label="Labels value"]')?.textContent === w, want);
    await at('fill docs', async () => { await input.fill('docs'); await page.getByRole('option', { name: 'Docs', exact: true }).waitFor(); });
    await at('Enter picks Docs', async () => { await page.keyboard.press('Enter'); await valueIs('["bug","docs"]'); await page.getByRole('listbox').waitFor(); });
    await page.waitForTimeout(100);
    boxes.beforeOps = await anchorBox();
    await at('tap Ops', async () => { await page.getByRole('option', { name: 'Ops', exact: true }).tap(); await valueIs('["bug","docs","ops"]');
      await region.getByLabel('1 more selected', { exact: true }).waitFor(); });
    await page.waitForTimeout(100);
    boxes.afterOps = await anchorBox();
    await at('Backspace', async () => { await input.focus(); await page.keyboard.press('Backspace'); await valueIs('["bug","docs"]'); });
    await at('Escape', async () => { await page.keyboard.press('Escape'); });
    await at('remove Bug', async () => { await region.getByRole('button', { name: 'Remove Bug', exact: true }).click(); await valueIs('["docs"]'); });
    await at('reopen, untick Docs', async () => { await input.click(); await page.getByRole('option', { name: 'Docs', exact: true }).click(); await valueIs('[]'); });
    await at('tick Bug, Escape', async () => { await page.getByRole('option', { name: 'Bug', exact: true }).click(); await page.keyboard.press('Escape'); });
    await at('Tab to Clear', async () => { await input.focus(); await page.keyboard.press('Tab'); });
    await at('Enter clears', async () => { await page.keyboard.press('Enter'); await valueIs('[]'); });
    await at('settle', async () => { await page.waitForTimeout(500); });
  } catch (error) {
    errors.push({ step, message: `probe: ${error.message.split('\n')[0]}` });
  }
  const log = await page.evaluate(() => window.__roLog);
  out.runs.push({ errors, boxes, log });
  await context.close();
}
await browser.close();
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(`${TREE.split('/').pop()} ${theme}: ${out.runs.filter((r) => r.errors.length).length}/${runs} runs with page errors; ` +
  `${[...new Set(out.runs.flatMap((r) => r.errors.map((e) => `${e.step}: ${e.message.slice(0, 70)}`)))].join(' | ')}`);
