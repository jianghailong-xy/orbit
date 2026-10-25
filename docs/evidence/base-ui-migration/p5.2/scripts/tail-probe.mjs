// tail-probe.mjs: load the P5.2 conversation N times on each tree (ref on :4361, del on :4362), as the viewer case's
// first step does (all bytes served at once), and record where the conversation's scroller stands once every picture
// has decoded and the scroller has stopped: its gap to the end. Chromium, light, desktop, reduced motion.
const WT = '/root/.orbit/worktrees/6d689aae-2d33-526f-af1f-826adf954c6d';
const { chromium } = await import(`${WT}/node_modules/playwright-core/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { installP52Fixtures, P52_PATHS } = await import(`${WT}/src/web/ui-migration/p52-fixtures.mjs`);
const N = Number(process.argv[2] || 6);
const browser = await chromium.launch();
const results = { ref: [], del: [] };
for (let round = 0; round < N; round += 1) {
  for (const [tree, port] of [['ref', 4361], ['del', 4362]]) {
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light', viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await installFixedDate(page);
    await installFixtures(page, { theme: 'light' });
    await installP52Fixtures(page);
    await page.goto(P52_PATHS.session);
    const scroller = '.workspace-scroll-wrap > .workspace-sessions';
    await page.waitForFunction((s) => {
      const root = document.querySelector(s);
      if (!root) return false;
      const imgs = [...root.querySelectorAll('img')];
      return root.querySelectorAll('[data-seq="1"] img').length === 2 && root.querySelectorAll('[data-seq="8"] img').length === 1
        && root.querySelectorAll('.md img').length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0);
    }, scroller, { timeout: 20_000 });
    let last = null;
    for (let i = 0; i < 20; i += 1) {
      const now = await page.evaluate(async (s) => {
        const el = document.querySelector(s);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 150));
        return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) };
      }, scroller);
      if (last && last.top === now.top) break;
      last = now;
    }
    results[tree].push(last.gap);
    await context.close();
  }
}
await browser.close();
console.log(JSON.stringify(results));
console.log('at the tail (gap 0):', Object.fromEntries(Object.entries(results).map(([tree, gaps]) => [tree, `${gaps.filter((gap) => gap <= 1).length}/${gaps.length}`])));
