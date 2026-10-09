import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';
import { frames } from './p43b-helpers.mjs';

// Probe: a mouse drag on the project graph's strip: the spot, the events the pane gets and the viewport's
// transform before and after, on this tree.
test('strip pan', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await page.addInitScript(() => {
    window.__events = [];
    for (const type of ['pointerdown', 'mousedown', 'pointermove', 'mouseup', 'pointerup', 'touchstart', 'pointercancel']) {
      document.addEventListener(type, (event) => {
        if (type.endsWith('move') && window.__events.filter((e) => e.startsWith(type)).length > 2) return;
        window.__events.push(`${type}:${event.pointerType ?? ''}:${event.target?.className?.toString().slice(0, 30)}:${event.defaultPrevented}`);
      }, true);
    }
  });
  await installP43bFixtures(page);
  await page.goto(P43B_PATHS.project);
  const strip = page.getByTestId('project-dependency-graph');
  await expect(strip.locator('.pdg-task').first()).toBeVisible();
  await strip.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await frames(page);
  const viewport = strip.locator('.react-flow__viewport');
  const info = await strip.locator('.react-flow__pane').evaluate((pane) => {
    const box = pane.getBoundingClientRect();
    for (let y = box.top + 24; y < box.bottom - 24; y += 8) {
      for (let x = box.left + 24; x < box.right - 24; x += 8) {
        if (document.elementFromPoint(x, y) === pane) return { x, y, box: box.toJSON(), touchAction: getComputedStyle(pane).touchAction, cls: pane.className };
      }
    }
    return { box: box.toJSON() };
  });
  const before = await viewport.evaluate((el) => el.style.transform);
  await page.evaluate(() => { window.__events = []; });
  await page.mouse.move(info.x, info.y);
  await page.mouse.down();
  await page.mouse.move(info.x + 30, info.y + 20, { steps: 4 });
  await page.mouse.move(info.x + 60, info.y + 40, { steps: 4 });
  await page.mouse.up();
  await frames(page);
  const after = await viewport.evaluate((el) => el.style.transform);
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify({ info, before, after, events: await page.evaluate(() => window.__events) })}`);
});
