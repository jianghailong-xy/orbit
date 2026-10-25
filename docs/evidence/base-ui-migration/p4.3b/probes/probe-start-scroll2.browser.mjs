import { test, expect } from './harness.mjs';
import { P43B_PATHS, gate, installP43bFixtures } from './p43b-fixtures.mjs';
import { fill, frames } from './p43b-helpers.mjs';

// Probe: the owner's start dialog, the spec's own steps up to p43b-start-settings, and after each
// step every scrolled element, the dialog's top edge and the focus, on this tree.
test('start dialog scroll, spec steps', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  const fixtures = await installP43bFixtures(page, { graph: 'p0', started: false });
  const hold = gate();
  fixtures.state.holdStanding = hold;
  await page.goto(P43B_PATHS.project);
  await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  const sheet = page.locator('[role="dialog"]').filter({ visible: true }).last();
  const state = (what) => page.evaluate((what) => {
    const scrolled = [...document.querySelectorAll('*')].filter((el) => el.scrollTop > 0)
      .map((el) => `${el.tagName}.${(el.getAttribute('class') ?? '').split(' ').slice(0, 2).join('.')}=${el.scrollTop}/${el.scrollHeight - el.clientHeight}`);
    const surface = document.querySelector('.ant-modal-container, .orbit-overlay');
    const active = document.activeElement;
    return { what, scrolled, page: document.scrollingElement.scrollTop, surfaceTop: surface ? Math.round(surface.getBoundingClientRect().top) : null,
      focus: active ? `${active.tagName}.${(active.getAttribute('class') ?? '').slice(0, 30)}` : null };
  }, what);
  const log = async (what) => console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify(await state(what))}`);
  await expect(sheet.locator('.ant-spin, .orbit-spinner')).toBeVisible();
  await frames(page);
  await log('reading');
  hold.release();
  fixtures.state.holdStanding = null;
  const card = sheet.locator('.start-card');
  await expect(card).toBeVisible();
  await frames(page);
  await log('start card');
  const automatic = card.getByRole('switch', { name: 'Automatic' });
  await automatic.click();
  await expect(automatic).toHaveAttribute('aria-checked', 'false');
  await frames(page);
  await log('automatic off');
  await automatic.click();
  await expect(automatic).toHaveAttribute('aria-checked', 'true');
  await log('automatic on');
  const line = card.getByRole('combobox', { name: 'Tasks land on' });
  await line.click();
  const option = page.getByRole('option', { name: /Directly into main/ });
  await expect(option).toBeVisible();
  await frames(page);
  await log('line menu open');
  await option.click();
  await expect(card.locator('.ant-select, .orbit-select')).toContainText('Directly into main');
  await log('main chosen');
  await card.getByRole('button', { name: /^Merge check/ }).click();
  await log('merge check opened');
  const check = card.getByRole('textbox', { name: 'Merge check' });
  await check.click();
  await log('check clicked');
  await check.press('ControlOrMeta+a');
  await log('check select all');
  await check.pressSequentially('npm run build -w @orbit/web && npm run test -w @orbit/web');
  await log('check typed');
  const count = card.getByRole('spinbutton', { name: 'At most' });
  await count.click();
  await log('count clicked');
  await count.press('ControlOrMeta+a');
  await log('count select all');
  await count.pressSequentially('4');
  await frames(page);
  await log('count typed');
  await page.waitForTimeout(1000);
  await log('a second later');
  await fill(count, '4');
  await log('fill again');
});
