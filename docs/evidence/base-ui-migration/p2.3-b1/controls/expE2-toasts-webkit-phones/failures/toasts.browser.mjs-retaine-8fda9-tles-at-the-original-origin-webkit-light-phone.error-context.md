# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts.browser.mjs >> retained closed overlays release notifications and normal motion settles at the original origin
- Location: ui-migration/toasts.browser.mjs:256:1

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
      "background": "linear-gradient(rgb(253, 236, 235), rgb(253, 236, 235)) repeat scroll 0% 0% / auto padding-box border-box, rgb(255, 255, 255) none repeat scroll 0% 0% / auto padding-box border-box",
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
      "background": "rgb(255, 255, 255) none repeat scroll 0% 0% / auto padding-box border-box",
      "border": "1px solid rgb(236, 238, 241)",
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
      "background": "rgb(255, 255, 255) none repeat scroll 0% 0% / auto padding-box border-box",
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - main [ref=e4]:
    - heading "Notification integration" [level=1] [ref=e5]
    - status [ref=e6]: light
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
    - button "Open Retained dialog" [active] [ref=e36] [cursor=pointer]
    - button "Legacy confirm" [ref=e38] [cursor=pointer]
  - generic [ref=e40]: Couldn't save the schedule. revision 12 is stale
  - generic:
    - region "Notifications":
      - generic [ref=e41]:
        - generic [ref=e42]:
          - generic [ref=e46]: Couldn't save the schedule
          - button "Dismiss" [ref=e48] [cursor=pointer]:
            - img "close" [ref=e49]
        - generic [ref=e52]: revision 12 is stale
        - button "Copy error" [ref=e54] [cursor=pointer]
```

# Test source

```ts
  177 |   await parent.getByRole('button', { name: 'Nested dialog', exact: true }).click();
  178 |   const child = page.getByRole('dialog', { name: 'Nested editor', exact: true });
  179 |   await expect(notices(page)).toBeVisible();
  180 |   const copy = notices(page).getByRole('button', { name: 'Copy error', exact: true });
  181 |   await keyboardReach(page, copy, child);
  182 |   await page.keyboard.press('Enter');
  183 |   expect(await page.evaluate(() => window.copiedDiagnostic)).toBe('revision 12 is stale');
  184 |   await notices(page).getByText('revision 12 is stale', { exact: true }).evaluate((el) => {
  185 |     const range = document.createRange(); range.selectNodeContents(el);
  186 |     const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  187 |   });
  188 |   expect(await page.evaluate(() => window.getSelection().toString())).toBe('revision 12 is stale');
  189 |   const original = await notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background);
  190 |   await child.getByRole('button', { name: 'Switch theme', exact: true }).click();
  191 |   await expect.poll(() => notices(page).locator('.toast').evaluate((el) => getComputedStyle(el).background)).not.toBe(original);
  192 |   await page.mouse.move(0, 0);
  193 |   await child.focus();
  194 |   await page.evaluate(() => window.getSelection().removeAllRanges());
  195 |   await shot(info, 'nested-toast-opposite-theme', page);
  196 |   await page.keyboard.press('Escape');
  197 |   await expect(child).not.toBeVisible();
  198 |   await expect(parent).toBeVisible();
  199 |   await expect(notices(page)).toBeVisible();
  200 |   await parent.getByRole('button', { name: 'Clear notifications', exact: true }).click();
  201 |   await parent.getByRole('button', { name: 'Short notice', exact: true }).click();
  202 |   await expect(page.locator('[aria-live="polite"]')).toHaveText('Link copied');
  203 |   await page.keyboard.press('Escape');
  204 |   await expect(parent).not.toBeVisible();
  205 |   await expect(notices(page).getByText('Link copied', { exact: true })).toBeVisible();
  206 |   await attach(info, 'accessibility', { assertiveErrorAndDetail: true, liveRegionNotHidden: true, politeSuccess: true, copyText: 'revision 12 is stale', selectedDiagnostic: true, notificationSurvivesEachOverlayClose: true, themeChangedWhileOpen: true });
  207 | });
  208 | 
  209 | test('async confirmation keeps pending locks, accessible failure feedback and successful retry', async ({ page }, info) => {
  210 |   let requests = 0;
  211 |   let complete;
  212 |   const pending = new Promise((resolve) => { complete = resolve; });
  213 |   await page.route('**/__toast-confirm', async (route) => {
  214 |     requests++;
  215 |     if (requests === 1) { await pending; await route.fulfill({ status: 409, body: '{}' }); }
  216 |     else await route.fulfill({ status: 200, body: '{}' });
  217 |   });
  218 |   await button(page, 'Confirm save').click();
  219 |   const confirmation = page.getByRole('alertdialog', { name: 'Save schedule?', exact: true });
  220 |   await confirmation.getByRole('button', { name: 'Save', exact: true }).dblclick();
  221 |   await expect(confirmation).toHaveAttribute('aria-busy', 'true');
  222 |   await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  223 |   await page.keyboard.press('Escape');
  224 |   expect(requests).toBe(1);
  225 |   await shot(info, 'confirm-pending', page);
  226 |   complete();
  227 |   await expect(confirmation.getByRole('alert')).toHaveText('revision 12 is stale');
  228 |   await expect(notices(page)).toBeVisible();
  229 |   await shot(info, 'confirm-failure-notification', page);
  230 |   const dismiss = notices(page).getByRole('button', { name: 'Dismiss', exact: true });
  231 |   await keyboardReach(page, dismiss, confirmation);
  232 |   await page.keyboard.press('Enter');
  233 |   await expect(confirmation).toBeVisible();
  234 |   await confirmation.getByRole('button', { name: 'Save', exact: true }).click();
  235 |   await expect(confirmation).not.toBeVisible();
  236 |   await expect(notices(page).getByText('Schedule saved', { exact: true })).toBeVisible();
  237 |   await expect(button(page, 'Confirm save')).toBeFocused();
  238 |   expect(requests).toBe(2);
  239 |   await attach(info, 'confirmation', { requests, pendingCancelDisabled: true, pendingEscapeIgnored: true, failureRetained: true, toastDismissDidNotCancel: true, retrySucceeded: true, focusReturned: true });
  240 | });
  241 | 
  242 | test('legacy AntApp confirmation still works with the same notification service', async ({ page }, info) => {
  243 |   await button(page, 'Legacy confirm').click();
  244 |   const legacy = page.getByRole('dialog', { name: 'Legacy confirmation', exact: true });
  245 |   await expect(legacy).toBeVisible();
  246 |   // AntApp's entrance can briefly have a stable hit box at opacity 0 / scale(.2).
  247 |   // Wait for its painted, settled state before the real pointer click.
  248 |   await expect(legacy).toHaveCSS('opacity', '1');
  249 |   await expect(legacy).toHaveCSS('transform', 'none');
  250 |   await legacy.getByRole('button', { name: 'OK', exact: true }).click();
  251 |   await expect(legacy).not.toBeVisible();
  252 |   await expect(notices(page).getByText('Legacy confirmed', { exact: true })).toBeVisible();
  253 |   await shot(info, 'legacy-confirmed', page);
  254 | });
  255 | 
  256 | test('retained closed overlays release notifications and normal motion settles at the original origin', async ({ page }, info) => {
  257 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  258 |   const finishAnimations = () => page.evaluate(async () => {
  259 |     await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  260 |   });
  261 |   await button(page, 'Error notice').click();
  262 |   await finishAnimations();
  263 |   await page.mouse.move(0, 0);
  264 |   const before = await measure(notices(page));
  265 |   const trigger = button(page, 'Open Retained dialog');
  266 |   await trigger.click();
  267 |   const dialog = page.getByRole('dialog', { name: 'Retained editor', exact: true });
  268 |   await expect(dialog).toBeFocused();
  269 |   await page.mouse.move(0, 0);
  270 |   await finishAnimations();
  271 |   expect(await measure(notices(page))).toEqual(before);
  272 |   await page.keyboard.press('Escape');
  273 |   await expect(dialog).not.toBeVisible();
  274 |   await expect(trigger).toBeFocused();
  275 |   await finishAnimations();
  276 |   await expect(notices(page)).toBeVisible();
> 277 |   expect(await measure(notices(page))).toEqual(before);
      |                                        ^ Error: expect(received).toEqual(expected) // deep equality
  278 |   await notices(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  279 |   await expect(notices(page)).toHaveCount(0);
  280 |   await trigger.click();
  281 |   await expect(dialog).toBeVisible();
  282 |   await finishAnimations();
  283 |   await dialog.getByRole('button', { name: 'Warning notice', exact: true }).click();
  284 |   await finishAnimations();
  285 |   await expect(notices(page)).toBeVisible();
  286 |   await shot(info, 'retained-reopened-with-motion', page);
  287 |   await attach(info, 'retained-and-motion', { visibleAfterClose: true, sameSettledGeometry: true, reopenedAcceptsNewNotifications: true });
  288 | });
  289 | 
  290 | test('notification origin follows viewport resize across the phone breakpoint', async ({ page }, info) => {
  291 |   await button(page, 'Error notice').click();
  292 |   const measurements = [];
  293 |   for (const width of [599, 601]) {
  294 |     await page.setViewportSize({ width, height: 900 });
  295 |     await page.mouse.move(0, 0);
  296 |     const before = await measure(notices(page));
  297 |     await button(page, 'Open Drawer').click();
  298 |     const drawer = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  299 |     await expect(drawer).toBeVisible();
  300 |     await page.mouse.move(0, 0);
  301 |     await expect.poll(() => measure(notices(page))).toEqual(before);
  302 |     measurements.push({ width, before, after: await measure(notices(page)) });
  303 |     await page.keyboard.press('Escape');
  304 |     await expect(drawer).not.toBeVisible();
  305 |   }
  306 |   await attach(info, 'responsive-origin', measurements);
  307 | });
  308 | 
```