# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: coordinator-feedback.browser.mjs >> existing notification stays at viewport origin during Dialog entry
- Location: src/web/ui-migration/coordinator-feedback.browser.mjs:10:3

# Error details

```
Error: an existing notification should not move with the newly opening modal

expect(received).toHaveLength(expected)

Expected length: 0
Received length: 14
Received array:  [{"card": {"bottom": 241.89999389648438, "height": 115.19998931884766, "left": 1234, "right": 1558, "top": 126.70000457763672, "width": 324, "x": 1234, "y": 126.70000457763672}, "height": 115.19998931884766, "insideViewport": false, "scale": "0.9", "t": 58.19999998807907, "translate": "none", "width": 324, "x": 1219.5999755859375, "y": 126.70000457763672}, {"card": {"bottom": 241.89999389648438, "height": 115.19998931884766, "left": 1228.658935546875, "right": 1552.658935546875, "top": 126.70000457763672, "width": 324, "x": 1228.658935546875, "y": 126.70000457763672}, "height": 115.19998931884766, "insideViewport": false, "scale": "0.9", "t": 65.90000000596046, "translate": "none", "width": 324, "x": 1219.5999755859375, "y": 126.70000457763672}, {"card": {"bottom": 242.04885864257812, "height": 116.10729217529297, "left": 1229.2420654296875, "right": 1555.7938232421875, "top": 125.94156646728516, "width": 326.5517578125, "x": 1229.2420654296875, "y": 125.94156646728516}, "height": 116.10729217529297, "insideViewport": false, "scale": "0.907088", "t": 82.40000000596046, "translate": "none", "width": 326.5517578125, "x": 1224.164794921875, "y": 125.94156646728516}, {"card": {"bottom": 242.36215209960938, "height": 118.0169448852539, "left": 1236.679931640625, "right": 1568.6026611328125, "top": 124.34520721435547, "width": 331.9227294921875, "x": 1236.679931640625, "y": 124.34520721435547}, "height": 118.0169448852539, "insideViewport": false, "scale": "0.922007", "t": 98.90000000596046, "translate": "none", "width": 331.922607421875, "x": 1233.7728271484375, "y": 124.34520721435547}, {"card": {"bottom": 242.75735473632812, "height": 120.42581939697266, "left": 1247.6181640625, "right": 1586.3157958984375, "top": 122.33153533935547, "width": 338.6976318359375, "x": 1247.6181640625, "y": 122.33153533935547}, "height": 120.42581939697266, "insideViewport": false, "scale": "0.940827", "t": 115.69999998807907, "translate": "none", "width": 338.6976318359375, "x": 1245.8924560546875, "y": 122.33153533935547}, {"card": {"bottom": 243.10952758789062, "height": 122.57234191894531, "left": 1257.7203369140625, "right": 1602.455078125, "top": 120.53718566894531, "width": 344.7347412109375, "x": 1257.7203369140625, "y": 120.53718566894531}, "height": 122.57234191894531, "insideViewport": false, "scale": "0.957596", "t": 132.59999999403954, "translate": "none", "width": 344.734619140625, "x": 1256.692138671875, "y": 120.53718566894531}, {"card": {"bottom": 243.38241577148438, "height": 124.23566436767578, "left": 1265.655029296875, "right": 1615.06787109375, "top": 119.1467514038086, "width": 349.412841796875, "x": 1265.655029296875, "y": 119.1467514038086}, "height": 124.23566436767578, "insideViewport": false, "scale": "0.970591", "t": 149.19999998807907, "translate": "none", "width": 349.4127197265625, "x": 1265.0606689453125, "y": 119.1467514038086}, {"card": {"bottom": 243.58480834960938, "height": 125.46935272216797, "left": 1271.58984375, "right": 1624.472412109375, "top": 118.1154556274414, "width": 352.882568359375, "x": 1271.58984375, "y": 118.1154556274414}, "height": 125.46935272216797, "insideViewport": false, "scale": "0.980229", "t": 165.7999999821186, "translate": "none", "width": 352.8824462890625, "x": 1271.267822265625, "y": 118.1154556274414}, {"card": {"bottom": 243.73451232910156, "height": 126.38182067871094, "left": 1276.0115966796875, "right": 1631.46044921875, "top": 117.35269165039062, "width": 355.4488525390625, "x": 1276.0115966796875, "y": 117.35269165039062}, "height": 126.38182067871094, "insideViewport": false, "scale": "0.987358", "t": 182.40000000596046, "translate": "none", "width": 355.44873046875, "x": 1275.858642578125, "y": 117.35269165039062}, {"card": {"bottom": 243.84182739257812, "height": 127.03591918945312, "left": 1279.205810546875, "right": 1636.494384765625, "top": 116.805908203125, "width": 357.28857421875, "x": 1279.205810546875, "y": 116.805908203125}, "height": 127.03591918945312, "insideViewport": false, "scale": "0.992468", "t": 199.09999999403954, "translate": "none", "width": 357.2884521484375, "x": 1279.1495361328125, "y": 116.805908203125}, …]
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
      - heading "Workspace editor" [level=2] [ref=e50]
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