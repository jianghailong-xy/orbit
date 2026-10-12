import { test, expect } from '@playwright/test';

// Diagnosis, not part of the matrix: the steps of the matrix test 'copyable diagnostics and live
// announcements survive nested overlays and theme changes' up to its 'nested-toast-opposite-theme'
// screenshot (Drawer, Error notice, nested dialog, Copy error by keyboard, select the diagnostic, switch
// the theme with the selection active, clear it). Then the same notification after a forced full
// repaint (viewport 1px narrower and back): if the first screenshot still shows the highlight, the
// compositor kept a stale paint.
const button = (page, name) => page.getByRole('button', { name, exact: true });
const notices = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
async function keyboardReach(page, target) {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
}
for (const theme of [false, true]) {
  test(`cleared selection repaints in a nested dialog (theme switch while selected: ${theme})`, async ({ page }, info) => {
    await page.goto('/ui-migration/toasts.html');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); });
    await button(page, 'Open Drawer').click();
    const parent = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
    await parent.getByRole('button', { name: 'Error notice', exact: true }).click();
    await parent.getByRole('button', { name: 'Nested dialog', exact: true }).click();
    const child = page.getByRole('dialog', { name: 'Nested editor', exact: true });
    await expect(notices(page)).toBeVisible();
    await keyboardReach(page, notices(page).getByRole('button', { name: 'Copy error', exact: true }));
    await page.keyboard.press('Enter');
    await notices(page).getByText('revision 12 is stale', { exact: true }).evaluate((el) => {
      const range = document.createRange(); range.selectNodeContents(el);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    if (theme) {
      const original = await notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background);
      await child.getByRole('button', { name: 'Switch theme', exact: true }).click();
      await expect.poll(() => notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background)).not.toBe(original);
    }
    await page.mouse.move(0, 0);
    await child.focus();
    await page.evaluate(() => window.getSelection().removeAllRanges());
    const cleared = await page.screenshot({ animations: 'disabled' });
    const size = page.viewportSize();
    await page.setViewportSize({ width: size.width - 1, height: size.height });
    await page.setViewportSize(size);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const repainted = await page.screenshot({ animations: 'disabled' });
    await info.attach('selection', { body: JSON.stringify({ where: `nested, theme switch ${theme}`, selectedDiffers: true, clearedEqualsBefore: cleared.equals(repainted), laterEqualsBefore: cleared.equals(repainted) }), contentType: 'application/json' });
    await info.attach('cleared', { body: cleared, contentType: 'image/png' });
    await info.attach('repainted', { body: repainted, contentType: 'image/png' });
  });
}
