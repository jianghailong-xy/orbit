# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts-hover.browser.mjs >> native stationary arrival pauses beyond six seconds and moving away resumes dismissal
- Location: ui-migration/toasts-hover.browser.mjs:41:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('region', { name: 'Notifications', exact: true })
Expected: 0
Received: 1
Timeout:  7500ms

Call log:
  - Expect "toHaveCount" getByRole('region', { name: 'Notifications', exact: true }) with timeout 7500ms
  - waiting for getByRole('region', { name: 'Notifications', exact: true })
    14 × locator resolved to 1 element
       - unexpected value "1"

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: dark
    - status "Location" [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button "Short notice" [ref=e9] [cursor=pointer]
      - button "Error notice" [ref=e11] [cursor=pointer]
      - button "Warning notice" [ref=e13] [cursor=pointer]
      - button "Complete session" [active] [ref=e15] [cursor=pointer]
      - button "Session result" [ref=e17] [cursor=pointer]
      - button "Session failure" [ref=e19] [cursor=pointer]
      - button "Clear notifications" [ref=e21] [cursor=pointer]
      - button "Switch theme" [ref=e23] [cursor=pointer]
      - button "Nested dialog" [ref=e25] [cursor=pointer]
      - button "Confirm save" [ref=e27] [cursor=pointer]
    - status "Undo count" [ref=e29]: "0"
    - button "Open Dialog" [ref=e30] [cursor=pointer]
    - button "Open Drawer" [ref=e32] [cursor=pointer]
    - button "Open Bottom drawer" [ref=e34] [cursor=pointer]
    - button "Open Retained dialog" [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic [ref=e40]: Session completed. Fix login redirect
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { expectExpired } from './toasts-checks.mjs';
  3   | 
  4   | const button = (page, name) => page.getByRole('button', { name, exact: true });
  5   | const region = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  6   | const undo = (page) => page.getByRole('button', { name: 'Undo completing Fix login redirect', exact: true });
  7   | const keyActivate = async (page, name) => { await button(page, name).focus(); await page.keyboard.press('Enter'); };
  8   | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  9   | 
  10  | test.beforeEach(async ({ page }) => {
  11  |   await page.goto('/ui-migration/toasts.html');
  12  |   await page.evaluate(() => document.fonts.ready);
  13  | });
  14  | 
  15  | // Measure with real notifications, clear them, then park in their future space.
  16  | // No hover() or mouse movement is used after the notification arrives.
  17  | async function parkBeforeArrival(page, pinned = false) {
  18  |   await button(page, 'Complete session').click();
  19  |   if (pinned) await keyActivate(page, 'Error notice');
  20  |   const rect = await undo(page).boundingBox();
  21  |   await page.mouse.move(0, 0);
  22  |   await keyActivate(page, 'Clear notifications');
  23  |   await expect(region(page)).toHaveCount(0);
  24  |   await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  25  |   await page.evaluate(() => {
  26  |     window.hoverEvents = [];
  27  |     for (const type of ['mousemove', 'mouseover', 'mouseout']) {
  28  |       document.addEventListener(type, (event) => window.hoverEvents.push({ type, at: Date.now(),
  29  |         target: event.target instanceof Element ? event.target.className : '',
  30  |         inResult: event.target instanceof Element && !!event.target.closest('.toast--card:not(.toast--attention)'),
  31  |       }), true);
  32  |     }
  33  |   });
  34  | }
  35  | 
  36  | async function enteredWithoutMoving(page) {
  37  |   await expect.poll(() => page.evaluate(() => window.hoverEvents.filter((e) => e.type === 'mouseover' && e.inResult).length)).toBeGreaterThan(0);
  38  |   expect(await page.evaluate(() => window.hoverEvents.filter((e) => e.type === 'mousemove'))).toEqual([]);
  39  | }
  40  | 
  41  | test('native stationary arrival pauses beyond six seconds and moving away resumes dismissal', async ({ page }, info) => {
  42  |   await parkBeforeArrival(page);
  43  |   await keyActivate(page, 'Complete session');
  44  |   await enteredWithoutMoving(page);
  45  |   const began = Date.now();
  46  |   await page.waitForTimeout(6500);
  47  |   const paused = { elapsedMs: Date.now() - began, remaining: await region(page).count(), events: await page.evaluate(() => window.hoverEvents) };
  48  |   await attach(info, 'native-stationary-arrival', paused);
  49  |   expect(paused.remaining).toBe(1);
  50  |   await info.attach('stationary-arrival', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  51  |   await page.mouse.move(0, 0);
  52  |   const released = Date.now();
> 53  |   await expect(region(page)).toHaveCount(0, { timeout: 7500 });
      |                              ^ Error: expect(locator).toHaveCount(expected) failed
  54  |   await attach(info, 'native-stationary-release', { elapsedMs: Date.now() - released, remaining: await region(page).count() });
  55  | });
  56  | 
  57  | test('stationary arrival stays paused across modal owners and clearing then replacing the feed', async ({ page }, info) => {
  58  |   await parkBeforeArrival(page);
  59  |   await keyActivate(page, 'Complete session');
  60  |   await enteredWithoutMoving(page);
  61  |   // Install the clock after the native boundary event has paused the dwell.
  62  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  63  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  64  |   for (const name of ['Open Dialog', 'Nested dialog']) {
  65  |     await keyActivate(page, name);
  66  |     await page.clock.runFor(10200);
  67  |     await expect(undo(page)).toBeVisible();
  68  |   }
  69  |   for (let i = 0; i < 2; i++) {
  70  |     await page.keyboard.press('Escape');
  71  |     await page.clock.runFor(10200);
  72  |     await expect(undo(page)).toBeVisible();
  73  |   }
  74  |   await keyActivate(page, 'Clear notifications');
  75  |   await expectExpired(page);
  76  |   await page.evaluate(() => { window.hoverEvents = []; });
  77  |   await keyActivate(page, 'Complete session');
  78  |   await page.clock.runFor(50);
  79  |   await enteredWithoutMoving(page);
  80  |   await page.clock.runFor(10000);
  81  |   await expect(undo(page)).toBeVisible();
  82  |   await page.mouse.move(0, 0);
  83  |   await page.clock.runFor(5999);
  84  |   await expect(undo(page)).toBeVisible();
  85  |   await page.clock.runFor(1);
  86  |   await expectExpired(page);
  87  |   await attach(info, 'stationary-replacement', { pausedAcrossFourTransfersMs: 40800, replacedFeedPausedMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  88  | });
  89  | 
  90  | test('layout moving a result under and away from a stationary pointer pauses and resumes dwell', async ({ page }, info) => {
  91  |   await parkBeforeArrival(page, true);
  92  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  93  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  94  |   await keyActivate(page, 'Complete session');
  95  |   await page.clock.runFor(2000);
  96  |   await keyActivate(page, 'Error notice');
  97  |   await page.clock.runFor(50);
  98  |   await enteredWithoutMoving(page);
  99  |   // Past the result's original deadline, before the phone error's six-second fold.
  100 |   await page.clock.runFor(4500);
  101 |   await expect(undo(page)).toBeVisible();
  102 |   const entered = await page.evaluate(() => window.hoverEvents);
  103 |   await page.evaluate(() => { window.hoverEvents = []; });
  104 |   await region(page).getByRole('button', { name: 'Dismiss', exact: true }).focus();
  105 |   await page.keyboard.press('Enter');
  106 |   // The pinned card occupies its slot until its 250ms visual exit finishes.
  107 |   await page.clock.runFor(300);
  108 |   await expect.poll(() => page.evaluate(() => window.hoverEvents.some((e) => e.type === 'mouseover' && !e.inResult))).toBe(true);
  109 |   const left = await page.evaluate(() => window.hoverEvents);
  110 |   expect(left.filter((e) => e.type === 'mousemove')).toEqual([]);
  111 |   const releaseAt = left.find((e) => e.type === 'mouseover' && !e.inResult).at;
  112 |   await page.clock.runFor(releaseAt + 5999 - await page.evaluate(() => Date.now()));
  113 |   await expect(undo(page)).toBeVisible();
  114 |   await page.clock.runFor(1);
  115 |   await expectExpired(page);
  116 |   await attach(info, 'stationary-layout', { entered, left, releaseAt, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  117 | });
  118 | 
```