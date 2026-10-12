import { test, expect } from '@playwright/test';
import { expectExpired } from './toasts-checks.mjs';

const button = (page, name) => page.getByRole('button', { name, exact: true });
const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
const undo = (page) => page.getByRole('button', { name: 'Undo completing Fix login redirect', exact: true });
const keyActivate = async (page, name) => { await button(page, name).focus(); await page.keyboard.press('Enter'); };
const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });

test.beforeEach(async ({ page }) => {
  await page.goto('/ui-migration/toasts.html');
  await page.evaluate(() => document.fonts.ready);
});

// Measure with real notifications, clear them, then park in their future space.
// No hover() or mouse movement is used after the notification arrives.
async function parkBeforeArrival(page, pinned = false) {
  await button(page, 'Complete session').click();
  if (pinned) await keyActivate(page, 'Error notice');
  const rect = await undo(page).boundingBox();
  await page.mouse.move(0, 0);
  await keyActivate(page, 'Clear notifications');
  await expect(region(page)).toHaveCount(0);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.evaluate(() => {
    window.hoverEvents = [];
    for (const type of ['mousemove', 'mouseover', 'mouseout']) {
      document.addEventListener(type, (event) => window.hoverEvents.push({ type, at: Date.now(),
        target: event.target instanceof Element ? event.target.className : '',
        inResult: event.target instanceof Element && !!event.target.closest('.toast--card:not(.toast--attention)'),
      }), true);
    }
  });
}

async function enteredWithoutMoving(page) {
  await expect.poll(() => page.evaluate(() => window.hoverEvents.filter((e) => e.type === 'mouseover' && e.inResult).length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.hoverEvents.filter((e) => e.type === 'mousemove'))).toEqual([]);
}

test('native stationary arrival pauses beyond six seconds and moving away resumes dismissal', async ({ page }, info) => {
  await parkBeforeArrival(page);
  await keyActivate(page, 'Complete session');
  await enteredWithoutMoving(page);
  const began = Date.now();
  await page.waitForTimeout(6500);
  const paused = { elapsedMs: Date.now() - began, remaining: await region(page).count(), events: await page.evaluate(() => window.hoverEvents) };
  await attach(info, 'native-stationary-arrival', paused);
  expect(paused.remaining).toBe(1);
  await info.attach('stationary-arrival', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  await page.mouse.move(0, 0);
  const released = Date.now();
  await expect(region(page)).toHaveCount(0, { timeout: 7500 });
  await attach(info, 'native-stationary-release', { elapsedMs: Date.now() - released, remaining: await region(page).count() });
});

test('stationary arrival stays paused across modal owners and clearing then replacing the feed', async ({ page }, info) => {
  await parkBeforeArrival(page);
  await keyActivate(page, 'Complete session');
  await enteredWithoutMoving(page);
  // Install the clock after the native boundary event has paused the dwell.
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  for (const name of ['Open Dialog', 'Nested dialog']) {
    await keyActivate(page, name);
    await page.clock.runFor(10200);
    await expect(undo(page)).toBeVisible();
  }
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Escape');
    await page.clock.runFor(10200);
    await expect(undo(page)).toBeVisible();
  }
  await keyActivate(page, 'Clear notifications');
  await expectExpired(page);
  await page.evaluate(() => { window.hoverEvents = []; });
  await keyActivate(page, 'Complete session');
  await page.clock.runFor(50);
  await enteredWithoutMoving(page);
  await page.clock.runFor(10000);
  await expect(undo(page)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(5999);
  await expect(undo(page)).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await attach(info, 'stationary-replacement', { pausedAcrossFourTransfersMs: 40800, replacedFeedPausedMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
});

test('layout moving a result under and away from a stationary pointer pauses and resumes dwell', async ({ page }, info) => {
  await parkBeforeArrival(page, true);
  await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  await keyActivate(page, 'Complete session');
  await page.clock.runFor(2000);
  await keyActivate(page, 'Error notice');
  await page.clock.runFor(50);
  await enteredWithoutMoving(page);
  // Past the result's original deadline, before the phone error's six-second fold.
  await page.clock.runFor(4500);
  await expect(undo(page)).toBeVisible();
  const entered = await page.evaluate(() => window.hoverEvents);
  await page.evaluate(() => { window.hoverEvents = []; });
  await region(page).getByRole('button', { name: 'Dismiss', exact: true }).focus();
  await page.keyboard.press('Enter');
  // The pinned card occupies its slot until its 250ms visual exit finishes.
  await page.clock.runFor(300);
  await expect.poll(() => page.evaluate(() => window.hoverEvents.some((e) => e.type === 'mouseover' && !e.inResult))).toBe(true);
  const left = await page.evaluate(() => window.hoverEvents);
  expect(left.filter((e) => e.type === 'mousemove')).toEqual([]);
  const releaseAt = left.find((e) => e.type === 'mouseover' && !e.inResult).at;
  await page.clock.runFor(releaseAt + 5999 - await page.evaluate(() => Date.now()));
  await expect(undo(page)).toBeVisible();
  await page.clock.runFor(1);
  await expectExpired(page);
  await attach(info, 'stationary-layout', { entered, left, releaseAt, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
});
