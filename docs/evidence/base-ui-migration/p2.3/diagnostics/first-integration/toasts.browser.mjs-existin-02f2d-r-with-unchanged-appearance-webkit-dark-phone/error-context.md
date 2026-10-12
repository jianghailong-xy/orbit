# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts.browser.mjs >> existing notifications remain accessible in Drawer with unchanged appearance
- Location: ui-migration/toasts.browser.mjs:42:3

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 8
+ Received  + 8

@@ -6,21 +6,21 @@
      "boxShadow": "none",
      "color": "rgb(201, 206, 213)",
      "focusVisible": false,
      "focused": false,
      "fontFamily": "-apple-system, BlinkMacSystemFont, PingFang SC, Hiragino Sans GB, Microsoft YaHei, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
-     "fontSize": "16px",
+     "fontSize": "14px",
      "fontWeight": "400",
      "gap": "8px",
      "height": 144,
      "hovered": false,
-     "lineHeight": "18.4px",
+     "lineHeight": "16.1px",
      "padding": "0px",
      "pointerEvents": "none",
      "tag": "SECTION",
      "text": "Couldn't save the schedulerevision 12 is staleCopy error",
-     "width": 350,
+     "width": 358,
      "x": 16,
      "y": 56,
    },
    Object {
      "background": "linear-gradient(rgba(245, 74, 69, 0.16), rgba(245, 74, 69, 0.16)) repeat scroll 0% 0% / auto padding-box border-box, rgb(43, 43, 46) none repeat scroll 0% 0% / auto padding-box border-box",
@@ -39,11 +39,11 @@
      "lineHeight": "20px",
      "padding": "12px 12px 12px 14px",
      "pointerEvents": "auto",
      "tag": "DIV",
      "text": "Couldn't save the schedulerevision 12 is staleCopy error",
-     "width": 350,
+     "width": 358,
      "x": 16,
      "y": 56,
    },
    Object {
      "background": "rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box",
@@ -62,11 +62,11 @@
      "lineHeight": "20px",
      "padding": "0px",
      "pointerEvents": "auto",
      "tag": "DIV",
      "text": "Couldn't save the schedule",
-     "width": 322,
+     "width": 330,
      "x": 31,
      "y": 69,
    },
    Object {
      "background": "rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box",
@@ -85,11 +85,11 @@
      "lineHeight": "20px",
      "padding": "0px",
      "pointerEvents": "auto",
      "tag": "SPAN",
      "text": "Couldn't save the schedule",
-     "width": 256,
+     "width": 264,
      "x": 63,
      "y": 69,
    },
    Object {
      "background": "rgba(0, 0, 0, 0) none repeat scroll 0% 0% / auto padding-box border-box",
@@ -109,11 +109,11 @@
      "padding": "0px",
      "pointerEvents": "auto",
      "tag": "BUTTON",
      "text": "",
      "width": 22,
-     "x": 331,
+     "x": 339,
      "y": 69,
    },
    Object {
      "background": "rgb(43, 43, 46) none repeat scroll 0% 0% / auto padding-box border-box",
      "border": "1px solid rgb(52, 52, 55)",
@@ -131,11 +131,11 @@
      "lineHeight": "18px",
      "padding": "7px 10px",
      "pointerEvents": "auto",
      "tag": "DIV",
      "text": "revision 12 is stale",
-     "width": 290,
+     "width": 298,
      "x": 63,
      "y": 99,
    },
    Object {
      "background": "rgb(43, 43, 46) none repeat scroll 0% 0% / auto padding-box border-box",
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading [level=1] [ref=e5]: Notification integration
    - status [ref=e6]: dark
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
      - generic [ref=e37]: Legacy confirm
  - generic [ref=e38]: Couldn't save the schedule. revision 12 is stale
  - dialog [active] [ref=e42]:
    - generic [ref=e43]:
      - button "Close" [ref=e44] [cursor=pointer]
      - heading "Workspace drawer" [level=2] [ref=e48]
    - generic [ref=e49]:
      - generic [ref=e50]:
        - button "Short notice" [ref=e51] [cursor=pointer]
        - button "Error notice" [ref=e53] [cursor=pointer]
        - button "Warning notice" [ref=e55] [cursor=pointer]
        - button "Complete session" [ref=e57] [cursor=pointer]
        - button "Session result" [ref=e59] [cursor=pointer]
        - button "Session failure" [ref=e61] [cursor=pointer]
        - button "Clear notifications" [ref=e63] [cursor=pointer]
        - button "Switch theme" [ref=e65] [cursor=pointer]
        - button "Nested dialog" [ref=e67] [cursor=pointer]
        - button "Confirm save" [ref=e69] [cursor=pointer]
      - status "Undo count" [ref=e71]: "0"
    - region "Notifications":
      - generic [ref=e72]:
        - generic [ref=e73]:
          - generic [ref=e77]: Couldn't save the schedule
          - button "Dismiss" [ref=e79] [cursor=pointer]:
            - img "close" [ref=e80]
        - generic [ref=e83]: revision 12 is stale
        - button "Copy error" [ref=e85] [cursor=pointer]
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { installFixedDate } from './fixtures.mjs';
  3   | 
  4   | const errors = new WeakMap();
  5   | const notices = (page) => page.getByRole('region', { name: 'Notifications', exact: true });
  6   | const button = (page, name) => page.getByRole('button', { name, exact: true });
  7   | const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
  8   | const shot = (info, name, locator) => locator.screenshot({ animations: 'disabled' }).then((body) => info.attach(name, { body, contentType: 'image/png' }));
  9   | 
  10  | test.beforeEach(async ({ page }, info) => {
  11  |   errors.set(page, []);
  12  |   page.on('pageerror', (error) => errors.get(page).push(error.message));
  13  |   await installFixedDate(page);
  14  |   await page.goto('/ui-migration/toasts.html');
  15  |   await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  16  |   await page.evaluate(() => document.fonts.ready);
  17  |   expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
  18  |     .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
  19  | });
  20  | test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
  21  | 
  22  | async function measure(region) {
  23  |   return region.evaluate((el) => [el, ...el.querySelectorAll('.toast, .toast-row, .toast-head, .toast-reason, button')].map((node) => {
  24  |     const r = node.getBoundingClientRect(), s = getComputedStyle(node);
  25  |     const keys = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'background', 'border', 'borderRadius', 'boxShadow', 'padding', 'gap', 'pointerEvents'];
  26  |     return { tag: node.tagName, text: node.textContent, x: r.x, y: r.y, width: r.width, height: r.height,
  27  |       hovered: node.matches(':hover'), focused: node.matches(':focus'), focusVisible: node.matches(':focus-visible'),
  28  |       ...Object.fromEntries(keys.map((key) => [key, s[key]])) };
  29  |   }));
  30  | }
  31  | 
  32  | async function keyboardReach(page, target, dialog) {
  33  |   for (let i = 0; i < 30; i++) {
  34  |     await page.keyboard.press('Tab');
  35  |     expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'focus stays with the active modal and its notifications').toBe(true);
  36  |     if (await target.evaluate((el) => el === document.activeElement)) return;
  37  |   }
  38  |   await expect(target).toBeFocused();
  39  | }
  40  | 
  41  | for (const [kind, title] of [['Dialog', 'Workspace editor'], ['Drawer', 'Workspace drawer'], ['Bottom drawer', 'Workspace sheet']]) {
  42  |   test(`existing notifications remain accessible in ${kind} with unchanged appearance`, async ({ page }, info) => {
  43  |     await button(page, 'Error notice').click();
  44  |     await page.mouse.move(0, 0);
  45  |     const region = notices(page);
  46  |     const before = await measure(region);
  47  |     await shot(info, 'before-overlay', region);
  48  |     const trigger = button(page, `Open ${kind}`);
  49  |     await trigger.click();
  50  |     const dialog = page.getByRole('dialog', { name: title, exact: true });
  51  |     await expect(dialog).toBeVisible();
  52  |     await page.mouse.move(0, 0);
  53  |     await expect(region).toBeVisible();
  54  |     const after = await measure(region);
  55  |     await attach(info, 'appearance', { before, after });
> 56  |     expect(after).toEqual(before);
      |                   ^ Error: expect(received).toEqual(expected) // deep equality
  57  |     await shot(info, 'with-overlay', region);
  58  |     await shot(info, 'notification-and-overlay', page);
  59  |     const dismiss = region.getByRole('button', { name: 'Dismiss', exact: true });
  60  |     await keyboardReach(page, dismiss, dialog);
  61  |     await page.keyboard.press('Enter');
  62  |     await expect(region).toHaveCount(0);
  63  |     await expect(dialog).toBeVisible();
  64  |     await page.keyboard.press('Escape');
  65  |     await expect(dialog).not.toBeVisible();
  66  |     await expect(trigger).toBeFocused();
  67  |     await attach(info, 'keyboard', { dismissReachedByTab: true, enterDismissedOnlyNotification: true, escapeClosedOverlay: true, focusReturned: true });
  68  |   });
  69  | }
  70  | 
  71  | test('mixed pinned and passing notifications stack without overlap and retain all pinned errors', async ({ page }, info) => {
  72  |   await button(page, 'Warning notice').click();
  73  |   await button(page, 'Error notice').click();
  74  |   await button(page, 'Short notice').click();
  75  |   await button(page, 'Complete session').click();
  76  |   const region = notices(page);
  77  |   await page.mouse.move(0, 0);
  78  |   const cards = region.locator('.toast');
  79  |   await expect(cards).toHaveCount(info.project.use.isMobile ? 2 : 3);
  80  |   const geometry = await cards.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  81  |   geometry.forEach((r, i) => {
  82  |     expect(r.x).toBeGreaterThanOrEqual(16);
  83  |     expect(r.right).toBeLessThanOrEqual(info.project.use.viewport.width - 16);
  84  |     if (i) expect(r.y - geometry[i - 1].bottom).toBeGreaterThanOrEqual(8);
  85  |   });
  86  |   await shot(info, 'mixed-stack', page);
  87  |   await attach(info, 'stack-geometry', geometry);
  88  |   if (!info.project.use.isMobile) {
  89  |     await region.getByRole('button', { name: '+1 more', exact: true }).click();
  90  |     await expect(region.getByText('Waiting for your approval', { exact: true })).toBeVisible();
  91  |     await shot(info, 'expanded-pinned-stack', page);
  92  |     await region.getByRole('button', { name: 'Show less', exact: true }).click();
  93  |   }
  94  |   await region.getByRole('button', { name: 'Dismiss', exact: true }).click();
  95  |   await expect(region.getByText('Waiting for your approval', { exact: true })).toBeVisible();
  96  | });
  97  | 
  98  | test('short and lifecycle dwell, hover restart, phone folding and permanent warnings keep their rules', async ({ page }, info) => {
  99  |   // This test measures timer contracts, not native browser performance.
  100 |   await page.clock.install({ time: new Date('2026-09-28T12:00:00Z') });
  101 |   await page.clock.pauseAt(new Date('2026-09-28T12:00:01Z'));
  102 |   await button(page, 'Short notice').click();
  103 |   await page.clock.runFor(2999);
  104 |   await expect(notices(page).getByText('Link copied', { exact: true })).toBeVisible();
  105 |   await page.clock.runFor(1);
  106 |   await expect(notices(page)).toHaveCount(0);
  107 |   await button(page, 'Complete session').click();
  108 |   await page.clock.runFor(5999);
  109 |   await expect(notices(page).getByText('Session completed', { exact: true })).toBeVisible();
  110 |   await page.clock.runFor(1);
  111 |   await expect(notices(page)).toHaveCount(0);
  112 |   await button(page, 'Complete session').click();
  113 |   await notices(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true }).hover();
  114 |   await page.clock.runFor(10000);
  115 |   await expect(notices(page).getByText('Session completed', { exact: true })).toBeVisible();
  116 |   await page.mouse.move(0, 0);
  117 |   await page.clock.runFor(5999);
  118 |   await expect(notices(page).getByText('Session completed', { exact: true })).toBeVisible();
  119 |   await page.clock.runFor(1);
  120 |   await expect(notices(page)).toHaveCount(0);
  121 |   await button(page, 'Warning notice').click();
  122 |   await page.clock.runFor(6000);
  123 |   if (info.project.use.isMobile) {
  124 |     await expect(notices(page).getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  125 |     await shot(info, 'folded-warning', page);
  126 |     await notices(page).getByRole('button', { name: 'Waiting for your approval', exact: true }).click();
  127 |     await expect(notices(page).getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
  128 |   }
  129 |   await page.clock.runFor(60000);
  130 |   await expect(notices(page).getByText('Waiting for your approval', { exact: true })).toBeVisible();
  131 |   await attach(info, 'timers', { shortMs: 3000, actionMs: 6000, hoverHeldMs: 10000, fullDwellRestarted: true, warningStillPresentAfterMs: 66000, phoneFolds: !!info.project.use.isMobile });
  132 | });
  133 | 
  134 | test('event and entity deduplication, Undo and session navigation retain the business boundary', async ({ page }, info) => {
  135 |   await button(page, 'Short notice').dblclick();
  136 |   await expect(notices(page).getByText('Link copied', { exact: true })).toHaveCount(1);
  137 |   await button(page, 'Clear notifications').click();
  138 |   await button(page, 'Session failure').click();
  139 |   await button(page, 'Session failure').click();
  140 |   await expect(notices(page).getByText("Couldn't merge into main", { exact: true })).toHaveCount(1);
  141 |   await button(page, 'Session result').click();
  142 |   await expect(notices(page).getByText("Couldn't merge into main", { exact: true })).toHaveCount(0);
  143 |   await expect(notices(page).getByText('Merged into main', { exact: true })).toHaveCount(1);
  144 |   await button(page, 'Clear notifications').click();
  145 |   const trigger = button(page, 'Open Dialog');
  146 |   await trigger.click();
  147 |   const dialog = page.getByRole('dialog', { name: 'Workspace editor', exact: true });
  148 |   await dialog.getByRole('button', { name: 'Complete session', exact: true }).click();
  149 |   const undo = notices(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true });
  150 |   await keyboardReach(page, undo, dialog);
  151 |   await page.keyboard.press('Enter');
  152 |   await expect(dialog.getByLabel('Undo count', { exact: true })).toHaveText('1');
  153 |   await expect(notices(page)).toHaveCount(0);
  154 |   await expect(dialog).toBeVisible();
  155 |   await dialog.getByRole('button', { name: 'Session result', exact: true }).click();
  156 |   const jump = notices(page).getByRole('button', { name: 'Merged into main Fix login redirect', exact: true });
```