# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts.browser.mjs >> retained closed overlays release notifications and normal motion settles at the original origin
- Location: ui-migration/toasts.browser.mjs:251:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('region', { name: 'Notifications', exact: true })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByRole('region', { name: 'Notifications', exact: true }) with timeout 15000ms
  - waiting for getByRole('region', { name: 'Notifications', exact: true })

```

```yaml
- dialog "Retained editor":
  - button "Close"
  - heading "Retained editor" [level=2]
  - button "Short notice"
  - button "Error notice"
  - button "Warning notice"
  - button "Complete session"
  - button "Session result"
  - button "Session failure"
  - button "Clear notifications"
  - button "Switch theme"
  - button "Nested dialog"
  - button "Confirm save"
  - status "Undo count": "0"
- text: Couldn't save the schedule. revision 12 is stale
```

# Test source

```ts
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
  266 |   expect(await measure(notices(page))).toEqual(before);
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
  278 |   await dialog.getByRole('button', { name: 'Error notice', exact: true }).click();
  279 |   await finishAnimations();
> 280 |   await expect(notices(page)).toBeVisible();
      |                               ^ Error: expect(locator).toBeVisible() failed
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