# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: choices.browser.mjs >> menu arrows, disabled items, submenu, checkbox and focus return work
- Location: ui-migration/choices.browser.mjs:200:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  getByRole('status', { name: 'Action', exact: true })
Expected: "claude"
Received: "none"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" getByRole('status', { name: 'Action', exact: true }) with timeout 15000ms
  - waiting for getByRole('status', { name: 'Action', exact: true })
    34 × locator resolved to <output aria-label="Action">none</output>
       - unexpected value "none"

```

```yaml
- status "Action": none
```

# Test source

```ts
  117 |           expect(await surface.locator('.orbit-menu-label').first().evaluate((el) => el.getBoundingClientRect().x - el.closest('.orbit-menu').getBoundingClientRect().x)).toBe(66);
  118 |         }
  119 |       }
  120 |       if (['popover', 'tooltip'].includes(kind)) {
  121 |         const arrow = page.locator(system === 'antd' ? '.sample-arrow:visible' : '.orbit-floating-arrow:visible');
  122 |         const box = await surface.boundingBox();
  123 |         const arrowBox = await arrow.boundingBox();
  124 |         const triggerBox = await region.getByRole('button').boundingBox();
  125 |         measurements[system].callout = {
  126 |           triggerOffset: { x: box.x - triggerBox.x, y: box.y - triggerBox.y - triggerBox.height },
  127 |           arrow: { x: arrowBox.x - box.x, y: arrowBox.y - box.y, width: arrowBox.width, height: arrowBox.height },
  128 |           shape: await arrow.evaluate((el) => ({ fill: getComputedStyle(el, '::before').backgroundColor, clipPath: getComputedStyle(el, '::before').clipPath })),
  129 |           filter: await page.locator(system === 'antd' ? '.sample-floating-root:visible' : '.orbit-callout-positioner:visible').evaluate((el) => getComputedStyle(el).filter),
  130 |         };
  131 |         const x = Math.max(0, box.x - 40), y = Math.max(0, box.y - 40);
  132 |         await info.attach(`${system}-${kind}-context`, { body: await page.screenshot({ animations: 'disabled', clip: { x, y, width: Math.min(box.width + 80, info.project.use.viewport.width - x), height: box.height + 80 } }), contentType: 'image/png' });
  133 |       }
  134 |     }
  135 |     await attach(info, 'appearance', measurements);
  136 |     if (Object.keys(glyphs).length) {
  137 |       await attach(info, 'menu-glyphs', glyphs);
  138 |       if (kind === 'attachment' && info.project.use.hasTouch) {
  139 |         expect(glyphs.orbit.filter(({ kind }) => kind === 'svg').map(({ x, width, height }) => ({ x, width, height }))).toEqual(Array(4).fill({ x: 31, width: 19, height: 19 }));
  140 |         expect(glyphs.orbit.find(({ kind }) => kind === 'SPAN')).toMatchObject({ x: 31, width: 19 });
  141 |       } else expect(glyphs.orbit).toEqual(glyphs.antd);
  142 |     }
  143 |     if (kind === 'attachment' && info.project.use.hasTouch) {
  144 |       // P0's original phone sample also measured 14px items: AntD's generated
  145 |       // selector overrides the existing 17px rule. The task explicitly requires
  146 |       // the confirmed 17px/42.4px/26px design. Retain both raw samples; assert the
  147 |       // requested differences exactly, and every other measured property unchanged.
  148 |       const expected = structuredClone(measurements.antd);
  149 |       expected.popup.surface.height = 40 + 5 * 42.390625;
  150 |       expected.popup.rows.forEach((row, i) => Object.assign(row, {
  151 |         fontSize: '17px', borderRadius: '0px', padding: '0px 0px 0px 31px',
  152 |         lineHeight: info.project.use.browserName === 'webkit' ? '26.714285px' : '26.7143px',
  153 |         y: 10 + i * 42.390625 + (i >= 2 ? 20 : 0),
  154 |       }));
  155 |       expect(measurements.orbit).toEqual(expected);
  156 |     } else expect(measurements.orbit).toEqual(measurements.antd);
  157 |   });
  158 | }
  159 | 
  160 | test('empty, disabled, hover and focus choice surfaces match the existing states', async ({ page }, info) => {
  161 |   const measurements = {};
  162 |   for (const kind of ['expiry', 'search']) for (const state of ['disabled', 'empty', 'default']) {
  163 |     const values = {};
  164 |     for (const system of ['antd', 'orbit']) {
  165 |       await page.goto(`${fixture}?sample=${kind}&system=${system}&state=${state}`);
  166 |       await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  167 |       const control = page.locator('.sample-choice');
  168 |       const input = page.getByRole('combobox', { name: 'Sample choice' });
  169 |       await page.mouse.move(0, 0);
  170 |       await page.getByTestId('neutral').focus();
  171 |       await settle(control);
  172 |       values[system] = { control: await measure(control, true) };
  173 |       if (state === 'disabled') {
  174 |         await expect(input).toBeDisabled();
  175 |         await shot(info, `${system}-${kind}-disabled`, control);
  176 |       } else if (state === 'empty') {
  177 |         await input.click();
  178 |         const surface = page.locator('.sample-surface:visible');
  179 |         await settle(surface);
  180 |         await expect(surface.getByText('No data', { exact: true }).and(surface.locator('div'))).toBeVisible();
  181 |         values[system].popup = await measure(surface);
  182 |         await shot(info, `${system}-${kind}-empty`, surface);
  183 |       } else {
  184 |         await control.hover();
  185 |         await settle(control);
  186 |         values[system].hover = await measure(control, true);
  187 |         await input.focus();
  188 |         await page.mouse.move(0, 0);
  189 |         await settle(control);
  190 |         values[system].focus = await measure(control, true);
  191 |         await shot(info, `${system}-${kind}-focus`, control);
  192 |       }
  193 |     }
  194 |     measurements[`${kind}-${state}`] = values;
  195 |   }
  196 |   await attach(info, 'choice-states', measurements);
  197 |   for (const values of Object.values(measurements)) expect(values.orbit).toEqual(values.antd);
  198 | });
  199 | 
  200 | test('menu arrows, disabled items, submenu, checkbox and focus return work', async ({ page }, info) => {
  201 |   const trigger = page.getByRole('button', { name: 'Session actions', exact: true });
  202 |   await trigger.focus();
  203 |   await page.keyboard.press('ArrowDown');
  204 |   const first = page.getByRole('menuitem', { name: 'Default model', exact: true });
  205 |   await expect(first).toBeFocused();
  206 |   await page.keyboard.press('ArrowDown');
  207 |   const provider = page.getByRole('menuitem', { name: 'Provider', exact: true });
  208 |   await expect(provider).toBeFocused();
  209 |   await page.keyboard.press('ArrowRight');
  210 |   await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  211 |   await page.keyboard.press('Escape');
  212 |   await expect(provider).toBeFocused();
  213 |   await expect(page.getByRole('menu')).toHaveCount(1);
  214 |   await page.keyboard.press('ArrowRight');
  215 |   await page.keyboard.press('ArrowDown');
  216 |   await page.keyboard.press('Enter');
> 217 |   await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('claude');
      |                                                                           ^ Error: expect(locator).toHaveText(expected) failed
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
  269 |   await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('7');
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
```