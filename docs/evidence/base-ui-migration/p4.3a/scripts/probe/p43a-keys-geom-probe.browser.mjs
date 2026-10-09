import { test, expect } from './harness.mjs';
import { installPilotFixtures } from './pilot-fixtures.mjs';
import { P43A_PATHS, installP43aFixtures, listTasks, pilotRow } from './p43a-fixtures.mjs';

// Geometry probe for P4.3a's evidence, not part of the comparison spec: the keys test's steps up to its screenshot
// (a task open, another row's checkbox focused, Space), eight times, reading after each the boxes between the top of
// the list's scroll container and its column heads -- every element on the way down from .tasks-body, the bulk
// bar's sizes (offset and client height, scroll and client width) -- to find which box takes the 8px the heads move
// by from run to run.
for (let i = 0; i < 8; i += 1) {
  test(`keys geometry ${i}`, async ({ evidence }, testInfo) => {
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
    await page.keyboard.press('Space');
    await expect(page.locator('.tasks-bulkbar').getByText('1 selected')).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.top * 10) / 10, Math.round(r.height * 10) / 10]; };
      const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`;
      const heads = document.querySelector('.col-head-row');
      const bar = document.querySelector('.tasks-bulkbar');
      // Every element whose box starts above the heads, from the page's main column down.
      const above = [...document.querySelectorAll('.tasks-header *, .tasks-header, .tasks-body, .tasks-body > *')]
        .filter((el) => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().top <= heads.getBoundingClientRect().top)
        .filter((el) => !bar.contains(el) || el === bar)
        .map((el) => `${name(el)}@${box(el).join('+')}`);
      return { heads: box(heads), bar: bar && { box: box(bar), offsetHeight: bar.offsetHeight, clientHeight: bar.clientHeight, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth },
        body: (() => { const b = document.querySelector('.tasks-body'); return { box: box(b), scrollTop: b.scrollTop, clientHeight: b.clientHeight, scrollHeight: b.scrollHeight }; })(),
        above };
    });
    console.log(`KEYS-GEOM ${testInfo.project.name} ${i} ${JSON.stringify(geometry)}`);
  });
}
