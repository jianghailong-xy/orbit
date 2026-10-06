# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: toasts.browser.mjs >> legacy AntApp confirmation still works with the same notification service
- Location: src/web/ui-migration/toasts.browser.mjs:242:1

# Error details

```
Error: expect(locator).not.toBeVisible() failed

Locator:  getByRole('dialog', { name: 'Legacy confirmation', exact: true })
Expected: not visible
Received: visible
Timeout:  15000ms

Call log:
  - Expect "not toBeVisible" getByRole('dialog', { name: 'Legacy confirmation', exact: true }) with timeout 15000ms
  - waiting for getByRole('dialog', { name: 'Legacy confirmation', exact: true })
    4 × locator resolved to <div role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="_r_b_" class="ant-modal css-dev-only-do-not-override-oc1rc0 ant-modal-confirm ant-modal-confirm-confirm ant-zoom-appear ant-zoom-appear-active ant-zoom">…</div>
      - unexpected value "visible"
    30 × locator resolved to <div role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="_r_b_" class="ant-modal css-dev-only-do-not-override-oc1rc0 ant-modal-confirm ant-modal-confirm-confirm">…</div>
       - unexpected value "visible"

```

```yaml
- dialog "Legacy confirmation":
  - img "exclamation-circle"
  - text: Legacy confirmation
  - button "Cancel"
  - button "OK"
```

# Test source

```ts
  147 |   await trigger.click();
  148 |   const dialog = page.getByRole('dialog', { name: 'Workspace editor', exact: true });
  149 |   await dialog.getByRole('button', { name: 'Complete session', exact: true }).click();
  150 |   const undo = notices(page).getByRole('button', { name: 'Undo completing Fix login redirect', exact: true });
  151 |   await keyboardReach(page, undo, dialog);
  152 |   await page.keyboard.press('Enter');
  153 |   await expect(dialog.getByLabel('Undo count', { exact: true })).toHaveText('1');
  154 |   await expect(notices(page)).toHaveCount(0);
  155 |   await expect(dialog).toBeVisible();
  156 |   await dialog.getByRole('button', { name: 'Session result', exact: true }).click();
  157 |   const jump = notices(page).getByRole('button', { name: 'Merged into main Fix login redirect', exact: true });
  158 |   if (info.project.use.hasTouch) await jump.tap(); else await jump.click();
  159 |   await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
  160 |   await expect(notices(page)).toHaveCount(0);
  161 |   await expect(dialog).toBeVisible();
  162 |   await attach(info, 'actions', { duplicateSuppressed: true, eventFailureReplacedBySuccess: true, undoCount: 1, sessionPath: new URL(page.url()).pathname, pointer: info.project.use.hasTouch ? 'touch' : 'mouse' });
  163 | });
  164 | 
  165 | test('copyable diagnostics and live announcements survive nested overlays and theme changes', async ({ page }, info) => {
  166 |   // Clipboard writes are intercepted; selection and the user's Copy error click are real.
  167 |   await page.evaluate(() => {
  168 |     window.copiedDiagnostic = '';
  169 |     Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copiedDiagnostic = text; } } });
  170 |   });
  171 |   await button(page, 'Open Drawer').click();
  172 |   const parent = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  173 |   await parent.getByRole('button', { name: 'Error notice', exact: true }).click();
  174 |   const live = page.locator('[aria-live="assertive"]');
  175 |   await expect(live).toHaveText("Couldn't save the schedule. revision 12 is stale");
  176 |   expect(await live.evaluate((el) => el.closest('[aria-hidden="true"], [inert]') === null)).toBe(true);
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
  246 |   await legacy.getByRole('button', { name: 'OK', exact: true }).click();
> 247 |   await expect(legacy).not.toBeVisible();
      |                            ^ Error: expect(locator).not.toBeVisible() failed
  248 |   await expect(notices(page).getByText('Legacy confirmed', { exact: true })).toBeVisible();
  249 |   await shot(info, 'legacy-confirmed', page);
  250 | });
  251 | 
  252 | test('retained closed overlays release notifications and normal motion settles at the original origin', async ({ page }, info) => {
  253 |   await page.emulateMedia({ reducedMotion: 'no-preference' });
  254 |   const finishAnimations = () => page.evaluate(async () => {
  255 |     await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  256 |   });
  257 |   await button(page, 'Error notice').click();
  258 |   await finishAnimations();
  259 |   await page.mouse.move(0, 0);
  260 |   const before = await measure(notices(page));
  261 |   const trigger = button(page, 'Open Retained dialog');
  262 |   await trigger.click();
  263 |   const dialog = page.getByRole('dialog', { name: 'Retained editor', exact: true });
  264 |   await expect(dialog).toBeFocused();
  265 |   await page.mouse.move(0, 0);
  266 |   await finishAnimations();
  267 |   expect(await measure(notices(page))).toEqual(before);
  268 |   await page.keyboard.press('Escape');
  269 |   await expect(dialog).not.toBeVisible();
  270 |   await expect(trigger).toBeFocused();
  271 |   await finishAnimations();
  272 |   await expect(notices(page)).toBeVisible();
  273 |   expect(await measure(notices(page))).toEqual(before);
  274 |   await notices(page).getByRole('button', { name: 'Dismiss', exact: true }).click();
  275 |   await expect(notices(page)).toHaveCount(0);
  276 |   await trigger.click();
  277 |   await expect(dialog).toBeVisible();
  278 |   await finishAnimations();
  279 |   await dialog.getByRole('button', { name: 'Warning notice', exact: true }).click();
  280 |   await finishAnimations();
  281 |   await expect(notices(page)).toBeVisible();
  282 |   await shot(info, 'retained-reopened-with-motion', page);
  283 |   await attach(info, 'retained-and-motion', { visibleAfterClose: true, sameSettledGeometry: true, reopenedAcceptsNewNotifications: true });
  284 | });
  285 | 
  286 | test('notification origin follows viewport resize across the phone breakpoint', async ({ page }, info) => {
  287 |   await button(page, 'Error notice').click();
  288 |   const measurements = [];
  289 |   for (const width of [599, 601]) {
  290 |     await page.setViewportSize({ width, height: 900 });
  291 |     await page.mouse.move(0, 0);
  292 |     const before = await measure(notices(page));
  293 |     await button(page, 'Open Drawer').click();
  294 |     const drawer = page.getByRole('dialog', { name: 'Workspace drawer', exact: true });
  295 |     await expect(drawer).toBeVisible();
  296 |     await page.mouse.move(0, 0);
  297 |     await expect.poll(() => measure(notices(page))).toEqual(before);
  298 |     measurements.push({ width, before, after: await measure(notices(page)) });
  299 |     await page.keyboard.press('Escape');
  300 |     await expect(drawer).not.toBeVisible();
  301 |   }
  302 |   await attach(info, 'responsive-origin', measurements);
  303 | });
  304 | 
```