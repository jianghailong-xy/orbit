import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';
import { observe } from './p43b-helpers.mjs';

// Probe: the merge check field right after it appears: its height frame by frame and what animates it.
test('merge check field motion', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  const fixtures = await installP43bFixtures(page, { graph: 'p0', started: false });
  await page.goto(P43B_PATHS.project);
  await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  const card = page.locator('[role="dialog"]').filter({ visible: true }).last().locator('.start-card');
  await expect(card).toBeVisible();
  await observe(page, fixtures, 'start card');
  await card.getByRole('button', { name: /^Merge check/ }).click();
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    const tick = () => {
      const el = document.querySelector('textarea[aria-label="Merge check"]');
      out.push(el ? { h: Math.round(el.getBoundingClientRect().height * 10) / 10, top: Math.round(el.getBoundingClientRect().top), animations: el.getAnimations().map((a) => a.transitionProperty ?? a.animationName) } : null);
      if (out.length < 30) requestAnimationFrame(tick); else resolve(out);
    };
    tick();
  }));
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} transition=${await card.getByRole('textbox', { name: 'Merge check' }).evaluate((el) => getComputedStyle(el).transition)}`);
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify(frames)}`);
});
