import { test, expect } from './harness.mjs';
import { PILOT_PATHS, installPilotFixtures } from './pilot-fixtures.mjs';

// Probe: the task graph's full screen closed with Escape: does the task panel under it stay open, on
// this tree? The address, the panel and the full-screen button before and after.
test('escape closes only the full screen', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(PILOT_PATHS.task);
  await expect(page.locator('.tdg-canvas .tdg-node').first()).toBeVisible();
  const state = async (what) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${what} ${JSON.stringify({
    url: new URL(page.url()).pathname,
    panel: await page.locator('.task-detail-panel').count(),
    maximize: await page.getByRole('button', { name: 'Open dependency graph full screen' }).count(),
    dialogs: await page.getByRole('dialog').count(),
  })}`);
  await state('before');
  await page.getByRole('button', { name: 'Open dependency graph full screen' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(500);
  await state('full screen open');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await state('after Escape');
});
