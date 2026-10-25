import { test, expect } from './harness.mjs';
import { PILOT_PATHS, installPilotFixtures } from './pilot-fixtures.mjs';

// Probe: on the task graph scrolled to the top, does focusing a prerequisite's remove button move the
// canvas (TaskDependencyGraph's ensureFocusedNodeVisible), so a click's press and release land on
// different elements? And does the question open from focus-then-click, on this tree?
test('remove question opens', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(PILOT_PATHS.task);
  const canvas = page.locator('.tdg-canvas');
  await expect(canvas.locator('.tdg-node').first()).toBeVisible();
  await canvas.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const remove = page.getByRole('button', { name: 'Remove Capture browser baselines as a prerequisite' });
  const log = (what, value) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${what} ${JSON.stringify(value)}`);
  const transform = () => canvas.locator('.react-flow__viewport').evaluate((el) => el.style.transform);
  const opened = () => page.evaluate(() => [...document.querySelectorAll('.ant-popconfirm, .orbit-popconfirm')].filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden').length);
  log('viewport before', await transform());
  log('button before', await remove.boundingBox());
  await remove.focus();
  await page.waitForTimeout(400);
  log('viewport after focus', await transform());
  log('button after focus', await remove.boundingBox());
  await remove.click({ timeout: 5000 }).then(() => log('click', 'ok'), (e) => log('click-error', e.message.split('\n')[0]));
  await page.waitForTimeout(800);
  log('opened after focus then click', await opened());
});
