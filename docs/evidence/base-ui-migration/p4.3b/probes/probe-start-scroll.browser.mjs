import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';

// Probe: the owner's start dialog, its scroll position and focus at each settings step, on this tree.
test('start dialog scroll', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await installP43bFixtures(page, { graph: 'p0', started: false });
  await page.goto(P43B_PATHS.project);
  await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  const sheet = page.locator('[role="dialog"]').filter({ visible: true }).last();
  const card = sheet.locator('.start-card');
  await expect(card).toBeVisible();
  await page.waitForTimeout(600);
  const state = (what) => page.evaluate((what) => {
    const scroller = document.querySelector('.ant-modal-wrap:not([style*="display: none"]), .orbit-overlay-viewport');
    const active = document.activeElement;
    return { what, scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight, clientHeight: scroller?.clientHeight,
      focus: active ? `${active.tagName}.${(active.getAttribute('class') ?? '').slice(0, 30)}` : null };
  }, what);
  const log = async (what) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify(await state(what))}`);
  await log('opened');
  const automatic = card.getByRole('switch', { name: 'Automatic' });
  await automatic.click(); await automatic.click(); await page.waitForTimeout(300); await log('automatic twice');
  const line = card.getByRole('combobox', { name: 'Tasks land on' });
  await line.click(); await page.waitForTimeout(400); await log('line menu open');
  await page.getByRole('option', { name: /Directly into main/ }).click(); await page.waitForTimeout(400); await log('main chosen');
  await card.getByRole('button', { name: /^Merge check/ }).click(); await page.waitForTimeout(300); await log('merge check opened');
  const check = card.getByRole('textbox', { name: 'Merge check' });
  await check.click(); await page.waitForTimeout(300); await log('check clicked');
  await check.pressSequentially('npm run build'); await page.waitForTimeout(300); await log('check typed');
  const count = card.getByRole('spinbutton', { name: 'At most' });
  await count.click(); await page.waitForTimeout(300); await log('count clicked');
  await count.press('ControlOrMeta+a'); await count.pressSequentially('4'); await page.waitForTimeout(300); await log('count typed');
});
