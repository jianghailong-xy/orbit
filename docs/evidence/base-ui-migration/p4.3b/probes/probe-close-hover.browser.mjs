import { test, expect } from './harness.mjs';
import { PILOT_PATHS, installPilotFixtures } from './pilot-fixtures.mjs';

// Probe: the full-screen graph's Close, at rest and under the pointer: its background on this tree.
test('full-screen close hover', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installPilotFixtures(page, { theme: testInfo.project.use.colorScheme });
  await page.goto(PILOT_PATHS.task);
  const canvas = page.locator('.tdg-canvas');
  await expect(canvas.locator('.tdg-node').first()).toBeVisible();
  await page.getByRole('button', { name: 'Open dependency graph full screen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close' });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  const read = () => close.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, rect: el.getBoundingClientRect().toJSON() }));
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} rest ${JSON.stringify(await read())}`);
  await close.hover();
  await page.waitForTimeout(500);
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} hover ${JSON.stringify(await read())}`);
});
