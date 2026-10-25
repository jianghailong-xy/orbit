// ro-loop-probe.mjs OUT.json: choices.browser.mjs's "multiple labels search, toggle, collapse, remove and clear" case,
// step by step, on one tree's choices fixture (dev server on PORT) in WebKit with the phone projects' context options
// (390x844, touch, reduced motion, service workers blocked), THEME light|dark,
// RUNS times. For every run: after which step each page error arrived, and the ResizeObserver callbacks the page's own
// observers received (wrapped before any page script: the observed element, the box each entry reported, the time), so a
// "ResizeObserver loop completed with undelivered notifications" error can be put on the element that kept resizing.
const TREE = process.env.TREE;
const { webkit } = await import(`${TREE}/node_modules/playwright-core/index.mjs`);
const { writeFileSync } = await import('node:fs');
const runs = Number(process.env.RUNS || 5);
const theme = process.env.THEME || 'light';
const browser = await webkit.launch();
const out = { tree: TREE, theme, runs: [] };
for (let run = 0; run < runs; run++) {
  const context = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.PORT}`, locale: 'en-US', timezoneId: 'UTC',
    deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block', colorScheme: theme, viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    const log = (window.__roLog = []);
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''}`;
    const Native = window.ResizeObserver;
    window.ResizeObserver = class extends Native {
      constructor(callback) {
        super((entries, observer) => {
          if (log.length < 400) log.push({ t: Math.round(performance.now()), step: window.__step, entries: entries.map((entry) => [describe(entry.target),
            Math.round(entry.contentRect.width * 100) / 100, Math.round(entry.contentRect.height * 100) / 100]) });
          return callback(entries, observer);
        });
      }
    };
  });
  const page = await context.newPage();
  const errors = [];
  let step = 'load';
  page.on('pageerror', (error) => errors.push({ step, message: error.message }));
  const at = async (name, action) => { step = name; await page.evaluate((s) => { window.__step = s; }, name).catch(() => {}); await action(); };
  try {
    await page.goto('/ui-migration/choices.html');
    await page.getByTestId('theme').filter({ hasText: theme }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const region = page.getByRole('region', { name: 'Multiple choices', exact: true });
    const input = region.getByRole('combobox', { name: 'Labels', exact: true });
    const valueIs = (want) => page.waitForFunction((w) => document.querySelector('section[aria-label="Multiple choices"] output[aria-label="Labels value"]')?.textContent === w, want);
    await at('fill docs', async () => { await input.fill('docs'); await page.getByRole('option', { name: 'Docs', exact: true }).waitFor(); });
    await at('Enter picks Docs', async () => { await page.keyboard.press('Enter'); await valueIs('["bug","docs"]'); await page.getByRole('listbox').waitFor(); });
    await at('tap Ops', async () => { await page.getByRole('option', { name: 'Ops', exact: true }).tap(); await valueIs('["bug","docs","ops"]');
      await region.getByLabel('1 more selected', { exact: true }).waitFor(); });
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
  const geometry = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height]; };
    return { region: box(document.querySelector('section[aria-label="Multiple choices"]')), scrollY, scrollHeight: document.documentElement.scrollHeight };
  });
  const log = await page.evaluate(() => window.__roLog);
  out.runs.push({ errors, geometry, observerCallbacks: log.length, lastCallbacks: log.slice(-24) });
  await context.close();
}
await browser.close();
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(`${TREE.split('/').pop()} ${theme}: ${out.runs.filter((r) => r.errors.length).length}/${runs} runs with page errors; ` +
  `${[...new Set(out.runs.flatMap((r) => r.errors.map((e) => `${e.step}: ${e.message.slice(0, 70)}`)))].join(' | ')}`);
