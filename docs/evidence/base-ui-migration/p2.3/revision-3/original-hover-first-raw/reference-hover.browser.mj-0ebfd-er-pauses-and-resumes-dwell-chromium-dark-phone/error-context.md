# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: reference-hover.browser.mjs >> layout moving a result under and away from a stationary pointer pauses and resumes dwell
- Location: ../../../../tmp/orbit-p23-r3-reference/src/web/ui-migration/reference-hover.browser.mjs:89:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false

Call Log:
- Timeout 15000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: dark
    - status "Location" [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button "Short notice" [ref=e9] [cursor=pointer]
      - button "Error notice" [ref=e11] [cursor=pointer]
      - button "Warning notice" [ref=e13] [cursor=pointer]
      - button "Complete session" [ref=e15] [cursor=pointer]
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
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - region "Notifications":
    - generic [ref=e41]:
      - button "Open Fix login redirect" [ref=e45] [cursor=pointer]:
        - generic [ref=e46]: Session completed
        - generic [ref=e47]: Fix login redirect
      - button "Undo completing Fix login redirect" [ref=e48] [cursor=pointer]: Undo
```

# Test source

```ts
  6   | const keyActivate = async (page, name) => { await button(page, name).focus(); await page.keyboard.press('Enter'); };
  7   | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  8   | 
  9   | test.beforeEach(async ({ page }) => {
  10  |   await page.goto('/ui-migration/toasts.html');
  11  |   await page.evaluate(() => document.fonts.ready);
  12  | });
  13  | 
  14  | // Measure with real notifications, clear them, then park in their future space.
  15  | // No hover() or mouse movement is used after the notification arrives.
  16  | async function parkBeforeArrival(page, pinned = false) {
  17  |   await button(page, 'Complete session').click();
  18  |   if (pinned) await keyActivate(page, 'Error notice');
  19  |   const rect = await undo(page).boundingBox();
  20  |   await page.mouse.move(0, 0);
  21  |   await keyActivate(page, 'Clear notifications');
  22  |   await expect(region(page)).toHaveCount(0);
  23  |   await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  24  |   await page.evaluate(() => {
  25  |     window.hoverEvents = [];
  26  |     for (const type of ['mousemove', 'mouseover', 'mouseout']) {
  27  |       document.addEventListener(type, (event) => window.hoverEvents.push({ type, at: Date.now(),
  28  |         target: event.target instanceof Element ? event.target.className : '',
  29  |         inResult: event.target instanceof Element && !!event.target.closest('.toast--card:not(.toast--attention)'),
  30  |       }), true);
  31  |     }
  32  |   });
  33  | }
  34  | 
  35  | async function enteredWithoutMoving(page) {
  36  |   await expect.poll(() => page.evaluate(() => window.hoverEvents.filter((e) => e.type === 'mouseover' && e.inResult).length)).toBeGreaterThan(0);
  37  |   expect(await page.evaluate(() => window.hoverEvents.filter((e) => e.type === 'mousemove'))).toEqual([]);
  38  | }
  39  | 
  40  | test('native stationary arrival pauses beyond six seconds and moving away resumes dismissal', async ({ page }, info) => {
  41  |   await parkBeforeArrival(page);
  42  |   await keyActivate(page, 'Complete session');
  43  |   await enteredWithoutMoving(page);
  44  |   const began = Date.now();
  45  |   await page.waitForTimeout(6500);
  46  |   const paused = { elapsedMs: Date.now() - began, remaining: await region(page).count(), events: await page.evaluate(() => window.hoverEvents) };
  47  |   await attach(info, 'native-stationary-arrival', paused);
  48  |   expect(paused.remaining).toBe(1);
  49  |   await info.attach('stationary-arrival', { body: await page.screenshot({ animations: 'allow' }), contentType: 'image/png' });
  50  |   await page.mouse.move(0, 0);
  51  |   const released = Date.now();
  52  |   await expect(region(page)).toHaveCount(0, { timeout: 7500 });
  53  |   await attach(info, 'native-stationary-release', { elapsedMs: Date.now() - released, remaining: await region(page).count() });
  54  | });
  55  | 
  56  | test('stationary arrival stays paused across modal owners and clearing then replacing the feed', async ({ page }, info) => {
  57  |   await parkBeforeArrival(page);
  58  |   await keyActivate(page, 'Complete session');
  59  |   await enteredWithoutMoving(page);
  60  |   // Install the clock after the native boundary event has paused the dwell.
  61  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  62  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  63  |   for (const name of ['Open Dialog', 'Nested dialog']) {
  64  |     await keyActivate(page, name);
  65  |     await page.clock.runFor(10200);
  66  |     await expect(undo(page)).toBeVisible();
  67  |   }
  68  |   for (let i = 0; i < 2; i++) {
  69  |     await page.keyboard.press('Escape');
  70  |     await page.clock.runFor(10200);
  71  |     await expect(undo(page)).toBeVisible();
  72  |   }
  73  |   await keyActivate(page, 'Clear notifications');
  74  |   await expect(region(page)).toHaveCount(0);
  75  |   await page.evaluate(() => { window.hoverEvents = []; });
  76  |   await keyActivate(page, 'Complete session');
  77  |   await page.clock.runFor(50);
  78  |   await enteredWithoutMoving(page);
  79  |   await page.clock.runFor(10000);
  80  |   await expect(undo(page)).toBeVisible();
  81  |   await page.mouse.move(0, 0);
  82  |   await page.clock.runFor(5999);
  83  |   await expect(undo(page)).toBeVisible();
  84  |   await page.clock.runFor(1);
  85  |   await expect(region(page)).toHaveCount(0);
  86  |   await attach(info, 'stationary-replacement', { pausedAcrossFourTransfersMs: 40800, replacedFeedPausedMs: 10000, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  87  | });
  88  | 
  89  | test('layout moving a result under and away from a stationary pointer pauses and resumes dwell', async ({ page }, info) => {
  90  |   await parkBeforeArrival(page, true);
  91  |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  92  |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  93  |   await keyActivate(page, 'Complete session');
  94  |   await page.clock.runFor(2000);
  95  |   await keyActivate(page, 'Error notice');
  96  |   await page.clock.runFor(50);
  97  |   await enteredWithoutMoving(page);
  98  |   // Past the result's original deadline, before the phone error's six-second fold.
  99  |   await page.clock.runFor(4500);
  100 |   await expect(undo(page)).toBeVisible();
  101 |   const entered = await page.evaluate(() => window.hoverEvents);
  102 |   await page.evaluate(() => { window.hoverEvents = []; });
  103 |   await region(page).getByRole('button', { name: 'Dismiss', exact: true }).focus();
  104 |   await page.keyboard.press('Enter');
  105 |   await page.clock.runFor(50);
> 106 |   await expect.poll(() => page.evaluate(() => window.hoverEvents.some((e) => e.type === 'mouseover' && !e.inResult))).toBe(true);
      |                                                                                                                       ^ Error: expect(received).toBe(expected) // Object.is equality
  107 |   const left = await page.evaluate(() => window.hoverEvents);
  108 |   expect(left.filter((e) => e.type === 'mousemove')).toEqual([]);
  109 |   const releaseAt = left.find((e) => e.type === 'mouseover' && !e.inResult).at;
  110 |   await page.clock.runFor(releaseAt + 5999 - await page.evaluate(() => Date.now()));
  111 |   await expect(undo(page)).toBeVisible();
  112 |   await page.clock.runFor(1);
  113 |   await expect(region(page)).toHaveCount(0);
  114 |   await attach(info, 'stationary-layout', { entered, left, releaseAt, visibleAfterReleaseMs: 5999, expiredAfterReleaseMs: 6000 });
  115 | });
  116 | 
```