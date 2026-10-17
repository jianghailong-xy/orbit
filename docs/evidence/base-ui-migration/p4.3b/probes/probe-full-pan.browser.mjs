import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';
import { frames, settled } from './p43b-helpers.mjs';

// Probe: the project graph's full screen, opened after a mark was toggled: its view's transform over time
// once open, then a mouse drag on its pane (spot, events, transform), on this tree.
test('full screen pan', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await page.addInitScript(() => {
    window.__events = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'touchstart', 'pointercancel', 'click']) {
      document.addEventListener(type, (event) => window.__events.push(`${Math.round(performance.now())} ${type}:${event.pointerType ?? ''}:${event.target?.className?.toString().slice(0, 40)}`), true);
    }
  });
  await installP43bFixtures(page);
  await page.goto(P43B_PATHS.project);
  const strip = page.getByTestId('project-dependency-graph');
  await expect(strip.locator('.pdg-task').first()).toBeVisible();
  await page.locator('[data-project-block="task-graph"] > *').first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await strip.getByRole('button', { name: 'Fit whole project in view' }).click();
  await frames(page);
  await strip.locator('[aria-label^="2 done"]').first().focus();
  await page.keyboard.press('Enter');
  await expect(strip.getByText('Inventory existing components', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open project task graph full screen' }).click();
  const full = page.locator('[role="dialog"]').filter({ hasText: 'Task graph' }).last();
  await expect(full).toBeVisible();
  await settled(page);
  await frames(page);
  const viewport = full.locator('.react-flow__viewport');
  const samples = [];
  for (let i = 0; i < 12; i++) { samples.push(await viewport.evaluate((el) => el.style.transform)); await page.waitForTimeout(100); }
  const pane = full.locator('.react-flow__pane');
  const spot = await pane.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const clear = (x, y) => [[0, 0], [-24, -24], [24, -24], [-24, 24], [24, 24]].every(([dx, dy]) => document.elementFromPoint(x + dx, y + dy) === el);
    for (let y = box.top + 32; y < box.bottom - 32; y += 16) for (let x = box.left + 32; x < box.right - 32; x += 16) if (clear(x, y)) return { x, y, box: box.toJSON(), cls: el.className };
    return { box: box.toJSON() };
  });
  await page.mouse.move(spot.x, spot.y);
  const hovered = await pane.evaluate((el) => [...document.querySelectorAll(':hover')].map((e) => e.className?.toString().slice(0, 30)).slice(-3));
  await page.evaluate(() => { window.__events = []; });
  const before = await viewport.evaluate((el) => el.style.transform);
  await page.mouse.down();
  await page.mouse.move(spot.x + 30, spot.y + 20, { steps: 4 });
  await page.mouse.move(spot.x + 60, spot.y + 40, { steps: 4 });
  await page.mouse.up();
  await frames(page);
  const after = await viewport.evaluate((el) => el.style.transform);
  await page.waitForTimeout(500);
  const later = await viewport.evaluate((el) => el.style.transform);
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify({ samples: [...new Set(samples)], spot, hovered, before, after, later, events: await page.evaluate(() => window.__events) })}`);
});
