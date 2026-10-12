# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: coordinator-feedback.browser.mjs >> existing notification stays at viewport origin during Drawer entry
- Location: src/web/ui-migration/coordinator-feedback.browser.mjs:10:3

# Error details

```
Error: an existing notification should not move with the newly opening modal

expect(received).toHaveLength(expected)

Expected length: 0
Received length: 19
Received array:  [{"card": {"bottom": 144, "height": 128, "left": 2200, "right": 2560, "top": 16, "width": 360, "x": 2200, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 58.29999998211861, "translate": "100%", "width": 360, "x": 2184, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 2194.115478515625, "right": 2554.115478515625, "top": 16, "width": 360, "x": 2194.115478515625, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 68.2999999821186, "translate": "100%", "width": 360, "x": 2184, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 2175.02001953125, "right": 2535.02001953125, "top": 16, "width": 360, "x": 2175.02001953125, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 81.5, "translate": "96.1462%", "width": 360, "x": 2169.4326171875, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 2144.584716796875, "right": 2504.5849609375, "top": 16, "width": 360.000244140625, "x": 2144.584716796875, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 98.19999998807907, "translate": "88.74%", "width": 360, "x": 2141.43701171875, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 2102.34033203125, "right": 2462.34033203125, "top": 16, "width": 360, "x": 2102.34033203125, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 114.69999998807907, "translate": "77.9124%", "width": 360, "x": 2100.5087890625, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 2054.385009765625, "right": 2414.38525390625, "top": 16, "width": 360.000244140625, "x": 2054.385009765625, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 131.2999999821186, "translate": "65.4258%", "width": 360, "x": 2053.3095703125, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 2007.6348876953125, "right": 2367.634765625, "top": 16, "width": 359.9998779296875, "x": 2007.6348876953125, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 148.2999999821186, "translate": "53.1803%", "width": 360, "x": 2007.021484375, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 1966.589111328125, "right": 2326.589111328125, "top": 16, "width": 360, "x": 1966.589111328125, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 164.89999997615814, "translate": "42.3971%", "width": 360, "x": 1966.26123046875, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 1932.1427001953125, "right": 2292.142578125, "top": 16, "width": 359.9998779296875, "x": 1932.1427001953125, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 181.5, "translate": "33.3302%", "width": 360.0001220703125, "x": 1931.9881591796875, "y": 16}, {"card": {"bottom": 144, "height": 128, "left": 1903.90673828125, "right": 2263.90673828125, "top": 16, "width": 360, "x": 1903.90673828125, "y": 16}, "height": 128, "insideViewport": false, "scale": "none", "t": 198.19999998807907, "translate": "25.8863%", "width": 360, "x": 1903.850341796875, "y": 16}, …]
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
      - heading "Workspace drawer" [level=2] [ref=e50]
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