# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts.browser.mjs >> retained closed overlays release notifications and normal motion settles at the original origin
- Location: ui-migration/toasts.browser.mjs:251:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 6
+ Received  + 6

@@ -16,11 +16,11 @@
      "lineHeight": "18.4px",
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
      - generic [ref=e37]: Open Retained dialog
    - button [ref=e38] [cursor=pointer]:
      - generic [ref=e39]: Legacy confirm
  - dialog [active] [ref=e43]:
    - generic [ref=e44]:
      - button "Close" [ref=e45] [cursor=pointer]
      - heading "Retained editor" [level=2] [ref=e49]
    - generic [ref=e50]:
      - generic [ref=e51]:
        - button "Short notice" [ref=e52] [cursor=pointer]
        - button "Error notice" [ref=e54] [cursor=pointer]
        - button "Warning notice" [ref=e56] [cursor=pointer]
        - button "Complete session" [ref=e58] [cursor=pointer]
        - button "Session result" [ref=e60] [cursor=pointer]
        - button "Session failure" [ref=e62] [cursor=pointer]
        - button "Clear notifications" [ref=e64] [cursor=pointer]
        - button "Switch theme" [ref=e66] [cursor=pointer]
        - button "Nested dialog" [ref=e68] [cursor=pointer]
        - button "Confirm save" [ref=e70] [cursor=pointer]
      - status "Undo count" [ref=e72]: "0"
    - generic:
      - region "Notifications":
        - generic [ref=e73]:
          - generic [ref=e74]:
            - generic [ref=e78]: Couldn't save the schedule
            - button "Dismiss" [ref=e80] [cursor=pointer]:
              - img "close" [ref=e81]
          - generic [ref=e84]: revision 12 is stale
          - button "Copy error" [ref=e86] [cursor=pointer]
  - generic [ref=e88]: Couldn't save the schedule. revision 12 is stale
```

# Test source

```ts
  166 |   await page.evaluate(() => {
  167 |     window.copiedDiagnostic = '';
  168 |     Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedDiagnostic = text; } } });
  169 |   });
  170 |   await button(page, 'Open Drawer').click();
  171 |   const parent = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  172 |   await parent.getByRole('button', { name: 'Error notice', exact: true }).click();
  173 |   const live = page.locator('[aria-live="assertive"]');
  174 |   await expect(live).toHaveText("Couldn't save the schedule. revision 12 is stale");
  175 |   expect(await live.evaluate((el) => el.closest('[aria-hidden="true"], [inert]') === null)).toBe(true);
  176 |   await parent.getByRole('button', { name: 'Nested dialog', exact: true }).click();
  177 |   const child = page.getByRole('dialog', { name: 'Nested editor', exact: true });
  178 |   await expect(notices(page)).toBeVisible();
  179 |   const copy = notices(page).getByRole('button', { name: 'Copy error', exact: true });
  180 |   await keyboardReach(page, copy, child);
  181 |   await page.keyboard.press('Enter');
  182 |   expect(await page.evaluate(() => window.copiedDiagnostic)).toBe('revision 12 is stale');
  183 |   await notices(page).getByText('revision 12 is stale', { exact: true }).evaluate((el) => {
  184 |     const range = document.createRange(); range.selectNodeContents(el);
  185 |     const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  186 |   });
  187 |   expect(await page.evaluate(() => window.getSelection().toString())).toBe('revision 12 is stale');
  188 |   const original = await notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background);
  189 |   await child.getByRole('button', { name: 'Switch theme', exact: true }).click();
  190 |   await expect.poll(() => notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background)).not.toBe(original);
  191 |   await page.mouse.move(0, 0);
  192 |   await child.focus();
  193 |   await page.evaluate(() => window.getSelection().removeAllRanges());
  194 |   await shot(info, 'nested-toast-opposite-theme', page);
  195 |   await page.keyboard.press('Escape');
  196 |   await expect(child).not.toBeVisible();
  197 |   await expect(parent).toBeVisible();
  198 |   await expect(notices(page)).toBeVisible();
  199 |   await parent.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  200 |   await parent.getByRole('button', { name: 'Short notice', exact: true }).click();
  201 |   await expect(page.locator('[aria-live="polite"]')).toHaveText('Link copied');
  202 |   await page.keyboard.press('Escape');
  203 |   await expect(parent).not.toBeVisible();
  204 |   await expect(notices(page).getByText('Link copied', { exact: true })).toBeVisible();
  205 |   await attach(info, 'accessibility', { assertiveErrorAndDetail: true, liveRegionNotHidden: true, politeSuccess: true, copyText: 'revision 12 is stale', selectedDiagnostic: true, notificationSurvivesEachOverlayClose: true, themeChangedWhileOpen: true });
  206 | });
  207 | 
  208 | test('async confirmation keeps pending locks, accessible failure feedback and successful retry', async ({ page }, info) => {
  209 |   let requests = 0;
  210 |   let complete;
  211 |   const pending = new Promise((resolve) => { complete = resolve; });
  212 |   await page.route('**/__toast-confirm', async (route) => {
  213 |     requests++;
  214 |     if (requests === 1) { await pending; await route.fulfill({ status: 409, body: '{}' }); }
  215 |     else await route.fulfill({ status: 200, body: '{}' });
  216 |   });
  217 |   await button(page, 'Confirm save').click();
  218 |   const confirmation = page.getByRole('alertdialog', { name: 'Save schedule?', exact: true });
  219 |   await confirmation.getByRole('button', { name: 'Save', exact: true }).dblclick();
  220 |   await expect(confirmation).toHaveAttribute('aria-busy', 'true');
  221 |   await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  222 |   await page.keyboard.press('Escape');
  223 |   expect(requests).toBe(1);
  224 |   await shot(info, 'confirm-pending', page);
  225 |   complete();
  226 |   await expect(confirmation.getByRole('alert')).toHaveText('revision 12 is stale');
  227 |   await expect(notices(page)).toBeVisible();
  228 |   await shot(info, 'confirm-failure-notification', page);
  229 |   const dismiss = notices(page).getByRole('button', { name: 'Dismiss', exact: true });
  230 |   await keyboardReach(page, dismiss, confirmation);
  231 |   await page.keyboard.press('Enter');
  232 |   await expect(confirmation).toBeVisible();
  233 |   await confirmation.getByRole('button', { name: 'Save', exact: true }).click();
  234 |   await expect(confirmation).not.toBeVisible();
  235 |   await expect(notices(page).getByText('Schedule saved', { exact: true })).toBeVisible();
  236 |   await expect(button(page, 'Confirm save')).toBeFocused();
  237 |   expect(requests).toBe(2);
  238 |   await attach(info, 'confirmation', { requests, pendingCancelDisabled: true, pendingEscapeIgnored: true, failureRetained: true, toastDismissDidNotCancel: true, retrySucceeded: true, focusReturned: true });
  239 | });
  240 | 
  241 | test('legacy AntApp confirmation still works with the same notification service', async ({ page }, info) => {
  242 |   await button(page, 'Legacy confirm').click();
  243 |   const legacy = page.getByRole('dialog', { name: 'Legacy confirmation', exact: true });
  244 |   await expect(legacy).toBeVisible();
  245 |   await legacy.getByRole('button', { name: 'OK', exact: true }).click();
  246 |   await expect(legacy).not.toBeVisible();
  247 |   await expect(notices(page).getByText('Legacy confirmed', { exact: true })).toBeVisible();
  248 |   await shot(info, 'legacy-confirmed', page);
  249 | });
  250 | 
  251 | test('retained closed overlays release notifications and normal motion settles at the original origin', async ({ page }, info) => {
  252 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  253 |   const finishAnimations = () => page.evaluate(async () => {
  254 |     await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  255 |   });
  256 |   await button(page, 'Error notice').click();
  257 |   await finishAnimations();
  258 |   await page.mouse.move(0, 0);
  259 |   const before = await measure(notices(page));
  260 |   const trigger = button(page, 'Open Retained dialog');
  261 |   await trigger.click();
  262 |   const dialog = page.getByRole('dialog', { name: 'Retained editor', exact: true });
  263 |   await expect(dialog).toBeFocused();
  264 |   await page.mouse.move(0, 0);
  265 |   await finishAnimations();
> 266 |   expect(await measure(notices(page))).toEqual(before);
      |                                        ^ Error: expect(received).toEqual(expected) // deep equality
  267 |   await page.keyboard.press('Escape');
  268 |   await expect(dialog).not.toBeVisible();
  269 |   await expect(trigger).toBeFocused();
  270 |   await finishAnimations();
  271 |   await expect(notices(page)).toBeVisible();
  272 |   expect(await measure(notices(page))).toEqual(before);
  273 |   await notices(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  274 |   await expect(notices(page)).toHaveCount(0);
  275 |   await trigger.click();
  276 |   await expect(dialog).toBeVisible();
  277 |   await finishAnimations();
  278 |   await dialog.getByRole('button', { name: 'Warning notice', exact: true }).click();
  279 |   await finishAnimations();
  280 |   await expect(notices(page)).toBeVisible();
  281 |   await shot(info, 'retained-reopened-with-motion', page);
  282 |   await attach(info, 'retained-and-motion', { visibleAfterClose: true, sameSettledGeometry: true, reopenedAcceptsNewNotifications: true });
  283 | });
  284 | 
  285 | test('notification origin follows viewport resize across the phone breakpoint', async ({ page }, info) => {
  286 |   await button(page, 'Error notice').click();
  287 |   const measurements = [];
  288 |   for (const width of [599, 601]) {
  289 |     await page.setViewportSize({ width, height: 900 });
  290 |     await page.mouse.move(0, 0);
  291 |     const before = await measure(notices(page));
  292 |     await button(page, 'Open Drawer').click();
  293 |     const drawer = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  294 |     await expect(drawer).toBeVisible();
  295 |     await page.mouse.move(0, 0);
  296 |     await expect.poll(() => measure(notices(page))).toEqual(before);
  297 |     measurements.push({ width, before, after: await measure(notices(page)) });
  298 |     await page.keyboard.press('Escape');
  299 |     await expect(drawer).not.toBeVisible();
  300 |   }
  301 |   await attach(info, 'responsive-origin', measurements);
  302 | });
  303 | 
```