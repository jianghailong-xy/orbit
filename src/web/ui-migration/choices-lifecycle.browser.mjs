import { test, expect } from '@playwright/test';
import { armScrollUnlock, readScrollUnlock, scrollPage } from './choices-scroll-observation.mjs';

const fixture = '/ui-migration/choices.html';
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function settle(locator) {
  await expect(locator).toBeVisible();
  await locator.evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
}

async function activate(locator, info) {
  if (info.project.use.hasTouch) await locator.tap();
  else await locator.click();
}

async function watchExit(locator) {
  await locator.evaluate((node) => {
    const record = { frames: [], active: true };
    window.choiceExit = record;
    const frame = () => {
      if (node.hasAttribute('data-closed')) {
        const style = getComputedStyle(node);
        record.frames.push({ connected: node.isConnected, opacity: Number(style.opacity), pointerEvents: style.pointerEvents,
          visible: !!node.getClientRects().length && style.visibility !== 'hidden' });
      }
      if (record.active) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

async function closed(page, locator, motion) {
  await expect(locator).not.toBeVisible();
  const frames = await page.evaluate(() => { window.choiceExit.active = false; return window.choiceExit.frames; });
  if (motion === 'no-preference') {
    expect(frames.some((frame) => frame.connected && frame.visible && frame.opacity > 0 && frame.opacity < 1)).toBe(true);
    expect(frames.filter((frame) => frame.visible).every((frame) => frame.pointerEvents === 'none')).toBe(true);
  }
  return frames;
}

for (const motion of ['no-preference', 'reduce']) test(`${motion} Dialog Popover Select exits restore one layer at a time`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: motion });
  await page.goto(fixture);
  const trigger = page.getByRole('button', { name: 'Open Dialog', exact: true });
  await activate(trigger, info);
  const dialog = page.getByRole('dialog', { name: 'Share workspace', exact: true });
  await settle(dialog);
  const context = dialog.getByRole('button', { name: 'Open context', exact: true });
  await activate(context, info);
  const popover = page.getByRole('dialog', { name: 'Context', exact: true });
  await settle(popover);
  const select = popover.getByRole('combobox', { name: 'Context expiry', exact: true });
  await activate(select, info);
  const popup = page.locator('.orbit-select-popup:visible');
  await settle(popup);
  const geometry = await popup.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const points = [[box.x + 8, box.y + 8], [box.right - 8, box.bottom - 8]];
    return { box: box.toJSON(), inPopover: !!node.closest('.orbit-popover'), inDialog: !!node.closest('.orbit-dialog'),
      cornersHitPopup: points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))),
      animationName: getComputedStyle(node).animationName };
  });
  expect(geometry.inPopover).toBe(true);
  expect(geometry.inDialog).toBe(true);
  expect(geometry.cornersHitPopup).toBe(true);
  if (motion === 'reduce') expect(geometry.animationName).toBe('none');
  await info.attach('nested-open', { body: await page.screenshot(), contentType: 'image/png' });
  // Select may retain its hidden positioner after exit; assert visibility as well as focus.
  const selectPopup = page.locator('.orbit-select-popup');
  await watchExit(selectPopup);
  await page.keyboard.press('Escape');
  const selectExit = await closed(page, selectPopup, motion);
  await expect(select).toBeFocused();
  await expect(popover).toBeVisible();
  await expect(dialog).toBeVisible();
  await watchExit(popover);
  await page.keyboard.press('Escape');
  const popoverExit = await closed(page, popover, motion);
  await expect(context).toBeFocused();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => /hidden|clip/.test(getComputedStyle(node).overflowY)))).toBe(true);
  await armScrollUnlock(dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  const unlock = await readScrollUnlock(page);
  await info.attach('scroll-unlock', { body: JSON.stringify(unlock, null, 2), contentType: 'application/json' });
  const scroll = await scrollPage(page, info);
  await info.attach('page-scroll', { body: JSON.stringify(scroll, null, 2), contentType: 'application/json' });
  expect(unlock.closedAfterMs).not.toBeNull();
  expect(unlock.unlockedAfterMs).not.toBeNull();
  expect(unlock.readyAfterCloseMs).not.toBeNull();
  expect(unlock.readyAfterCloseMs).toBeLessThanOrEqual(unlock.limitMs);
  expect(unlock.finalRead.locked).toBe(false);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewportHeight);
  expect(scroll.input?.trusted).toBe(true);
  expect(scroll.input?.kind).toBe(info.project.use.isMobile ? 'PageDown' : 'wheel');
  expect(scroll.movedAfterMs).not.toBeNull();
  expect(scroll.movedAfterMs).toBeLessThanOrEqual(scroll.limitMs);
  expect(scroll.after).toBeGreaterThan(scroll.before);
  await expect(trigger).toBeFocused();
  await info.attach('nested-lifecycle', { body: JSON.stringify({ motion, geometry, selectExit, popoverExit, focusReturned: true, scrollUnlocked: true }, null, 2), contentType: 'application/json' });
});

for (const kind of ['attachment', 'expiry', 'search', 'multiple', 'popover', 'tooltip']) test(`reduced motion ${kind} has no transition and dismisses cleanly`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search', 'multiple'].includes(kind) ? 'combobox' : 'button');
  if (kind === 'tooltip') await trigger.focus();
  else await activate(trigger, info);
  const popup = page.locator('.sample-surface');
  await settle(popup);
  const styles = await popup.evaluate((node) => ({ animation: getComputedStyle(node).animationName,
    transitionDuration: getComputedStyle(node).transitionDuration, running: node.getAnimations().length }));
  expect(styles).toEqual({ animation: 'none', transitionDuration: '0s', running: 0 });
  await page.keyboard.press('Escape');
  await expect(popup).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await info.attach('reduced-motion', { body: JSON.stringify({ kind, styles, dismissed: true, focusReturned: true }), contentType: 'application/json' });
});

for (const kind of ['attachment', 'expiry', 'search', 'popover']) test(`normal ${kind} can reopen during exit without stale unmount`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${fixture}?sample=${kind}&system=orbit`);
  const trigger = page.getByRole('region', { name: 'Appearance sample' }).getByRole(['expiry', 'search'].includes(kind) ? 'combobox' : 'button');
  await activate(trigger, info);
  const popup = page.locator('.sample-surface');
  await settle(popup);
  await page.keyboard.press('Escape');
  await expect(popup).toHaveAttribute('data-closed', '');
  await activate(trigger, info);
  await expect(popup).toHaveAttribute('data-open', '');
  await settle(popup);
  await expect(popup).toBeVisible();
  if (kind === 'attachment') await activate(page.getByRole('menuitem', { name: 'File', exact: true }), info);
  else if (['expiry', 'search'].includes(kind)) {
    await activate(page.getByRole('option', { name: '7 days', exact: true }), info);
    if (kind === 'expiry') await expect(trigger).toHaveText('7 days');
    else {
      await expect(trigger).toHaveAccessibleDescription('7 days');
      await expect(page.locator('.orbit-combobox-value')).toHaveText('7 days');
      await expect(trigger).toHaveValue('');
    }
  } else if (info.project.use.hasTouch) await page.touchscreen.tap(3, 60);
  else await page.mouse.click(3, 60);
  await expect(popup).not.toBeVisible();
  await info.attach('reopen', { body: JSON.stringify({ kind, input: info.project.use.hasTouch ? 'touch' : 'mouse', reopenedDuringExit: true, subsequentActionClosed: true }), contentType: 'application/json' });
});
