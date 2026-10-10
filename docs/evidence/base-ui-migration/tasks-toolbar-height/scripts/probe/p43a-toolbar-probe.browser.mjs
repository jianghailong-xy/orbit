import { test, expect } from './harness.mjs';
import { installPilotFixtures } from './pilot-fixtures.mjs';
import { P43A_PATHS, installP43aFixtures, listTasks, pilotRow } from './p43a-fixtures.mjs';

// Observation probe for the tasks toolbar height (not a resident spec): P4.3a's keys case up to its screenshot (the
// pilot task open, another row's checkbox focused, Space), PROBE_RUNS times, with observers that force no layout:
// ResizeObserver border boxes of the toolbar, the header, the list body and the bulk bar, mutation records of the
// whole page grouped by region, and frame ticks. After 1.5 s it reads the settled geometry.
const RUNS = Number(process.env.PROBE_RUNS || 8);
for (let i = 0; i < RUNS; i += 1) {
  test(`toolbar probe ${i}`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
    const fixtures = await installP43aFixtures(page);
    fixtures.state.pilot = true;
    fixtures.state.tasks = [pilotRow(), ...listTasks()];
    await page.goto(P43A_PATHS.task);
    await expect(page.locator('.task-detail-panel').getByText('Migrate the task detail pilot').first()).toBeVisible();
    const row = page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' });
    await expect(row).toBeVisible();
    await row.getByRole('checkbox').focus();
    await page.evaluate(() => {
      const t0 = performance.now();
      const log = (window.__probe = { events: [], dropped: 0 });
      const push = (event) => { if (log.events.length < 600) log.events.push({ t: Math.round((performance.now() - t0) * 10) / 10, ...event }); else log.dropped += 1; };
      const name = (el) => (el.nodeType === 1 ? `${el.tagName.toLowerCase()}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}` : el.nodeName);
      const region = (el) => {
        const node = el.nodeType === 1 ? el : el.parentElement;
        if (!node) return 'detached';
        if (node.closest('.tasks-toolbar')) return 'toolbar';
        if (node.closest('.tasks-header')) return 'header';
        if (node.closest('.tasks-body')) return 'body';
        if (node.closest('.task-detail-panel')) return 'panel';
        return 'other';
      };
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const box = entry.borderBoxSize[0];
          push({ kind: 'resize', target: name(entry.target), w: Math.round(box.inlineSize * 10) / 10, h: Math.round(box.blockSize * 10) / 10 });
        }
      });
      for (const selector of ['.tasks-toolbar', '.tasks-header', '.tasks-body']) ro.observe(document.querySelector(selector));
      const mo = new MutationObserver((records) => {
        for (const record of records) {
          const where = region(record.target);
          push({ kind: 'mutation', region: where, type: record.type, target: name(record.target), attr: record.attributeName ?? undefined,
            added: record.addedNodes.length ? [...record.addedNodes].map(name).slice(0, 4) : undefined,
            removed: record.removedNodes.length ? [...record.removedNodes].map(name).slice(0, 4) : undefined });
          for (const node of record.addedNodes) if (node.nodeType === 1 && node.matches('.tasks-bulkbar')) ro.observe(node);
        }
      });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      let frames = 0;
      const tick = () => { push({ kind: 'frame', n: frames }); frames += 1; if (frames < 40) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    await page.keyboard.press('Space');
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await page.waitForTimeout(1500);
    const result = await page.evaluate(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10, w: Math.round(r.width * 10) / 10 }; };
      const bar = document.querySelector('.tasks-bulkbar');
      return {
        toolbar: box(document.querySelector('.tasks-toolbar')),
        header: box(document.querySelector('.tasks-header')),
        body: box(document.querySelector('.tasks-body')),
        heads: box(document.querySelector('.col-head-row')),
        bar: { ...box(bar), offsetHeight: bar.offsetHeight, clientHeight: bar.clientHeight, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth },
        events: window.__probe.events, dropped: window.__probe.dropped,
      };
    });
    console.log(`TOOLBAR-PROBE ${testInfo.project.name} ${i} ${JSON.stringify(result)}`);
  });
}
