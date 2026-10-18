import { test, expect } from './harness.mjs';
import { installPilotFixtures } from './pilot-fixtures.mjs';
import { P43A_PATHS, installP43aFixtures, listTasks, pilotRow } from './p43a-fixtures.mjs';

// Probe (not a resident spec) for the other ways the bulk bar's scrollbar comes and goes, PROBE_RUNS times each:
//  - checked first, then a task opened: the bar is there without a scrollbar, the panel narrows the list, it gains one;
//  - a task open and a row checked, then the task closed: the list widens, the bar loses its scrollbar;
//  - a task open and a row checked, then the window widened and narrowed again.
// After each step (two frames, then 600 ms) it reads the toolbar's and the bar's heights.
const RUNS = Number(process.env.PROBE_RUNS || 4);
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const read = (page) => page.evaluate(() => {
  const toolbar = document.querySelector('.tasks-toolbar'), bar = document.querySelector('.tasks-bulkbar');
  return { toolbar: toolbar.getBoundingClientRect().height, bar: bar ? bar.getBoundingClientRect().height : null,
    overflows: bar ? bar.scrollWidth > bar.clientWidth : null, heads: document.querySelector('.col-head-row').getBoundingClientRect().top };
});
const step = async (page, name, log) => {
  await frames(page);
  const now = await read(page);
  await page.waitForTimeout(600);
  const later = await read(page);
  log.push({ step: name, now, later });
};
async function setup(page, testInfo, path) {
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  const fixtures = await installP43aFixtures(page);
  fixtures.state.pilot = true;
  fixtures.state.tasks = [pilotRow(), ...listTasks()];
  await page.goto(path);
  await expect(page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' })).toBeVisible();
}
for (let i = 0; i < RUNS; i += 1) {
  test(`checked, then a task opened ${i}`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const log = [];
    await setup(page, testInfo, P43A_PATHS.tasks);
    await page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' }).getByRole('checkbox').click();
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await step(page, 'checked, no task open', log);
    await page.locator('.task-row').filter({ hasText: 'Migrate the task detail pilot' }).locator('.task-title').click();
    await expect(page.locator('.task-detail-panel').getByText('Migrate the task detail pilot').first()).toBeVisible();
    await step(page, 'a task opened', log);
    console.log(`FLOW-PROBE ${testInfo.project.name} open ${i} ${JSON.stringify(log)}`);
  });
  test(`a task open and checked, then closed ${i}`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const log = [];
    await setup(page, testInfo, P43A_PATHS.task);
    await expect(page.locator('.task-detail-panel').getByText('Migrate the task detail pilot').first()).toBeVisible();
    await page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' }).getByRole('checkbox').click();
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await step(page, 'checked, a task open', log);
    await page.locator('.task-detail-panel').getByRole('button', { name: /^close$/i }).first().click();
    await expect(page.locator('.task-detail-panel')).toHaveCount(0);
    await step(page, 'the task closed', log);
    console.log(`FLOW-PROBE ${testInfo.project.name} close ${i} ${JSON.stringify(log)}`);
  });
  test(`a task open and checked, then the window resized ${i}`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    const log = [];
    await setup(page, testInfo, P43A_PATHS.task);
    await expect(page.locator('.task-detail-panel').getByText('Migrate the task detail pilot').first()).toBeVisible();
    await page.locator('.task-row').filter({ hasText: 'Review keyboard focus order' }).getByRole('checkbox').click();
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await step(page, 'checked, a task open', log);
    await page.setViewportSize({ width: 1920, height: 900 });
    await step(page, 'widened to 1920', log);
    await page.setViewportSize({ width: 1280, height: 900 });
    await step(page, 'back to 1280', log);
    console.log(`FLOW-PROBE ${testInfo.project.name} resize ${i} ${JSON.stringify(log)}`);
  });
}
