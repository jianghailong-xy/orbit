# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: coordinator-feedback.browser.mjs >> existing notification stays at viewport origin during Bottom drawer entry
- Location: src/web/ui-migration/coordinator-feedback.browser.mjs:10:3

# Error details

```
Error: an existing notification should not move with the newly opening modal

expect(received).toHaveLength(expected)

Expected length: 0
Received length: 19
Received array:  [{"card": {"bottom": 1044, "height": 128, "left": 920, "right": 1280, "top": 916, "width": 360, "x": 920, "y": 916}, "height": 128, "insideViewport": false, "scale": "none", "t": 60, "translate": "0px 100%", "width": 360, "x": 904, "y": 916}, {"card": {"bottom": 1044, "height": 128, "left": 914.0778198242188, "right": 1274.077880859375, "top": 916, "width": 360.00006103515625, "x": 914.0778198242188, "y": 916}, "height": 128, "insideViewport": false, "scale": "none", "t": 69.09999999403954, "translate": "0px 100%", "width": 360, "x": 904, "y": 916}, {"card": {"bottom": 1036.61474609375, "height": 128.00006103515625, "left": 909.604736328125, "right": 1269.604736328125, "top": 908.6146850585938, "width": 360, "x": 909.604736328125, "y": 908.6146850585938}, "height": 128.00006103515625, "insideViewport": false, "scale": "none", "t": 83, "translate": "0px 96.1753%", "width": 360, "x": 904, "y": 908.6146850585938}, {"card": {"bottom": 1022.2435913085938, "height": 128, "left": 907.1464233398438, "right": 1267.146484375, "top": 894.2435913085938, "width": 360.00006103515625, "x": 907.1464233398438, "y": 894.2435913085938}, "height": 128, "insideViewport": false, "scale": "none", "t": 99.59999999403954, "translate": "0px 88.7327%", "width": 360, "x": 904, "y": 894.2435913085938}, {"card": {"bottom": 1001.3320922851562, "height": 128, "left": 905.83056640625, "right": 1265.83056640625, "top": 873.3320922851562, "width": 360, "x": 905.83056640625, "y": 873.3320922851562}, "height": 128, "insideViewport": false, "scale": "none", "t": 116.30000001192093, "translate": "0px 77.903%", "width": 360, "x": 904, "y": 873.3320922851562}, {"card": {"bottom": 977.2203369140625, "height": 128, "left": 905.0750732421875, "right": 1265.0750732421875, "top": 849.2203369140625, "width": 360, "x": 905.0750732421875, "y": 849.2203369140625}, "height": 128, "insideViewport": false, "scale": "none", "t": 133, "translate": "0px 65.4159%", "width": 360, "x": 904, "y": 849.2203369140625}, {"card": {"bottom": 953.5765991210938, "height": 128, "left": 904.6130981445312, "right": 1264.613037109375, "top": 825.5765991210938, "width": 359.99993896484375, "x": 904.6130981445312, "y": 825.5765991210938}, "height": 128, "insideViewport": false, "scale": "none", "t": 149.69999998807907, "translate": "0px 53.1712%", "width": 360, "x": 904, "y": 825.5765991210938}, {"card": {"bottom": 932.872314453125, "height": 128, "left": 904.3291015625, "right": 1264.3291015625, "top": 804.872314453125, "width": 360, "x": 904.3291015625, "y": 804.872314453125}, "height": 128, "insideViewport": false, "scale": "none", "t": 166.40000000596046, "translate": "0px 42.4488%", "width": 360, "x": 904, "y": 804.872314453125}, {"card": {"bottom": 915.25244140625, "height": 128, "left": 904.1544189453125, "right": 1264.1544189453125, "top": 787.25244140625, "width": 360, "x": 904.1544189453125, "y": 787.25244140625}, "height": 128, "insideViewport": false, "scale": "none", "t": 183, "translate": "0px 33.3238%", "width": 360, "x": 904, "y": 787.25244140625}, {"card": {"bottom": 900.8809204101562, "height": 128, "left": 904.0564575195312, "right": 1264.0565185546875, "top": 772.8809204101562, "width": 360.00006103515625, "x": 904.0564575195312, "y": 772.8809204101562}, "height": 128, "insideViewport": false, "scale": "none", "t": 199.59999999403954, "translate": "0px 25.881%", "width": 360, "x": 904, "y": 772.8809204101562}, …]
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading [level=1] [ref=e5]: Notification integration
    - status [ref=e6]: light
    - status [ref=e7]: /ui-migration/toasts.html
    - generic [ref=e8]:
      - button [ref=e9] [cursor=pointer]:
        - generic [ref=e10]: Short notice
      - button [ref=e11] [cursor=pointer]:
        - generic [ref=e12]: Error notice
      - button [ref=e13] [cursor=pointer]:
        - generic [ref=e14]: Warning notice
      - button [ref=e15] [cursor=pointer]:
        - generic [ref=e16]: Complete session
      - button [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: Session result
      - button [ref=e19] [cursor=pointer]:
        - generic [ref=e20]: Session failure
      - button [ref=e21] [cursor=pointer]:
        - generic [ref=e22]: Clear notifications
      - button [ref=e23] [cursor=pointer]:
        - generic [ref=e24]: Switch theme
      - button [ref=e25] [cursor=pointer]:
        - generic [ref=e26]: Nested dialog
      - button [ref=e27] [cursor=pointer]:
        - generic [ref=e28]: Confirm save
    - status [ref=e29]: "0"
    - button [ref=e30] [cursor=pointer]:
      - generic [ref=e31]: Open Dialog
    - button [ref=e32] [cursor=pointer]:
      - generic [ref=e33]: Open Drawer
    - button [ref=e34] [cursor=pointer]:
      - generic [ref=e35]: Open Bottom drawer
    - button [ref=e36] [cursor=pointer]:
      - generic [ref=e37]: Open Retained dialog
    - button [ref=e38] [cursor=pointer]:
      - generic [ref=e39]: Legacy confirm
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - dialog [active] [ref=e44]:
    - generic [ref=e45]:
      - button "Close" [ref=e46] [cursor=pointer]
      - heading "Workspace sheet" [level=2] [ref=e50]
    - generic [ref=e51]:
      - generic [ref=e52]:
        - button "Short notice" [ref=e53] [cursor=pointer]
        - button "Error notice" [ref=e55] [cursor=pointer]
        - button "Warning notice" [ref=e57] [cursor=pointer]
        - button "Complete session" [ref=e59] [cursor=pointer]
        - button "Session result" [ref=e61] [cursor=pointer]
        - button "Session failure" [ref=e63] [cursor=pointer]
        - button "Clear notifications" [ref=e65] [cursor=pointer]
        - button "Switch theme" [ref=e67] [cursor=pointer]
        - button "Nested dialog" [ref=e69] [cursor=pointer]
        - button "Confirm save" [ref=e71] [cursor=pointer]
      - status "Undo count" [ref=e73]: "0"
    - region "Notifications":
      - generic [ref=e74]:
        - generic [ref=e75]:
          - generic [ref=e79]: Couldn't save the schedule
          - button "Dismiss" [ref=e81] [cursor=pointer]:
            - img "close" [ref=e82]
        - generic [ref=e85]: revision 12 is stale
        - button "Copy error" [ref=e87] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | const button = (page, name) => page.getByRole('button', { name, exact: true });
  4  | test.beforeEach(async ({ page }) => {
  5  |   await page.goto('/ui-migration/toasts.html');
  6  |   await page.evaluate(() => document.fonts.ready);
  7  | });
  8  | 
  9  | for (const kind of ['Dialog', 'Drawer', 'Bottom drawer']) {
  10 |   test(`existing notification stays at viewport origin during ${kind} entry`, async ({ page }, info) => {
  11 |     await page.emulateMedia({ reducedMotion: 'no-preference' });
  12 |     await button(page, 'Error notice').click();
  13 |     await page.mouse.move(0, 0);
  14 |     await page.evaluate(async () => {
  15 |       await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  16 |     });
  17 |     const before = await page.locator('.toast-viewport').boundingBox();
  18 |     await page.evaluate(() => {
  19 |       window.motionSamples = [];
  20 |       window.motionDone = false;
  21 |       const start = performance.now();
  22 |       const frame = () => {
  23 |         const el = document.querySelector('.toast-viewport');
  24 |         if (el) {
  25 |           const r = el.getBoundingClientRect();
  26 |           const card = el.querySelector('.toast')?.getBoundingClientRect();
  27 |           const popup = el.closest('.orbit-overlay');
  28 |           const style = popup ? getComputedStyle(popup) : null;
  29 |           window.motionSamples.push({ t: performance.now() - start, x: r.x, y: r.y, width: r.width, height: r.height,
  30 |             card: card?.toJSON(), scale: style?.scale, translate: style?.translate,
  31 |             insideViewport: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight });
  32 |         }
  33 |         if (performance.now() - start < 800) requestAnimationFrame(frame); else window.motionDone = true;
  34 |       };
  35 |       requestAnimationFrame(frame);
  36 |     });
  37 |     await button(page, `Open ${kind}`).click();
  38 |     await page.waitForFunction(() => window.motionDone);
  39 |     const samples = await page.evaluate(() => window.motionSamples);
  40 |     const shifted = samples.filter(s => Math.abs(s.x - before.x) > 1 || Math.abs(s.y - before.y) > 1);
  41 |     await info.attach('entry-geometry', { body: JSON.stringify({ kind, before, samples, shifted }, null, 2), contentType: 'application/json' });
> 42 |     expect(shifted, 'an existing notification should not move with the newly opening modal').toHaveLength(0);
     |                                                                                              ^ Error: an existing notification should not move with the newly opening modal
  43 |   });
  44 | }
  45 | 
  46 | test('hover pause releases after a keyboard opened and closed overlay changes portal', async ({ page }, info) => {
  47 |   await page.clock.install({ time: new Date('2026-10-04T00:00:00Z') });
  48 |   await page.clock.pauseAt(new Date('2026-10-04T00:00:01Z'));
  49 |   await button(page, 'Complete session').click();
  50 |   const region = page.locator('.toast-viewport');
  51 |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  52 |   await page.clock.runFor(10000);
  53 |   await expect(region).toBeVisible();
  54 |   await button(page, 'Open Dialog').focus();
  55 |   await page.keyboard.press('Enter');
  56 |   await page.clock.runFor(200);
  57 |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  58 |   await page.keyboard.press('Escape');
  59 |   await page.clock.runFor(200);
  60 |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  61 |   await page.mouse.move(0, 0);
  62 |   await page.clock.runFor(6001);
  63 |   const after = await region.count();
  64 |   await info.attach('timer-after-portal', { body: JSON.stringify({ after, releasedAfterMs: 6001 }), contentType: 'application/json' });
  65 |   expect(after).toBe(0);
  66 | });
  67 | 
  68 | 
  69 | test('native hover deadline resumes after portal changes', async ({ page }, info) => {
  70 |   await button(page, 'Complete session').click();
  71 |   const region = page.locator('.toast-viewport');
  72 |   await region.locator('button[aria-label="Undo completing Fix login redirect"]').hover();
  73 |   await button(page, 'Open Dialog').focus();
  74 |   await page.keyboard.press('Enter');
  75 |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).toBeVisible();
  76 |   await page.keyboard.press('Escape');
  77 |   await expect(page.getByRole('dialog', { name: 'Workspace editor', exact: true })).not.toBeVisible();
  78 |   await page.mouse.move(0, 0);
  79 |   const releasedAt = Date.now();
  80 |   try { await expect(region).toHaveCount(0, { timeout: 7500 }); }
  81 |   finally {
  82 |     await info.attach('native-timer', {body: JSON.stringify({ elapsedMs:Date.now()-releasedAt, count:await region.count() }), contentType:'application/json'});
  83 |   }
  84 | });
  85 | 
```