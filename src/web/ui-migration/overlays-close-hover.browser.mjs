import { test, expect } from '@playwright/test';

// The dialog's Close at rest and under the pointer: the old AntD modal's and the Orbit dialog's, the overlays
// fixture's appearance pair, in this project's theme. The replaced Close took a stronger hover background
// than the controls' shared one.
const fixture = '/ui-migration/overlays.html';

const read = (close) => close.evaluate((el) => {
  const style = getComputedStyle(el), box = el.getBoundingClientRect();
  return { hovered: el.matches(':hover'), background: style.backgroundColor, color: style.color, borderRadius: style.borderRadius,
    width: box.width, height: box.height };
});
const finished = (locator) => locator.evaluate(async (el) => {
  await Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
// Opened: neither the dialog nor anything around it is still scaled or fading in.
async function settled(dialog) {
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.opacity !== '1' || style.transform !== 'none' || (style.scale !== 'none' && style.scale !== '1')) return false;
    }
    return true;
  })).toBe(true);
  await finished(dialog);
}

test('the dialog Close takes the replaced modal Close hover background', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture);
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  const results = {};
  for (const system of ['AntD', 'Orbit']) {
    await page.getByRole('button', { name: `${system} dialog`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit workspace' });
    await settled(dialog);
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await page.mouse.move(0, 0);
    await finished(close);
    const rest = await read(close);
    await close.hover();
    await finished(close);
    const hover = await read(close);
    const box = await close.boundingBox();
    await info.attach(`${system}-close-hover`, { body: await page.screenshot({ animations: 'disabled',
      clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 } }), contentType: 'image/png' });
    results[system] = { rest, hover };
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  }
  await info.attach('close-hover', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  expect(results.AntD.rest.hovered).toBe(false);
  expect(results.AntD.hover.hovered).toBe(true);
  expect(results.AntD.hover.background).toBe(info.project.use.colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.06)');
  expect(results.Orbit).toEqual(results.AntD);
  expect(errors).toEqual([]);
});
