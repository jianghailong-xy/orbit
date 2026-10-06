import { test, expect } from '@playwright/test';
import { installFixedDate } from './fixtures.mjs';

const errors = new WeakMap();
const notices = (page) => page.locator('.toast-viewport');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const shot = (info, name, locator) => locator.screenshot({ animations: 'disabled' }).then((body) => info.attach(name, { body, contentType: 'image/png' }));

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


for (const kind of ['Dialog','Drawer','Bottom drawer']) test(`reference ${kind}`, async ({page},info) => {
 await button(page,'Error notice').click();
 await page.mouse.move(0,0);
 const before=await measure(notices(page));
 await shot(info,'before-overlay',notices(page));
 await button(page,`Open ${kind}`).click();
 await page.getByRole('dialog').focus();
 await page.mouse.move(0,0);
 const after=await measure(notices(page));
 await attach(info,'appearance',{before,after});
 await shot(info,'with-overlay',notices(page));
 await shot(info,'notification-and-overlay',page);
});
