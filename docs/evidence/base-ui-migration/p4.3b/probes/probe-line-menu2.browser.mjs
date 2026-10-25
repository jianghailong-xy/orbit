import { test, expect } from './harness.mjs';
import { P43B_PATHS, installP43bFixtures } from './p43b-fixtures.mjs';
import { frames, observe } from './p43b-helpers.mjs';

// Probe: the start dialog's line menu opened as the spec opens it: the pointer events the press
// sends, and which option the list shows as highlighted, on this tree.
test('line menu highlight', async ({ evidence }, testInfo) => {
  const { page } = evidence;
  await page.addInitScript(() => {
    window.__events = [];
    const t0 = performance.now();
    const stamp = () => Math.round(performance.now() - t0);
    for (const type of ['pointerdown', 'pointerup', 'click', 'pointermove', 'pointerleave', 'pointerenter', 'mouseleave', 'mousemove', 'focusin']) {
      document.addEventListener(type, (event) => window.__events.push(`${stamp()} ${type}:${event.pointerType ?? ''}:${event.isTrusted}:${event.target?.className?.toString().slice(0, 30)}@${event.clientX ?? ''},${event.clientY ?? ''}`), true);
    }
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'data-highlighted') window.__events.push(`${stamp()} mutation highlighted=${record.target.hasAttribute('data-highlighted')} ${record.target.textContent.slice(0, 12)}`);
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-highlighted'] });
  });
  const fixtures = await installP43bFixtures(page, { graph: 'p0', started: false });
  await page.goto(P43B_PATHS.project);
  await page.locator('.project-open-items').getByRole('button', { name: /^Start/ }).first().click();
  const card = page.locator('[role="dialog"]').filter({ visible: true }).last().locator('.start-card');
  await expect(card).toBeVisible();
  await observe(page, fixtures, 'start card');
  await page.evaluate(() => { window.__events = []; });
  await card.getByRole('combobox', { name: 'Tasks land on' }).click();
  const option = page.getByRole('option', { name: /Directly into main/ });
  await expect(option).toBeVisible();
  await frames(page);
  await observe(page, fixtures, 'menu');
  const state = await page.evaluate(() => ({
    events: window.__events,
    options: [...document.querySelectorAll('[role="option"]')].map((el) => ({
      text: el.textContent.slice(0, 20), cls: el.className.toString().slice(0, 80), highlighted: el.hasAttribute('data-highlighted'), selected: el.getAttribute('aria-selected'),
      hover: el.matches(':hover'), rect: el.getBoundingClientRect().toJSON(), bg: getComputedStyle(el.closest('.ant-select-item') ?? el).backgroundColor,
    })),
    active: document.activeElement?.className?.toString().slice(0, 40),
  }));
  console.log(`PROBE ${process.env.TREE} ${testInfo.project.name} ${JSON.stringify(state)}`);
});
