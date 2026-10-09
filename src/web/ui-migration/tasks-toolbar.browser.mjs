import { test, expect } from './harness.mjs';
import { installPilotFixtures } from './pilot-fixtures.mjs';
import { P43A_PATHS, installP43aFixtures, listTasks, pilotRow } from './p43a-fixtures.mjs';

// The tasks toolbar is as tall as the bulk bar, the bar's own scrollbar included, and the list starts below it
// (docs/evidence/base-ui-migration/tasks-toolbar-height). With a task open the list is narrow and the bar's buttons
// overflow it; where a scrollbar takes room (WebKit's 8px ::-webkit-scrollbar) the bar is then 42px tall, not 34px.
// WebKit decides that scrollbar only after the flex layout around the bar, and the toolbar kept the height it had been
// laid out at: 34px under a 42px bar, the list 8px too high, or 42px once the bar lost its scrollbar again. Whether a
// later layout put it right depended on timing, so each case runs in TASKS_TOOLBAR_RUNS fresh pages. Every check reads
// two frames after its step. The bar's own scrollbar (8px in WebKit, none in headless Chromium) shows that the step
// reached the state it is about; the toolbar and the list are soft checks, so a run reports every step that was off.
const RUNS = Number(process.env.TASKS_TOOLBAR_RUNS || 4);
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const row = (page, title) => page.locator('.task-row').filter({ hasText: title });
const panel = (page) => page.locator('.task-detail-panel');

async function open(page, testInfo, path) {
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  const fixtures = await installP43aFixtures(page);
  fixtures.state.pilot = true;
  // The pilot task, whose page every read is answered for, is the first row and the one opened.
  fixtures.state.tasks = [pilotRow(), ...listTasks()];
  await page.goto(path);
  await expect(row(page, 'Review keyboard focus order')).toBeVisible();
}

async function check(page, testInfo, step, overflowing) {
  await frames(page);
  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector('.tasks-toolbar');
    const bar = document.querySelector('.tasks-bulkbar');
    const barStyle = getComputedStyle(bar);
    return {
      toolbar: toolbar.getBoundingClientRect().height,
      toolbarMargin: parseFloat(getComputedStyle(toolbar).marginBottom),
      bar: bar.getBoundingClientRect().height,
      barBottom: bar.getBoundingClientRect().bottom,
      barScrollbar: bar.offsetHeight - bar.clientHeight - parseFloat(barStyle.borderTopWidth) - parseFloat(barStyle.borderBottomWidth),
      barOverflows: bar.scrollWidth > bar.clientWidth,
      listTop: document.querySelector('.tasks-body').getBoundingClientRect().top,
    };
  });
  await testInfo.attach(`geometry: ${step}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
  const seen = JSON.stringify(geometry);
  expect(geometry.barOverflows, `${step}: the bar's buttons ${overflowing ? 'overflow it' : 'fit'} (${seen})`).toBe(overflowing);
  const scrollbar = overflowing && testInfo.project.use.browserName === 'webkit' ? 8 : 0;
  expect(geometry.barScrollbar, `${step}: the bar's own scrollbar (${seen})`).toBe(scrollbar);
  expect.soft(geometry.toolbar, `${step}: the toolbar is as tall as the bar (${seen})`).toBeCloseTo(geometry.bar, 0);
  expect.soft(geometry.listTop, `${step}: the list starts the toolbar's margin below the bar (${seen})`).toBeCloseTo(geometry.barBottom + geometry.toolbarMargin, 0);
}

for (let run = 1; run <= RUNS; run += 1) {
  test(`a task open, Space checks it (run ${run})`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    await open(page, testInfo, P43A_PATHS.task);
    await expect(panel(page).getByText('Migrate the task detail pilot').first()).toBeVisible();
    // P4.3a's keys case: another row's checkbox has focus, and Space checks the open task's row.
    await row(page, 'Review keyboard focus order').getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await check(page, testInfo, 'Space with a task open', true);
  });

  test(`a task open, a row checked, then the task closed (run ${run})`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    await open(page, testInfo, P43A_PATHS.task);
    await expect(panel(page).getByText('Migrate the task detail pilot').first()).toBeVisible();
    await row(page, 'Review keyboard focus order').getByRole('checkbox').click();
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await check(page, testInfo, 'a row checked with a task open', true);
    await panel(page).getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(panel(page)).toHaveCount(0);
    await check(page, testInfo, 'the task closed', false);
  });

  test(`a row checked, then a task opened, the window widened and narrowed (run ${run})`, async ({ evidence }, testInfo) => {
    const { page } = evidence;
    await open(page, testInfo, P43A_PATHS.tasks);
    await row(page, 'Review keyboard focus order').getByRole('checkbox').click();
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await check(page, testInfo, 'a row checked, no task open', false);
    await row(page, 'Migrate the task detail pilot').locator('.task-title').click();
    await expect(panel(page).getByText('Migrate the task detail pilot').first()).toBeVisible();
    await check(page, testInfo, 'a task opened', true);
    const { width, height } = page.viewportSize();
    await page.setViewportSize({ width: 1920, height });
    await check(page, testInfo, 'the window widened to 1920px', false);
    await page.setViewportSize({ width, height });
    await check(page, testInfo, `the window back at ${width}px`, true);
  });
}
