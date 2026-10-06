# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> legacy Modal owns choices, top-layer Escape, Tab and theme
- Location: ui-migration/choices.browser.mjs:343:37

# Error details

```
Error: expect(locator).not.toBeVisible() failed

Locator:  getByRole('dialog', { name: 'Legacy share', exact: true })
Expected: not visible
Received: visible

Call log:
  - Expect "not toBeVisible" getByRole('dialog', { name: 'Legacy share', exact: true }) with timeout 15000ms
  - waiting for getByRole('dialog', { name: 'Legacy share', exact: true })
    - locator resolved to <div role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="_r_28_" class="ant-modal css-dev-only-do-not-override-oc1rc0 ant-zoom-leave ant-zoom-leave-start ant-zoom">…</div>
    2 × unexpected value "visible"
      - locator resolved to <div role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="_r_28_" class="ant-modal css-dev-only-do-not-override-oc1rc0 ant-zoom-leave ant-zoom-leave-active ant-zoom">…</div>
    - unexpected value "visible"
  - Test ended.

```

```yaml
- dialog "Legacy share":
  - button "Close"
  - text: Legacy share
  - combobox "Expires": Never
  - button "Clear selection"
  - text: Orbit workspace
  - combobox "Workspace"
  - button "Show options"
  - button "Clear selection"
  - combobox "Disabled select" [disabled]: Never
  - text: Never
  - combobox "Disabled search" [disabled]
  - button "Show options" [disabled]
  - combobox "Empty select": No accounts
  - combobox "Automatic account": Automatic
  - button "Session actions"
  - button "Add attachment"
  - button "Open context"
  - button "Account usage"
  - button "Unavailable action" [disabled]
  - button "After choices"
  - status "Expiry value": never
  - status "Workspace value": orbit
  - status "Action": none
  - status "Tag": "false"
```

# Test source

```ts
  276 |   await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
  277 |   await expect(select).toBeFocused();
  278 |   await expect(page.getByRole('combobox', { name: 'Disabled select', exact: true })).toBeDisabled();
  279 |   await expect(page.getByRole('combobox', { name: 'Disabled search', exact: true })).toBeDisabled();
  280 |   await page.getByRole('combobox', { name: 'Empty select', exact: true }).click();
  281 |   await expect(page.getByText('No data', { exact: true })).toBeVisible();
  282 |   await page.keyboard.press('Escape');
  283 |   const automatic = page.getByRole('combobox', { name: 'Automatic account', exact: true });
  284 |   await expect(automatic).toContainText('Automatic');
  285 |   await automatic.click();
  286 |   await expect(page.getByRole('option', { name: /Automatic/ })).toHaveAttribute('aria-selected', 'true');
  287 |   await outside(page, info);
  288 |   await expect(automatic).toHaveAttribute('aria-expanded', 'false');
  289 |   await attach(info, 'select', { selected: '7', cleared: true, disabled: true, empty: true, emptyStringIsSelection: true });
  290 | });
  291 | 
  292 | test('search preserves selection, filters groups, handles no results, composition and explicit clear', async ({ page }, info) => {
  293 |   const input = page.getByRole('combobox', { name: 'Workspace', exact: true });
  294 |   await expect(input).toHaveAccessibleDescription('Orbit workspace');
  295 |   await input.click();
  296 |   await expect(page.getByRole('group', { name: 'Local', exact: true })).toBeVisible();
  297 |   await input.fill('docs');
  298 |   await expect(page.getByRole('option')).toHaveCount(1);
  299 |   await page.keyboard.press('Enter');
  300 |   await expect(page.locator('output[aria-label="Workspace value"]')).toHaveText('docs');
  301 |   await expect(input).toBeFocused();
  302 |   await input.fill('missing');
  303 |   await expect(page.getByText('No data', { exact: true })).toBeVisible();
  304 |   await page.keyboard.press('Escape');
  305 |   await expect(page.locator('output[aria-label="Workspace value"]')).toHaveText('docs');
  306 |   await input.click();
  307 |   await input.dispatchEvent('compositionstart');
  308 |   await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  309 |   await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true });
  310 |   await expect(input).toHaveAttribute('aria-expanded', 'true');
  311 |   await expect(page.locator('output[aria-label="Workspace value"]')).toHaveText('docs');
  312 |   await input.dispatchEvent('compositionend', { data: '文档' });
  313 |   await input.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  314 |   await input.fill('文档');
  315 |   await expect(page.getByRole('option')).toHaveCount(1);
  316 |   await page.keyboard.press('Enter');
  317 |   await page.getByRole('button', { name: 'Clear selection' }).nth(1).click();
  318 |   await expect(page.getByRole('status', { name: 'Workspace value', exact: true })).toHaveText('null');
  319 |   await expect(input).toBeFocused();
  320 |   await attach(info, 'search', { grouping: true, chinese: true, syntheticCompositionIgnored: true, escapePreservesValue: true, explicitClear: true });
  321 | });
  322 | 
  323 | test('remote search accepts server labels and resets an action picker without local filtering', async ({ page }, info) => {
  324 |   let release;
  325 |   const gate = new Promise((resolve) => { release = resolve; });
  326 |   await page.route('**/__choices-search?*', async (route) => {
  327 |     await gate;
  328 |     await route.fulfill({ json: [{ value: 'task-1', label: 'Server ranked result' }] });
  329 |   });
  330 |   const input = page.getByRole('combobox', { name: 'Add prerequisite', exact: true });
  331 |   await input.fill('query');
  332 |   await expect(input).toHaveAttribute('aria-busy', 'true');
  333 |   release();
  334 |   const option = page.getByRole('option', { name: 'Server ranked result', exact: true });
  335 |   await expect(option).toBeVisible();
  336 |   await option.click();
  337 |   await expect(page.getByRole('status', { name: 'Prerequisite', exact: true })).toHaveText('task-1');
  338 |   await expect(input).toHaveValue('');
  339 |   await expect(input).toHaveAttribute('aria-expanded', 'false');
  340 |   await attach(info, 'remote-search', { loadingExposed: true, filterDisabled: true, valueNullResetsQuery: true });
  341 | });
  342 | 
  343 | for (const legacy of [false, true]) test(`${legacy ? 'legacy Modal' : 'Dialog'} owns choices, top-layer Escape, Tab and theme`, async ({ page }, info) => {
  344 |   const trigger = page.getByRole('button', { name: legacy ? 'Open legacy Modal' : 'Open Dialog', exact: true });
  345 |   await tap(page, info, trigger);
  346 |   const dialog = page.getByRole('dialog', { name: legacy ? 'Legacy share' : 'Share workspace', exact: true });
  347 |   await settle(dialog);
  348 |   const input = dialog.getByRole('combobox', { name: 'Workspace', exact: true });
  349 |   await tap(page, info, input);
  350 |   const list = page.getByRole('listbox');
  351 |   await expect(list).toBeVisible();
  352 |   expect(await list.evaluate((el) => !!el.closest('[role="dialog"]'))).toBe(true);
  353 |   await page.keyboard.press('Escape');
  354 |   await expect(list).not.toBeVisible();
  355 |   await expect(dialog).toBeVisible();
  356 |   await expect(input).toBeFocused();
  357 |   await tap(page, info, dialog.getByRole('combobox', { name: 'Expires', exact: true }));
  358 |   await expect(list).toBeVisible();
  359 |   await page.keyboard.press('Escape');
  360 |   await expect(list).not.toBeVisible();
  361 |   await expect(dialog).toBeVisible();
  362 |   const actions = dialog.getByRole('button', { name: 'Session actions', exact: true });
  363 |   await tap(page, info, actions);
  364 |   await expect(page.getByRole('menu')).toBeVisible();
  365 |   await page.keyboard.press('Escape');
  366 |   await expect(dialog).toBeVisible();
  367 |   await expect(actions).toBeFocused();
  368 |   for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < (legacy ? 3 : 12); i++) {
  369 |     await page.keyboard.press(key);
  370 |     const focusOwner = legacy ? page.locator('.legacy-choices-owner') : dialog;
  371 |     await expect.poll(() => focusOwner.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  372 |   }
  373 |   expect(await page.evaluate(() => [document.body, document.documentElement].some((el) => /hidden|clip/.test(getComputedStyle(el).overflowY)))).toBe(true);
  374 |   await shot(info, 'choices-in-dialog', dialog);
  375 |   await page.keyboard.press('Escape');
> 376 |   await expect(dialog).not.toBeVisible();
      |                            ^ Error: expect(locator).not.toBeVisible() failed
  377 |   await expect(trigger).toBeFocused();
  378 |   await attach(info, 'nested-choices', { legacy, topLayerOnly: true, portalInsideOwner: true, tabBothDirections: true, fullTabCycle: !legacy, scrollLocked: true, returned: true });
  379 | });
  380 | 
  381 | test('legacy host final Tab matches the AntD-only baseline, including its browser-focus boundary', async ({ page }, info) => {
  382 |   const results = {};
  383 |   for (const system of ['antd', 'orbit']) {
  384 |     await page.goto(`${fixture}${system === 'antd' ? '?legacyBaseline' : ''}`);
  385 |     await page.getByRole('button', { name: 'Open legacy Modal', exact: true }).click();
  386 |     const dialog = page.getByRole('dialog', { name: 'Legacy share', exact: true });
  387 |     await settle(dialog);
  388 |     await dialog.getByRole('button', { name: 'After choices', exact: true }).focus();
  389 |     await page.keyboard.press('Tab');
  390 |     await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  391 |     results[system] = await page.evaluate(() => ({ body: document.activeElement === document.body,
  392 |       insideOwner: !!document.activeElement?.closest('.legacy-choices-owner') }));
  393 |     await page.keyboard.press('Tab');
  394 |     await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  395 |   }
  396 |   await attach(info, 'legacy-tab-baseline', results);
  397 |   expect(results.orbit).toEqual(results.antd);
  398 | });
  399 | 
  400 | test('popover owns a select and restores focus one layer at a time; tooltip responds to focus and hover', async ({ page }, info) => {
  401 |   const trigger = page.getByRole('button', { name: 'Open context', exact: true });
  402 |   await tap(page, info, trigger);
  403 |   const popover = page.getByRole('dialog', { name: 'Context', exact: true });
  404 |   await expect(popover).toBeVisible();
  405 |   const select = popover.getByRole('combobox', { name: 'Context expiry', exact: true });
  406 |   await select.click();
  407 |   await expect(page.getByRole('listbox')).toBeVisible();
  408 |   await page.keyboard.press('Escape');
  409 |   await expect(popover).toBeVisible();
  410 |   await expect(select).toBeFocused();
  411 |   await page.keyboard.press('Escape');
  412 |   await expect(popover).not.toBeVisible();
  413 |   await expect(trigger).toBeFocused();
  414 |   await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  415 |   const usage = page.getByRole('button', { name: 'Account usage', exact: true });
  416 |   await page.keyboard.press('Tab');
  417 |   await usage.focus();
  418 |   const tooltip = page.getByRole('tooltip');
  419 |   await expect(tooltip).toHaveText('Usage from this account');
  420 |   await expect(usage).toHaveAttribute('aria-describedby', /.+/);
  421 |   await page.keyboard.press('Escape');
  422 |   await expect(tooltip).not.toBeVisible();
  423 |   await usage.blur();
  424 |   await usage.hover();
  425 |   await expect(tooltip).toBeVisible();
  426 |   await page.mouse.move(0, 0);
  427 |   await expect(tooltip).not.toBeVisible();
  428 |   await tap(page, info, trigger);
  429 |   await outside(page, info);
  430 |   await expect(popover).not.toBeVisible();
  431 |   await attach(info, 'popover-tooltip', { nestedSelect: true, sequentialEscape: true, focusReturn: true, tooltipFocusHoverEscape: true });
  432 | });
  433 | 
  434 | 
  435 | test('open choices follow the live system theme without losing selection', async ({ page }, info) => {
  436 |   const select = page.getByRole('combobox', { name: 'Expires', exact: true });
  437 |   await select.click();
  438 |   const popup = page.getByRole('listbox');
  439 |   await expect(popup).toBeVisible();
  440 |   const colors = {};
  441 |   for (const theme of [info.project.use.colorScheme === 'dark' ? 'light' : 'dark', info.project.use.colorScheme]) {
  442 |     await page.emulateMedia({ colorScheme: theme });
  443 |     await expect(page.getByTestId('theme')).toHaveText(theme);
  444 |     await expect(popup).toBeVisible();
  445 |     const option = page.getByRole('option', { name: 'Never', exact: true });
  446 |     await expect(option).toHaveAttribute('aria-selected', 'true');
  447 |     colors[theme] = await option.evaluate((el) => ({ foreground: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  448 |     expect(colors[theme].background).toBe(theme === 'dark' ? 'rgb(34, 61, 126)' : 'rgb(214, 232, 255)');
  449 |   }
  450 |   await attach(info, 'live-theme', colors);
  451 | });
  452 | 
  453 | test('Dialog keeps composition, outside dismissal, submenu Escape and keyboard clear within its owner', async ({ page }, info) => {
  454 |   await tap(page, info, page.getByRole('button', { name: 'Open Dialog', exact: true }));
  455 |   const dialog = page.getByRole('dialog', { name: 'Share workspace', exact: true });
  456 |   const input = dialog.getByRole('combobox', { name: 'Workspace', exact: true });
  457 |   await tap(page, info, input);
  458 |   await expect(page.getByRole('listbox')).toBeVisible();
  459 |   await input.dispatchEvent('compositionstart');
  460 |   await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true });
  461 |   await expect(page.getByRole('listbox')).toBeVisible();
  462 |   await expect(dialog).toBeVisible();
  463 |   await input.dispatchEvent('compositionend');
  464 |   await tap(page, info, page.getByRole('heading', { name: 'Share workspace', includeHidden: true }));
  465 |   await expect(page.getByRole('listbox')).not.toBeVisible();
  466 |   await expect(dialog).toBeVisible();
  467 |   const actions = dialog.getByRole('button', { name: 'Session actions', exact: true });
  468 |   await tap(page, info, actions);
  469 |   await tap(page, info, page.getByRole('menuitem', { name: 'Provider', exact: true }));
  470 |   await expect(page.getByRole('menu')).toHaveCount(2);
  471 |   await page.keyboard.press('Escape');
  472 |   await expect(page.getByRole('menu')).toHaveCount(1);
  473 |   await expect(dialog).toBeVisible();
  474 |   await page.keyboard.press('Escape');
  475 |   await expect(actions).toBeFocused();
  476 |   await input.focus();
```