import { test, expect } from '@playwright/test';
import { installFixedDate } from '../../../../../src/web/ui-migration/fixtures.mjs';

// Read-only probe for the absorbed upstream change 627989805: a failure toast's own copy is the way
// into its session (no separate "Open session" button). It runs that card inside the P2.3
// notification host while an Orbit Dialog owns focus, by pointer/touch and by keyboard.
const notices = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });

async function openFailureInDialog(page, info) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installFixedDate(page);
  await page.goto('/ui-migration/toasts.html');
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  await button(page, 'Open Dialog').click();
  const dialog = page.getByRole('dialog', { name: 'Workspace editor', exact: true });
  await expect(dialog).toBeVisible();
  await button(dialog, 'Session failure').click();
  const region = notices(page);
  const card = region.locator('.toast--attention');
  await expect(card).toHaveCount(1);
  const link = button(region, 'Open Fix login redirect');
  await expect(link).toBeVisible();
  await expect(button(region, 'Open session')).toHaveCount(0);
  expect(await card.locator('.toast-actions button').allTextContents()).toEqual(['Copy error']);
  const observed = await link.evaluate((el) => ({
    inDialog: !!el.closest('[role="dialog"]'), inOverlay: !!el.closest('.orbit-overlay'),
    rect: el.getBoundingClientRect().toJSON(), cursor: getComputedStyle(el).cursor,
  }));
  await page.mouse.move(0, 0);
  await info.attach('failure-card', { body: await region.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
  return { dialog, region, link, errors, observed };
}

async function opened(page, info, dialog, region, errors, observed, how) {
  await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
  await expect(page.getByLabel('Location', { exact: true })).toHaveText(new URL(page.url()).pathname);
  await expect(region).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(errors).toEqual([]);
  await info.attach('attention-link', { body: JSON.stringify({ how, ...observed, path: new URL(page.url()).pathname }, null, 2),
    contentType: 'application/json' });
}

test('failure copy link opens its session from a Dialog-owned notification by pointer', async ({ page }, info) => {
  const { dialog, region, link, errors, observed } = await openFailureInDialog(page, info);
  const how = info.project.use.hasTouch ? 'tap' : 'click';
  if (how === 'tap') await link.tap(); else await link.click();
  await opened(page, info, dialog, region, errors, observed, how);
});

test('failure copy link is reached with Tab inside the Dialog and opens its session with Enter', async ({ page }, info) => {
  const { dialog, region, link, errors, observed } = await openFailureInDialog(page, info);
  let presses = 0;
  for (; presses < 30; presses++) {
    if (await link.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'focus stays with the active modal and its notifications').toBe(true);
  }
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await opened(page, info, dialog, region, errors, { ...observed, tabPresses: presses }, 'keyboard');
});
