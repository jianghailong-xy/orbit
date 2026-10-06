import { test, expect } from '@playwright/test';
import { expectExpired } from './toasts-checks.mjs';
import { installFixedDate } from './fixtures.mjs';

const errors = new WeakMap();
const notices = (page) => page.locator('.toast-viewport');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const shot = async (info, name, locator) => {
  const page = typeof locator.page === 'function' ? locator.page() : locator;
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    document.activeElement?.blur();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await info.attach(name + '-styles', { body: JSON.stringify(await page.locator('.toast-viewport').evaluate((region) =>
    [...region.querySelectorAll('.toast, .toast-row, .toast-head, .toast-reason, button')].map((el) => {
      const s = getComputedStyle(el);
      return { tag: el.tagName, class: el.className, text: el.textContent, rect: el.getBoundingClientRect().toJSON(),
        hovered: el.matches(':hover'), focused: el.matches(':focus'), font: s.font, color: s.color, background: s.background,
        border: s.border, boxShadow: s.boxShadow, padding: s.padding, gap: s.gap, transform: s.transform, willChange: s.willChange };
    })), null, 2), contentType: 'application/json' });
  await info.attach(name, { body: await locator.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
};

test.beforeEach(async ({ page }, info) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
  await installFixedDate(page);
  await page.goto('/ui-migration/toasts.html');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
    .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function measure(region) {
  return region.evaluate((el) => [el, ...el.querySelectorAll('.toast, .toast-row, .toast-head, .toast-reason, button')].map((node) => {
    const r = node.getBoundingClientRect(), s = getComputedStyle(node);
    const keys = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'background', 'border', 'borderRadius', 'boxShadow', 'padding', 'gap', 'pointerEvents'];
    return { tag: node.tagName, text: node.textContent, x: r.x, y: r.y, width: r.width, height: r.height,
      hovered: node.matches(':hover'), focused: node.matches(':focus'), focusVisible: node.matches(':focus-visible'),
      ...Object.fromEntries(keys.map((key) => [key, s[key]])) };
  }));
}

async function keyboardReach(page, target, dialog) {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'focus stays with the active modal and its notifications').toBe(true);
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  await expect(target).toBeFocused();
}

for (const [kind, title] of [['Dialog', 'Workspace editor'], ['Drawer', 'Workspace drawer'], ['Bottom drawer', 'Workspace sheet']]) {
  test(`existing notifications remain accessible in ${kind} with unchanged appearance`, async ({ page }, info) => {
    await button(page, 'Error notice').click();
    await page.mouse.move(0, 0);
    const region = notices(page);
    const before = await measure(region);
    await shot(info, 'before-overlay', region);
    const trigger = button(page, `Open ${kind}`);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(region).toBeVisible();
    const after = await measure(region);
    await attach(info, 'appearance', { before, after });
    expect(after).toEqual(before);
    await shot(info, 'with-overlay', region);
    await shot(info, 'notification-and-overlay', page);

  });
}


test('mixed pinned and passing notifications stack without overlap and retain all pinned errors', async ({ page }, info) => {
  await button(page, 'Warning notice').click();
  await button(page, 'Error notice').click();
  await button(page, 'Short notice').click();
  await button(page, 'Complete session').click();
  const region = notices(page);
  await page.mouse.move(0, 0);
  const cards = region.locator('.toast');
  await expect(cards).toHaveCount(info.project.use.isMobile ? 2 : 3);
  const geometry = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  geometry.forEach((r, i) => {
    expect(r.x).toBeGreaterThanOrEqual(16);
    expect(r.right).toBeLessThanOrEqual(info.project.use.viewport.width - 16);
    if (i) expect(r.y - geometry[i - 1].bottom).toBeGreaterThanOrEqual(8);
  });
  await shot(info, 'mixed-stack', page);
  await attach(info, 'stack-geometry', geometry);
  if (!info.project.use.isMobile) {
    await region.getByRole('button', { name: '+1 more', exact: true }).click();
    await expect(region.getByText('Waiting for your approval', { exact: true })).toBeVisible();
    await shot(info, 'expanded-pinned-stack', page);
    await region.getByRole('button', { name: 'Show less', exact: true }).click();
  }
  await region.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(region.getByText('Waiting for your approval', { exact: true })).toBeVisible();
});

