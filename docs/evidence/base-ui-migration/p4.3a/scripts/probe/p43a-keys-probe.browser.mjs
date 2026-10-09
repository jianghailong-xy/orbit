import { test, expect } from './harness.mjs';
import { installPilotFixtures } from './pilot-fixtures.mjs';
import { P43A_PATHS, installP43aFixtures, listTasks, pilotRow } from './p43a-fixtures.mjs';

// Keys probe for P4.3a's evidence, not part of the comparison spec: the keys test's steps up to its screenshot, with
// the list's geometry read after each one -- the scroll container's scrollTop, where the bulk bar, the column heads
// and the focused row sit, and which element has focus -- to find what moves the list 8px in WebKit light desktop.
test('keys probe', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  const fixtures = await installP43aFixtures(page);
  fixtures.state.pilot = true;
  fixtures.state.tasks = [pilotRow(), ...listTasks()];
  const read = (step) => page.evaluate((name) => {
    const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10]; };
    const scrollers = [...document.querySelectorAll('*')].filter((el) => el.scrollTop > 0).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}:${el.scrollTop}`);
    const active = document.activeElement;
    return { step: name, scrollers, bulkbar: rect('.tasks-bulkbar'), heads: rect('.col-head-row'), firstRow: rect('.task-row'),
      focus: active ? `${active.tagName.toLowerCase()}[role=${active.getAttribute('role')}].${[...active.classList].join('.')}` : null,
      docScroll: [document.scrollingElement.scrollTop, window.scrollY] };
  }, step);
  const log = [];
  await page.goto(P43A_PATHS.task);
  await expect(page.locator('.task-detail-panel').getByText('Migrate the task detail pilot').first()).toBeVisible();
  await expect(page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' })).toBeVisible();
  log.push(await read('loaded'));
  await page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' }).getByRole('checkbox').focus();
  log.push(await read('checkbox focused'));
  await page.keyboard.press('Space');
  await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
  log.push(await read('space'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  log.push(await read('two frames later'));
  console.log(`KEYS-PROBE ${testInfo.project.name} ${JSON.stringify(log)}`);
});
