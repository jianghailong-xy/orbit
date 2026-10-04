import { test, expect } from '@playwright/test';
import { expectExpired } from './toasts-checks.mjs';
import { installFixedDate } from './fixtures.mjs';

const errors = new WeakMap();
const notices = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
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
    const dismiss = region.getByRole('button', { name: 'Dismiss', exact: true });
    await keyboardReach(page, dismiss, dialog);
    await page.keyboard.press('Enter');
    await expect(region).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await attach(info, 'keyboard', { dismissReachedByTab: true, enterDismissedOnlyNotification: true, escapeClosedOverlay: true, focusReturned: true });
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

test('short and lifecycle dwell, hover restart, phone folding and permanent warnings keep their rules', async ({ page }, info) => {
  // This test measures timer contracts, not native browser performance.
  await page.clock.install({ time: new Date('2026-09-28T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-28T12:00:01Z'));
  await button(page, 'Short notice').click();
  await page.clock.runFor(2999);
  await expect(notices(page).getByText('Link copied', { exact: true })).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await button(page, 'Complete session').click();
  await page.clock.runFor(5999);
  await expect(notices(page).getByText('Session completed', { exact: true })).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await button(page, 'Complete session').click();
  await notices(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  await page.clock.runFor(10000);
  await expect(notices(page).getByText('Session completed', { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5999);
  await expect(notices(page).getByText('Session completed', { exact: true })).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await button(page, 'Warning notice').click();
  await page.clock.runFor(6000);
  if (info.project.use.isMobile) {
    await expect(notices(page).getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
    await shot(info, 'folded-warning', page);
    await notices(page).getByRole('button', { name: 'Waiting for your approval', exact: true }).click();
    await expect(notices(page).getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  }
  await page.clock.runFor(60000);
  await expect(notices(page).getByText('Waiting for your approval', { exact: true })).toBeVisible();
  await attach(info, 'timers', { shortMs: 3000, actionMs: 6000, hoverHeldMs: 10000, fullDwellRestarted: true, warningStillPresentAfterMs: 66000, phoneFolds: !!info.project.use.isMobile });
});

test('event and entity deduplication, Undo and session navigation retain the business boundary', async ({ page }, info) => {
  await button(page, 'Short notice').dblclick();
  await expect(notices(page).getByText('Link copied', { exact: true })).toHaveCount(1);
  await button(page, 'Clear notifications').click();
  await button(page, 'Session failure').click();
  await button(page, 'Session failure').click();
  await expect(notices(page).getByText("Couldn't merge into main", { exact: true })).toHaveCount(1);
  await button(page, 'Session result').click();
  await expect(notices(page).getByText("Couldn't merge into main", { exact: true })).toHaveCount(0);
  await expect(notices(page).getByText('Merged into main', { exact: true })).toHaveCount(1);
  await button(page, 'Clear notifications').click();
  const trigger = button(page, 'Open Dialog');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Workspace editor', exact: true });
  await dialog.getByRole('button', { name: 'Complete session', exact: true }).click();
  const undo = notices(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true });
  await keyboardReach(page, undo, dialog);
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Undo count', { exact: true })).toHaveText('1');
  await expect(notices(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Session result', exact: true }).click();
  const jump = notices(page).getByRole('button', { name: 'Merged into main Fix login redirect', exact: true });
  if (info.project.use.hasTouch) await jump.tap(); else await jump.click();
  await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
  await expect(notices(page)).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await attach(info, 'actions', { duplicateSuppressed: true, eventFailureReplacedBySuccess: true, undoCount: 1, sessionPath: new URL(page.url()).pathname, pointer: info.project.use.hasTouch ? 'touch' : 'mouse' });
});

test('copyable diagnostics and live announcements survive nested overlays and theme changes', async ({ page }, info) => {
  // Clipboard writes are intercepted; selection and the user's Copy error click are real.
  await page.evaluate(() => {
    window.copiedDiagnostic = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedDiagnostic = text; } } });
  });
  await button(page, 'Open Drawer').click();
  const parent = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  await parent.getByRole('button', { name: 'Error notice', exact: true }).click();
  const live = page.locator('[aria-live="assertive"]');
  await expect(live).toHaveText("Couldn't save the schedule. revision 12 is stale");
  expect(await live.evaluate((el) => el.closest('[aria-hidden="true"], [inert]') === null)).toBe(true);
  await parent.getByRole('button', { name: 'Nested dialog', exact: true }).click();
  const child = page.getByRole('dialog', { name: 'Nested editor', exact: true });
  await expect(notices(page)).toBeVisible();
  const copy = notices(page).getByRole('button', { name: 'Copy error', exact: true });
  await keyboardReach(page, copy, child);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.copiedDiagnostic)).toBe('revision 12 is stale');
  await notices(page).getByText('revision 12 is stale', { exact: true }).evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('revision 12 is stale');
  const original = await notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background);
  await child.getByRole('button', { name: 'Switch theme', exact: true }).click();
  await expect.poll(() => notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background)).not.toBe(original);
  await page.mouse.move(0, 0);
  await child.focus();
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await shot(info, 'nested-toast-opposite-theme', page);
  await page.keyboard.press('Escape');
  await expect(child).not.toBeVisible();
  await expect(parent).toBeVisible();
  await expect(notices(page)).toBeVisible();
  await parent.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  await parent.getByRole('button', { name: 'Short notice', exact: true }).click();
  await expect(page.locator('[aria-live="polite"]')).toHaveText('Link copied');
  await page.keyboard.press('Escape');
  await expect(parent).not.toBeVisible();
  await expect(notices(page).getByText('Link copied', { exact: true })).toBeVisible();
  await attach(info, 'accessibility', { assertiveErrorAndDetail: true, liveRegionNotHidden: true, politeSuccess: true, copyText: 'revision 12 is stale', selectedDiagnostic: true, notificationSurvivesEachOverlayClose: true, themeChangedWhileOpen: true });
});

test('async confirmation keeps pending locks, accessible failure feedback and successful retry', async ({ page }, info) => {
  let requests = 0;
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  await page.route('**/__toast-confirm', async (route) => {
    requests++;
    if (requests === 1) { await pending; await route.fulfill({ status: 409, body: '{}' }); }
    else await route.fulfill({ status: 200, body: '{}' });
  });
  await button(page, 'Confirm save').click();
  const confirmation = page.getByRole('alertdialog', { name: 'Save schedule?', exact: true });
  await confirmation.getByRole('button', { name: 'Save', exact: true }).dblclick();
  await expect(confirmation).toHaveAttribute('aria-busy', 'true');
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(requests).toBe(1);
  await shot(info, 'confirm-pending', page);
  complete();
  await expect(confirmation.getByRole('alert')).toHaveText('revision 12 is stale');
  await expect(notices(page)).toBeVisible();
  await shot(info, 'confirm-failure-notification', page);
  const dismiss = notices(page).getByRole('button', { name: 'Dismiss', exact: true });
  await keyboardReach(page, dismiss, confirmation);
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(notices(page).getByText('Schedule saved', { exact: true })).toBeVisible();
  await expect(button(page, 'Confirm save')).toBeFocused();
  expect(requests).toBe(2);
  await attach(info, 'confirmation', { requests, pendingCancelDisabled: true, pendingEscapeIgnored: true, failureRetained: true, toastDismissDidNotCancel: true, retrySucceeded: true, focusReturned: true });
});

test('legacy AntApp confirmation still works with the same notification service', async ({ page }, info) => {
  await button(page, 'Legacy confirm').click();
  const legacy = page.getByRole('dialog', { name: 'Legacy confirmation', exact: true });
  await expect(legacy).toBeVisible();
  await legacy.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(legacy).not.toBeVisible();
  await expect(notices(page).getByText('Legacy confirmed', { exact: true })).toBeVisible();
  await shot(info, 'legacy-confirmed', page);
});

test('retained closed overlays release notifications and normal motion settles at the original origin', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const finishAnimations = () => page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  });
  await button(page, 'Error notice').click();
  await finishAnimations();
  await page.mouse.move(0, 0);
  const before = await measure(notices(page));
  const trigger = button(page, 'Open Retained dialog');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Retained editor', exact: true });
  await expect(dialog).toBeFocused();
  await page.mouse.move(0, 0);
  await finishAnimations();
  expect(await measure(notices(page))).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await finishAnimations();
  await expect(notices(page)).toBeVisible();
  expect(await measure(notices(page))).toEqual(before);
  await notices(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notices(page)).toHaveCount(0);
  await trigger.click();
  await expect(dialog).toBeVisible();
  await finishAnimations();
  await dialog.getByRole('button', { name: 'Warning notice', exact: true }).click();
  await finishAnimations();
  await expect(notices(page)).toBeVisible();
  await shot(info, 'retained-reopened-with-motion', page);
  await attach(info, 'retained-and-motion', { visibleAfterClose: true, sameSettledGeometry: true, reopenedAcceptsNewNotifications: true });
});

test('notification origin follows viewport resize across the phone breakpoint', async ({ page }, info) => {
  await button(page, 'Error notice').click();
  const measurements = [];
  for (const width of [599, 601]) {
    await page.setViewportSize({ width, height: 900 });
    await page.mouse.move(0, 0);
    const before = await measure(notices(page));
    await button(page, 'Open Drawer').click();
    const drawer = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
    await expect(drawer).toBeVisible();
    await page.mouse.move(0, 0);
    await expect.poll(() => measure(notices(page))).toEqual(before);
    measurements.push({ width, before, after: await measure(notices(page)) });
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  }
  await attach(info, 'responsive-origin', measurements);
});
