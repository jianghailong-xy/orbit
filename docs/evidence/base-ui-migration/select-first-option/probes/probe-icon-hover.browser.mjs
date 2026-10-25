import { test, expect } from '@playwright/test';

// Probe: the icon buttons the Orbit components put where AntD ones were, at rest, under the pointer and pressed:
// background and icon colour, the old AntD control and the Orbit one from the same fixture pair. Prints one PROBE
// line per control and state and attaches them all.
const finished = (locator) => locator.evaluate(async (el) => {
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const read = (locator) => locator.evaluate((el) => {
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  return { hovered: el.matches(':hover'), active: el.matches(':active'), background: style.backgroundColor, color: style.color,
    size: `${box.width}x${box.height}`, radius: style.borderRadius };
});
async function states(page, locator, press) {
  await page.mouse.move(0, 0);
  await finished(locator);
  const rest = await read(locator);
  await locator.hover();
  await finished(locator);
  const hover = await read(locator);
  // Clear icons and chip removers act on mousedown: hover only.
  if (!press) return { rest, hover };
  await page.mouse.down();
  await finished(locator);
  const active = await read(locator);
  // Released away from the control, so nothing is pressed.
  await page.mouse.move(0, 0);
  await page.mouse.up();
  return { rest, hover, active };
}

// [name, fixture page, the control for a system, whether pressing it is harmless]
const overlay = (kind) => async (page, system) => {
  await page.getByRole('button', { name: `${system} ${kind}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit workspace' });
  await expect(dialog).toBeVisible();
  await finished(dialog);
  return dialog.getByRole('button', { name: 'Close', exact: true });
};
const pair = (name, inner) => async (page, system) => {
  const cell = page.locator(`[data-case="${name}"] [data-side="${system === 'AntD' ? 'ant' : 'orbit'}"]`);
  await cell.scrollIntoViewIfNeeded();
  return inner(cell, system);
};
const CONTROLS = [
  ['dialog Close', '/ui-migration/overlays.html', overlay('dialog'), true],
  ['right drawer Close', '/ui-migration/overlays.html', overlay('right drawer'), true],
  ['bottom drawer Close', '/ui-migration/overlays.html', overlay('bottom drawer'), true],
  ['icon-only button', '/ui-migration/controls.html', pair('button-icon-only', (cell) => cell.getByRole('button', { name: 'Create' })), true],
  ['copy icon', '/ui-migration/controls.html', pair('typography-code-copy', (cell) => cell.getByRole('button', { name: /copy/i }).first()), true],
  ['input clear', '/ui-migration/controls.html', pair('input-clear-value', (cell, system) =>
    cell.locator(system === 'AntD' ? '.ant-input-clear-icon' : '.orbit-input-clear').first()), false],
];
const SAMPLES = [
  ['multiple chip remove', '/ui-migration/choices.html?sample=multiple', (page, system) =>
    page.locator(system === 'AntD' ? '.sample-choice .ant-select-selection-item-remove' : '.sample-choice .orbit-multi-chip-remove').first(), false],
  ['select clear', '/ui-migration/choices.html?sample=search', async (page, system) => {
    await page.locator('.sample-choice').hover();
    return page.locator(system === 'AntD' ? '.sample-choice .ant-select-clear' : '.sample-choice .orbit-choice-clear').first();
  }, false],
];

for (const [name, url, show, press] of [...CONTROLS, ...SAMPLES]) test(`icon button hover: ${name}`, async ({ page }, info) => {
  const results = {};
  for (const system of ['AntD', 'Orbit']) {
    const sampleUrl = url.includes('sample=') ? `${url}&system=${system === 'AntD' ? 'antd' : 'orbit'}` : url;
    await page.goto(sampleUrl);
    await expect(page.getByTestId('theme')).toContainText(info.project.use.colorScheme);
    await page.evaluate(() => document.fonts.ready);
    const control = await show(page, system);
    await expect(control).toBeVisible();
    results[system] = await states(page, control, press);
    for (const [state, value] of Object.entries(results[system])) console.log(`PROBE ${info.project.name} ${name} ${system} ${state} ${JSON.stringify(value)}`);
  }
  await info.attach('icon-hover', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});
