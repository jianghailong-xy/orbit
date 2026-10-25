import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';

// Probe: the done dialog's scroll position and focus at each step of "Not yet" on this tree.
test('done dialog scroll', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP43bFixtures(page, { done: true });
  await page.goto(P43B_PATHS.project);
  await page.locator('.project-open-items').getByRole('button', { name: /^Review/ }).first().click();
  const done = page.locator('[role="dialog"]').filter({ has: page.locator('.project-done-card') }).filter({ visible: true }).last();
  await expect(done.locator('.project-done-card')).toBeVisible();
  await page.waitForTimeout(600);
  const state = (what) => page.evaluate((what) => {
    const scroller = document.querySelector('.ant-modal-wrap:not([style*="display: none"]), .orbit-overlay-viewport');
    const field = document.querySelector('.project-done-not-yet textarea');
    const active = document.activeElement;
    return { what, scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight, clientHeight: scroller?.clientHeight,
      field: field ? Math.round(field.getBoundingClientRect().top) : null,
      focus: active ? `${active.tagName}.${(active.getAttribute('class') ?? '').slice(0, 40)}` : null };
  }, what);
  const log = async (what) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify(await state(what))}`);
  await log('opened');
  await done.getByRole('button', { name: /^Not yet/ }).click();
  await page.waitForTimeout(600);
  await log('not yet pressed');
  const note = done.getByRole('textbox', { name: /^What’s missing/ });
  await note.click();
  await page.waitForTimeout(400);
  await log('field clicked');
  await note.pressSequentially('The phone screenshots');
  await page.waitForTimeout(400);
  await log('typed');
});
