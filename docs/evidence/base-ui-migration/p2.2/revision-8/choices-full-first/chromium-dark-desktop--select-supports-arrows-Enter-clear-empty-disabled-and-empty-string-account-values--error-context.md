# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> select supports arrows, Enter, clear, empty, disabled and empty-string account values
- Location: ui-migration/choices.browser.mjs:263:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('status', { name: 'Expiry value', exact: true })
Expected: "7"
Received: "never"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" getByRole('status', { name: 'Expiry value', exact: true }) with timeout 15000ms
  - waiting for getByRole('status', { name: 'Expiry value', exact: true })
    34 × locator resolved to <output aria-label="Expiry value">never</output>
       - unexpected value "never"

```

```yaml
- status "Expiry value": never
```

# Test source

```ts
  169 |       await settle(control);
  170 |       values[system] = { control: await measure(control, true) };
  171 |       if (state === 'disabled') {
  172 |         await expect(input).toBeDisabled();
  173 |         await shot(info, `${system}-${kind}-disabled`, control);
  174 |       } else if (state === 'empty') {
  175 |         await input.click();
  176 |         const surface = page.locator('.sample-surface:visible');
  177 |         await settle(surface);
  178 |         await expect(surface.getByText('No data', { exact: true }).and(surface.locator('div'))).toBeVisible();
  179 |         values[system].popup = await measure(surface);
  180 |         await shot(info, `${system}-${kind}-empty`, surface);
  181 |       } else {
  182 |         await control.hover();
  183 |         await settle(control);
  184 |         values[system].hover = await measure(control, true);
  185 |         await input.focus();
  186 |         await page.mouse.move(0, 0);
  187 |         await settle(control);
  188 |         values[system].focus = await measure(control, true);
  189 |         await shot(info, `${system}-${kind}-focus`, control);
  190 |       }
  191 |     }
  192 |     measurements[`${kind}-${state}`] = values;
  193 |   }
  194 |   await attach(info, 'choice-states', measurements);
  195 |   for (const values of Object.values(measurements)) expect(values.orbit).toEqual(values.antd);
  196 | });
  197 | 
  198 | test('menu arrows, disabled items, submenu, checkbox and focus return work', async ({ page }, info) => {
  199 |   const trigger = page.getByRole('button', { name: 'Session actions', exact: true });
  200 |   await trigger.focus();
  201 |   await page.keyboard.press('ArrowDown');
  202 |   const first = page.getByRole('menuitem', { name: 'Default model', exact: true });
  203 |   await expect(first).toBeFocused();
  204 |   await page.keyboard.press('ArrowDown');
  205 |   const provider = page.getByRole('menuitem', { name: 'Provider', exact: true });
  206 |   await expect(provider).toBeFocused();
  207 |   await page.keyboard.press('ArrowRight');
  208 |   await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  209 |   await page.keyboard.press('Escape');
  210 |   await expect(provider).toBeFocused();
  211 |   await expect(page.getByRole('menu')).toHaveCount(1);
  212 |   await page.keyboard.press('ArrowRight');
  213 |   await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  214 |   await page.keyboard.press('ArrowDown');
  215 |   await expect(page.getByRole('menuitem', { name: 'Claude', exact: true })).toBeFocused();
  216 |   await page.keyboard.press('Enter');
  217 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('claude');
  218 |   await expect(trigger).toBeFocused();
  219 |   await trigger.click();
  220 |   const tag = page.getByRole('menuitemcheckbox', { name: 'Important tag' });
  221 |   await tag.click();
  222 |   await expect(tag).toHaveAttribute('aria-checked', 'true');
  223 |   await expect(page.getByRole('status', { name: 'Tag', exact: true })).toHaveText('true');
  224 |   await tag.press('Space');
  225 |   await expect(tag).toHaveAttribute('aria-checked', 'false');
  226 |   await page.keyboard.press('Escape');
  227 |   await expect(trigger).toBeFocused();
  228 |   await attach(info, 'keyboard-menu', { disabledSkipped: true, submenuOnlyEscape: true, selection: 'claude', checkboxStaysOpen: true, focusReturned: true });
  229 | });
  230 | 
  231 | test('touch or pointer menus dismiss outside, fit viewport and open a dialog with stable return focus', async ({ page }, info) => {
  232 |   const trigger = page.getByRole('button', { name: 'Add attachment', exact: true });
  233 |   await tap(page, info, trigger);
  234 |   const menu = page.getByRole('menu');
  235 |   const box = await menu.boundingBox();
  236 |   expect(box.x).toBeGreaterThanOrEqual(0);
  237 |   expect(box.x + box.width).toBeLessThanOrEqual(info.project.use.viewport.width);
  238 |   await tap(page, info, page.getByRole('menuitem', { name: 'Image', exact: true }));
  239 |   await expect(menu).not.toBeVisible();
  240 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('image');
  241 |   await tap(page, info, trigger);
  242 |   await settle(menu);
  243 |   await outside(page, info);
  244 |   await expect(menu).not.toBeVisible();
  245 |   const actions = page.getByRole('button', { name: 'Session actions', exact: true });
  246 |   await tap(page, info, actions);
  247 |   await tap(page, info, page.getByRole('menuitem', { name: 'Provider', exact: true }));
  248 |   const sub = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Codex', exact: true }) });
  249 |   await expect(sub).toBeVisible();
  250 |   const subBox = await sub.boundingBox();
  251 |   expect(subBox.x).toBeGreaterThanOrEqual(0);
  252 |   expect(subBox.x + subBox.width).toBeLessThanOrEqual(info.project.use.viewport.width);
  253 |   await page.keyboard.press('Escape');
  254 |   await tap(page, info, page.getByRole('menuitem', { name: 'Edit details', exact: true }));
  255 |   const dialog = page.getByRole('dialog', { name: 'Edit details', exact: true });
  256 |   await expect(dialog).toBeVisible();
  257 |   await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  258 |   await page.keyboard.press('Escape');
  259 |   await expect(actions).toBeFocused();
  260 |   await attach(info, 'pointer-menu', { input: info.project.use.hasTouch ? 'touch' : 'mouse', outside: true, menuBounds: box, submenuBounds: subBox, dialogReturn: true });
  261 | });
  262 | 
  263 | test('select supports arrows, Enter, clear, empty, disabled and empty-string account values', async ({ page }, info) => {
  264 |   const select = page.getByRole('combobox', { name: 'Expires', exact: true });
  265 |   await select.focus();
  266 |   await page.keyboard.press('ArrowDown');
  267 |   await page.keyboard.press('ArrowDown');
  268 |   await page.keyboard.press('Enter');
> 269 |   await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('7');
      |                                                                                 ^ Error: expect(locator).toHaveText(expected) failed
  270 |   await expect(select).toBeFocused();
  271 |   await select.click();
  272 |   await expect(page.getByRole('option', { name: '7 days', exact: true })).toHaveAttribute('aria-selected', 'true');
  273 |   await expect(page.getByRole('option', { name: '30 days', exact: true })).toHaveAttribute('aria-disabled', 'true');
  274 |   await page.keyboard.press('Escape');
  275 |   await page.getByRole('button', { name: 'Clear selection' }).first().click();
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
```