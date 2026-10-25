import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';

// Probe: the project graph's "Open full-screen graph" hint: where its trigger is, which side the hint
// opens on and its box, on this tree.
test('full-screen hint side', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP43bFixtures(page, { graph: 'rich' });
  await page.goto(P43B_PATHS.project);
  const strip = page.locator('[data-testid="project-dependency-graph"]');
  await expect(strip).toBeVisible();
  await strip.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  const trigger = strip.getByRole('button', { name: /full screen/i });
  await trigger.hover();
  const tip = page.locator('[role="tooltip"]').filter({ hasText: 'Open full-screen graph' }).filter({ visible: true });
  await expect(tip).toBeVisible();
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => {
    const tip = [...document.querySelectorAll('[role="tooltip"]')].find((el) => el.textContent.includes('Open full-screen graph') && el.getBoundingClientRect().width > 0);
    const box = (tip.closest('.ant-tooltip') ?? tip.closest('.orbit-floating-positioner') ?? tip).getBoundingClientRect().toJSON();
    const trigger = document.querySelector('[data-testid="project-dependency-graph"] .tdg-maximize').getBoundingClientRect().toJSON();
    const side = tip.closest('[data-side]')?.getAttribute('data-side') ?? [...(tip.closest('.ant-tooltip')?.classList ?? [])].find((c) => c.startsWith('ant-tooltip-placement-'));
    return { side, box, trigger, viewport: [innerWidth, innerHeight] };
  });
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify(state)}`);
});
