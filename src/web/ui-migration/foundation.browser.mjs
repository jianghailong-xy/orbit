import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = '/ui-migration/foundation.html';
const properties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor',
  'border', 'borderRadius', 'padding', 'gap', 'boxShadow'];
async function style(locator) {
  return locator.evaluate((el, keys) => {
    const s = getComputedStyle(el), { width, height } = el.getBoundingClientRect();
    return { width, height, ...Object.fromEntries(keys.map((key) => [key, s[key]])) };
  }, properties);
}

async function checkDialogFocusCycle(page, dialog) {
  const containsFocus = () => dialog.evaluate((el) => el.contains(document.activeElement));
  await expect.poll(containsFocus, { message: 'Opening transfers focus into the dialog' }).toBe(true);
  const visited = new Set();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    // Base UI wraps through its hidden focus guard and transfers focus on the next frame.
    await expect.poll(containsFocus, { message: 'Tab keeps focus inside the dialog' }).toBe(true);
    visited.add(await page.evaluate(() => document.activeElement.textContent));
  }
  expect([...visited].sort()).toEqual(['Close Orbit dialog', 'Dialog action']);
}

async function expectDialogInsideViewport(dialog) {
  const bounds = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, viewport: innerWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(16);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewport - 16);
  expect(bounds.width).toBe(Math.min(520, bounds.viewport - 32));
}

test('foundation states match current AntD and the frozen P0 palette', async ({ page }, info) => {
  const theme = info.project.use.colorScheme;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(fixture);
  await expect(page.getByRole('status')).toHaveText(`Theme: system / ${theme}`);
  await page.evaluate(() => document.fonts.ready);
  const orbit = page.getByRole('region', { name: 'Orbit foundation', exact: true });
  const ant = page.getByRole('region', { name: 'AntD reference', exact: true });
  const measured = {};
  for (const name of ['Primary', 'Disabled', 'Neutral', 'Small']) {
    const actual = await style(orbit.getByRole('button', { name, exact: true }));
    const reference = await style(ant.getByRole('button', { name, exact: true }));
    expect(actual, `${name} computed styles`).toEqual(reference);
    measured[name] = actual;
  }
  await expect(orbit.getByRole('button', { name: 'Disabled' })).toBeDisabled();
  // Read immutable P0 evidence, not the newly added token declarations.
  const p0 = JSON.parse(readFileSync(new URL(`../../../docs/evidence/base-ui-migration/p0.2/baseline-run/chromium-${theme}-desktop--task--computed-styles-and-timings.json`, import.meta.url)));
  const primary = p0.captures.flatMap((capture) => capture.controls).find((control) => control.label === 'Run now');
  expect(measured.Primary.backgroundColor).toBe(primary.style.backgroundColor);
  expect(measured.Primary.height).toBe(primary.rect.height);
  expect(measured.Primary.borderRadius).toBe(primary.style.borderRadius);
  for (const name of ['Primary', 'Neutral']) {
    const actual = orbit.getByRole('button', { name, exact: true });
    const reference = ant.getByRole('button', { name, exact: true });
    await actual.hover();
    const hovered = await style(actual);
    await reference.hover();
    await expect.poll(async () => (await style(reference)).backgroundColor).toBe(hovered.backgroundColor);
    expect(await style(reference)).toEqual(hovered);
    measured[`${name} hover`] = hovered;
  }
  await page.getByRole('heading', { level: 1 }).hover();
  await page.keyboard.press('Tab');
  const focusStyle = (locator) => locator.evaluate((el) => ({
    visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outline,
    offset: getComputedStyle(el).outlineOffset,
  }));
  await orbit.getByRole('button', { name: 'Primary', exact: true }).focus();
  const focused = await focusStyle(orbit.getByRole('button', { name: 'Primary', exact: true }));
  expect(focused.visible).toBe(true);
  await ant.getByRole('button', { name: 'Primary', exact: true }).focus();
  expect(await focusStyle(ant.getByRole('button', { name: 'Primary', exact: true }))).toEqual(focused);
  measured.focus = focused;
  expect(errors).toEqual([]);
  await info.attach('computed-states', { body: JSON.stringify({ theme, measured, errors }, null, 2), contentType: 'application/json' });
  await info.attach('coexistence', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
});

test('body and nested portals inherit theme and preserve focus ownership', async ({ page }, info) => {
  await page.goto(fixture);
  const theme = info.project.use.colorScheme;
  await expect(page.getByRole('status')).toHaveText(`Theme: system / ${theme}`);
  const trigger = page.getByRole('button', { name: 'Open Orbit dialog', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Orbit dialog', exact: true });
  await expect(dialog).toBeVisible();
  await expectDialogInsideViewport(dialog);
  const surface = await style(dialog);
  expect(surface.backgroundColor).toBe(theme === 'dark' ? 'rgb(52, 52, 55)' : 'rgb(255, 255, 255)');
  expect(surface.borderRadius).toBe('10px');
  await checkDialogFocusCycle(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Open AntD dialog', exact: true }).click();
  const outer = page.getByRole('dialog', { name: 'AntD dialog', exact: true });
  await expect(outer).toBeVisible();
  // AntD's visible prepare phase precedes its entry animation and final focus transfer.
  await expect.poll(() => outer.evaluate((el) => {
    const style = getComputedStyle(el);
    return style.opacity === '1' && style.transform === 'none';
  }), { message: 'The parent modal has finished entering before opening its child' }).toBe(true);
  const nestedTrigger = outer.getByRole('button', { name: 'Open nested Orbit dialog' });
  await nestedTrigger.click();
  const nested = page.getByRole('dialog', { name: 'Nested Orbit dialog', exact: true });
  await expect(nested).toBeVisible();
  await expectDialogInsideViewport(nested);
  expect(await style(nested)).toMatchObject({ backgroundColor: surface.backgroundColor, borderRadius: surface.borderRadius, boxShadow: surface.boxShadow });
  expect(await nested.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  await checkDialogFocusCycle(page, nested);
  await info.attach('nested-portals', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(nested).not.toBeVisible();
  await expect(outer).toBeVisible();
  await expect(nestedTrigger).toBeFocused();
  await outer.getByRole('button', { name: 'Close AntD dialog', exact: true }).click();
  await expect(outer).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open AntD dialog', exact: true })).toBeFocused();
  await info.attach('portal-surface', { body: JSON.stringify({ theme, surface, focusRestored: true }, null, 2), contentType: 'application/json' });
});
