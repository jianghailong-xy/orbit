import { test, expect } from '@playwright/test';

const fixture = '/ui-migration/choices.html';
const errors = new WeakMap();
test.beforeEach(async ({ page }, info) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
  await page.goto(fixture);
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
const attach = (info, name, value) => info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
const shot = (info, name, locator) => locator.screenshot({ animations: 'disabled' }).then((body) => info.attach(name, { body, contentType: 'image/png' }));
async function settle(locator) {
  await expect(locator).toBeVisible();
  // Enter motion may be scheduled after mounting. Wait for the initial frames
  // and the surface's scale before measuring or asking Playwright to capture it.
  await locator.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect.poll(() => locator.evaluate((el) => {
    for (let node = el; node; node = node.parentElement) {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
      if (Math.hypot(matrix.a, matrix.b) !== 1 || Math.hypot(matrix.c, matrix.d) !== 1) return false;
    }
    return true;
  })).toBe(true);
  await locator.evaluate(async (el) => {
    const animations = new Set(el.getAnimations({ subtree: true }));
    for (let node = el.parentElement; node; node = node.parentElement) for (const animation of node.getAnimations()) animations.add(animation);
    await Promise.all([...animations].filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function tap(page, info, locator) {
  if (info.project.use.hasTouch) await locator.tap();
  else await locator.click();
}
async function outside(page, info) {
  if (info.project.use.hasTouch) await page.touchscreen.tap(3, 60);
  else await page.mouse.click(3, 60);
}
async function measure(locator, contents = false) {
  return locator.evaluate((el, contents) => {
    const root = el.getBoundingClientRect();
    const metrics = (node) => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      const keys = ['fontFamily', 'fontSize', 'lineHeight', 'fontWeight', 'color', 'backgroundColor', 'borderRadius', 'borderColor', 'borderWidth', 'borderStyle', 'padding', 'boxShadow'];
      return { x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, ...Object.fromEntries(keys.map((key) => [key, s[key]])) };
    };
    const visible = (node) => {
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      }
      return node.getBoundingClientRect().width > 0;
    };
    const result = { surface: metrics(el), rows: [...el.querySelectorAll('[role="menuitem"], [role="option"]')].map((row) => ({ label: row.textContent, ...metrics(row) })) };
    if (contents) {
      result.origin = { x: root.x, y: root.y };
      result.chips = [...el.querySelectorAll('.sample-chip, .orbit-multi-chip')].filter(visible).map(metrics);
      result.texts = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim() || !visible(node.parentElement)) continue;
        const range = document.createRange(); range.selectNode(node);
        const r = range.getBoundingClientRect(), s = getComputedStyle(node.parentElement);
        if (!r.width || !r.height) continue;
        result.texts.push({ text: node.textContent, x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height,
          color: s.color, fontSize: s.fontSize, fontWeight: s.fontWeight });
      }
      result.icons = [...el.querySelectorAll('svg')].filter(visible).map((svg) => {
        const r = svg.getBoundingClientRect();
        return { x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, color: getComputedStyle(svg).color, paths: [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d')) };
      });
    }
    return result;
  }, contents);
}

for (const kind of ['attachment', 'access', 'expiry', 'account', 'search', 'popover', 'tooltip']) {
  test(`${kind} matches the current surface, density and option states`, async ({ page }, info) => {
    const measurements = {};
    const glyphs = {};
    for (const system of ['antd', 'orbit']) {
      await page.goto(`${fixture}?sample=${kind}&system=${system}`);
      await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      const region = page.getByRole('region', { name: 'Appearance sample' });
      const choice = region.getByRole('combobox');
      if (['expiry', 'account', 'search'].includes(kind)) {
        await page.mouse.move(0, 0);
        await page.getByTestId('neutral').focus();
        await settle(page.locator('.sample-choice'));
        measurements[system] = { control: await measure(page.locator('.sample-choice'), true) };
        await shot(info, `${system}-${kind}-closed`, page.locator('.sample-choice'));
        await choice.click();
      } else if (kind === 'tooltip') {
        await region.getByRole('button').hover();
        await settle(region.getByRole('button'));
      }
      else await region.getByRole('button').click();
      const surface = page.locator('.sample-surface:visible');
      await settle(surface);
      if (kind !== 'tooltip') await page.mouse.move(0, 0);
      await settle(surface);
      measurements[system] = { ...measurements[system], popup: await measure(surface) };
      await shot(info, `${system}-${kind}-open`, surface);
      if (['attachment', 'access'].includes(kind)) {
        glyphs[system] = await surface.evaluate((el) => {
          const root = el.getBoundingClientRect();
          return [...el.querySelectorAll('svg, .fixture-command-icon')].map((icon) => {
            const r = icon.getBoundingClientRect();
            return { kind: icon.tagName, x: r.x - root.x, y: r.y - root.y, width: r.width, height: r.height, color: getComputedStyle(icon).color, paths: [...icon.querySelectorAll('path')].map((path) => path.getAttribute('d')) };
          });
        });
        if (kind === 'attachment' && system === 'orbit' && info.project.use.hasTouch) {
          expect(await surface.locator('.orbit-menu-label').first().evaluate((el) => el.getBoundingClientRect().x - el.closest('.orbit-menu').getBoundingClientRect().x)).toBe(66);
        }
      }
      if (['popover', 'tooltip'].includes(kind)) {
        const arrow = page.locator(system === 'antd' ? '.sample-arrow:visible' : '.orbit-floating-arrow:visible');
        const box = await surface.boundingBox();
        const arrowBox = await arrow.boundingBox();
        const triggerBox = await region.getByRole('button').boundingBox();
        measurements[system].callout = {
          triggerOffset: { x: box.x - triggerBox.x, y: box.y - triggerBox.y - triggerBox.height },
          arrow: { x: arrowBox.x - box.x, y: arrowBox.y - box.y, width: arrowBox.width, height: arrowBox.height },
          shape: await arrow.evaluate((el) => ({ fill: getComputedStyle(el, '::before').backgroundColor, clipPath: getComputedStyle(el, '::before').clipPath })),
          filter: await page.locator(system === 'antd' ? '.sample-floating-root:visible' : '.orbit-callout-positioner:visible').evaluate((el) => getComputedStyle(el).filter),
        };
        const x = Math.max(0, box.x - 40), y = Math.max(0, box.y - 40);
        await info.attach(`${system}-${kind}-context`, { body: await page.screenshot({ animations: 'disabled', clip: { x, y, width: Math.min(box.width + 80, info.project.use.viewport.width - x), height: box.height + 80 } }), contentType: 'image/png' });
      }
    }
    await attach(info, 'appearance', measurements);
    if (Object.keys(glyphs).length) {
      await attach(info, 'menu-glyphs', glyphs);
      if (kind === 'attachment' && info.project.use.hasTouch) {
        expect(glyphs.orbit.filter(({ kind }) => kind === 'svg').map(({ x, width, height }) => ({ x, width, height }))).toEqual(Array(4).fill({ x: 31, width: 19, height: 19 }));
        expect(glyphs.orbit.find(({ kind }) => kind === 'SPAN')).toMatchObject({ x: 31, width: 19 });
      } else expect(glyphs.orbit).toEqual(glyphs.antd);
    }
    if (kind === 'attachment' && info.project.use.hasTouch) {
      // P0's original phone sample also measured 14px items: AntD's generated
      // selector overrides the existing 17px rule. The task explicitly requires
      // the confirmed 17px/42.4px/26px design. Retain both raw samples; assert the
      // requested differences exactly, and every other measured property unchanged.
      const expected = structuredClone(measurements.antd);
      expected.popup.surface.height = 40 + 5 * 42.390625;
      expected.popup.rows.forEach((row, i) => Object.assign(row, {
        fontSize: '17px', borderRadius: '0px', padding: '0px 0px 0px 31px',
        lineHeight: info.project.use.browserName === 'webkit' ? '26.714285px' : '26.7143px',
        y: 10 + i * 42.390625 + (i >= 2 ? 20 : 0),
      }));
      expect(measurements.orbit).toEqual(expected);
    } else expect(measurements.orbit).toEqual(measurements.antd);
  });
}

test('empty, disabled, hover and focus choice surfaces match the existing states', async ({ page }, info) => {
  const measurements = {};
  for (const kind of ['expiry', 'search']) for (const state of ['disabled', 'empty', 'default']) {
    const values = {};
    for (const system of ['antd', 'orbit']) {
      await page.goto(`${fixture}?sample=${kind}&system=${system}&state=${state}`);
      await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      const control = page.locator('.sample-choice');
      const input = page.getByRole('combobox', { name: 'Sample choice' });
      await page.mouse.move(0, 0);
      await page.getByTestId('neutral').focus();
      await settle(control);
      values[system] = { control: await measure(control, true) };
      if (state === 'disabled') {
        await expect(input).toBeDisabled();
        await shot(info, `${system}-${kind}-disabled`, control);
      } else if (state === 'empty') {
        await input.click();
        const surface = page.locator('.sample-surface:visible');
        await settle(surface);
        await expect(surface.getByText('No data', { exact: true }).and(surface.locator('div'))).toBeVisible();
        values[system].popup = await measure(surface);
        await shot(info, `${system}-${kind}-empty`, surface);
      } else {
        await control.hover();
        await settle(control);
        values[system].hover = await measure(control, true);
        await input.focus();
        await page.mouse.move(0, 0);
        await settle(control);
        values[system].focus = await measure(control, true);
        await shot(info, `${system}-${kind}-focus`, control);
      }
    }
    measurements[`${kind}-${state}`] = values;
  }
  await attach(info, 'choice-states', measurements);
  for (const values of Object.values(measurements)) expect(values.orbit).toEqual(values.antd);
});

test('menu arrows, disabled items, submenu, checkbox and focus return work', async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: 'Session actions', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const first = page.getByRole('menuitem', { name: 'Default model', exact: true });
  await expect(first).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const provider = page.getByRole('menuitem', { name: 'Provider', exact: true });
  await expect(provider).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(provider).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Codex', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Claude', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('claude');
  await expect(trigger).toBeFocused();
  await trigger.click();
  const tag = page.getByRole('menuitemcheckbox', { name: 'Important tag' });
  await tag.click();
  await expect(tag).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('status', { name: 'Tag', exact: true })).toHaveText('true');
  await tag.press('Space');
  await expect(tag).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await attach(info, 'keyboard-menu', { disabledSkipped: true, submenuOnlyEscape: true, selection: 'claude', checkboxStaysOpen: true, focusReturned: true });
});

test('touch or pointer menus dismiss outside, fit viewport and open a dialog with stable return focus', async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: 'Add attachment', exact: true });
  await tap(page, info, trigger);
  const menu = page.getByRole('menu');
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(info.project.use.viewport.width);
  await tap(page, info, page.getByRole('menuitem', { name: 'Image', exact: true }));
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole('status', { name: 'Action', exact: true })).toHaveText('image');
  await tap(page, info, trigger);
  await settle(menu);
  await outside(page, info);
  await expect(menu).not.toBeVisible();
  const actions = page.getByRole('button', { name: 'Session actions', exact: true });
  await tap(page, info, actions);
  await tap(page, info, page.getByRole('menuitem', { name: 'Provider', exact: true }));
  const sub = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Codex', exact: true }) });
  await expect(sub).toBeVisible();
  const subBox = await sub.boundingBox();
  expect(subBox.x).toBeGreaterThanOrEqual(0);
  expect(subBox.x + subBox.width).toBeLessThanOrEqual(info.project.use.viewport.width);
  await page.keyboard.press('Escape');
  await tap(page, info, page.getByRole('menuitem', { name: 'Edit details', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Edit details', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await attach(info, 'pointer-menu', { input: info.project.use.hasTouch ? 'touch' : 'mouse', outside: true, menuBounds: box, submenuBounds: subBox, dialogReturn: true });
});

test('select supports arrows, Enter, clear, empty, disabled and empty-string account values', async ({ page }, info) => {
  const select = page.getByRole('combobox', { name: 'Expires', exact: true });
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('7');
  await expect(select).toBeFocused();
  await select.click();
  await expect(page.getByRole('option', { name: '7 days', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: '30 days', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear selection' }).first().click();
  await expect(page.getByRole('status', { name: 'Expiry value', exact: true })).toHaveText('null');
  await expect(select).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Disabled select', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Disabled search', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Empty select', exact: true }).click();
  await expect(page.getByText('No data', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const automatic = page.getByRole('combobox', { name: 'Automatic account', exact: true });
  await expect(automatic).toContainText('Automatic');
  await automatic.click();
  await expect(page.getByRole('option', { name: /Automatic/ })).toHaveAttribute('aria-selected', 'true');
  await outside(page, info);
  await expect(automatic).toHaveAttribute('aria-expanded', 'false');
  await attach(info, 'select', { selected: '7', cleared: true, disabled: true, empty: true, emptyStringIsSelection: true });
});

test('search preserves selection, filters groups, handles no results, composition and explicit clear', async ({ page }, info) => {
  const input = page.getByRole('combobox', { name: 'Workspace', exact: true });
  await expect(input).toHaveAccessibleDescription('Orbit workspace');
  await input.click();
  await expect(page.getByRole('group', { name: 'Local', exact: true })).toBeVisible();
  await input.fill('docs');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('output[aria-label="Workspace value"]')).toHaveText('docs');
  await expect(input).toBeFocused();
  await input.fill('missing');
  await expect(page.getByText('No data', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('output[aria-label="Workspace value"]')).toHaveText('docs');
  await input.click();
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true });
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('output[aria-label="Workspace value"]')).toHaveText('docs');
  await input.dispatchEvent('compositionend', { data: '文档' });
  await input.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await input.fill('文档');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Clear selection' }).nth(1).click();
  await expect(page.getByRole('status', { name: 'Workspace value', exact: true })).toHaveText('null');
  await expect(input).toBeFocused();
  await attach(info, 'search', { grouping: true, chinese: true, syntheticCompositionIgnored: true, escapePreservesValue: true, explicitClear: true });
});

test('remote search accepts server labels and resets an action picker without local filtering', async ({ page }, info) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/__choices-search?*', async (route) => {
    await gate;
    await route.fulfill({ json: [{ value: 'task-1', label: 'Server ranked result' }] });
  });
  const input = page.getByRole('combobox', { name: 'Add prerequisite', exact: true });
  await input.fill('query');
  await expect(input).toHaveAttribute('aria-busy', 'true');
  release();
  const option = page.getByRole('option', { name: 'Server ranked result', exact: true });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByRole('status', { name: 'Prerequisite', exact: true })).toHaveText('task-1');
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await attach(info, 'remote-search', { loadingExposed: true, filterDisabled: true, valueNullResetsQuery: true });
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy Modal' : 'Dialog'} owns choices, top-layer Escape, Tab and theme`, async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: legacy ? 'Open legacy Modal' : 'Open Dialog', exact: true });
  await tap(page, info, trigger);
  const dialog = page.getByRole('dialog', { name: legacy ? 'Legacy share' : 'Share workspace', exact: true });
  await settle(dialog);
  const input = dialog.getByRole('combobox', { name: 'Workspace', exact: true });
  await tap(page, info, input);
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  expect(await list.evaluate((el) => !!el.closest('[role="dialog"]'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(list).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  await tap(page, info, dialog.getByRole('combobox', { name: 'Expires', exact: true }));
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).not.toBeVisible();
  await expect(dialog).toBeVisible();
  const actions = dialog.getByRole('button', { name: 'Session actions', exact: true });
  await tap(page, info, actions);
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(actions).toBeFocused();
  for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < (legacy ? 3 : 12); i++) {
    await page.keyboard.press(key);
    const focusOwner = legacy ? page.locator('.legacy-choices-owner') : dialog;
    await expect.poll(() => focusOwner.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  expect(await page.evaluate(() => [document.body, document.documentElement].some((el) => /hidden|clip/.test(getComputedStyle(el).overflowY)))).toBe(true);
  await shot(info, 'choices-in-dialog', dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await attach(info, 'nested-choices', { legacy, topLayerOnly: true, portalInsideOwner: true, tabBothDirections: true, fullTabCycle: !legacy, scrollLocked: true, returned: true });
});

test('legacy host final Tab matches the AntD-only baseline, including its browser-focus boundary', async ({ page }, info) => {
  const results = {};
  for (const system of ['antd', 'orbit']) {
    await page.goto(`${fixture}${system === 'antd' ? '?legacyBaseline' : ''}`);
    await page.getByRole('button', { name: 'Open legacy Modal', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Legacy share', exact: true });
    await settle(dialog);
    await dialog.getByRole('button', { name: 'After choices', exact: true }).focus();
    await page.keyboard.press('Tab');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    results[system] = await page.evaluate(() => ({ body: document.activeElement === document.body,
      insideOwner: !!document.activeElement?.closest('.legacy-choices-owner') }));
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  }
  await attach(info, 'legacy-tab-baseline', results);
  expect(results.orbit).toEqual(results.antd);
});

test('popover owns a select and restores focus one layer at a time; tooltip responds to focus and hover', async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: 'Open context', exact: true });
  await tap(page, info, trigger);
  const popover = page.getByRole('dialog', { name: 'Context', exact: true });
  await expect(popover).toBeVisible();
  const select = popover.getByRole('combobox', { name: 'Context expiry', exact: true });
  await select.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeVisible();
  await expect(select).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const usage = page.getByRole('button', { name: 'Account usage', exact: true });
  await page.keyboard.press('Tab');
  await usage.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText('Usage from this account');
  await expect(usage).toHaveAttribute('aria-describedby', /.+/);
  await page.keyboard.press('Escape');
  await expect(tooltip).not.toBeVisible();
  await usage.blur();
  await usage.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tooltip).not.toBeVisible();
  await tap(page, info, trigger);
  await outside(page, info);
  await expect(popover).not.toBeVisible();
  await attach(info, 'popover-tooltip', { nestedSelect: true, sequentialEscape: true, focusReturn: true, tooltipFocusHoverEscape: true });
});


test('open choices follow the live system theme without losing selection', async ({ page }, info) => {
  const select = page.getByRole('combobox', { name: 'Expires', exact: true });
  await select.click();
  const popup = page.getByRole('listbox');
  await expect(popup).toBeVisible();
  const colors = {};
  for (const theme of [info.project.use.colorScheme === 'dark' ? 'light' : 'dark', info.project.use.colorScheme]) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.getByTestId('theme')).toHaveText(theme);
    await expect(popup).toBeVisible();
    const option = page.getByRole('option', { name: 'Never', exact: true });
    await expect(option).toHaveAttribute('aria-selected', 'true');
    colors[theme] = await option.evaluate((el) => ({ foreground: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
    expect(colors[theme].background).toBe(theme === 'dark' ? 'rgb(34, 61, 126)' : 'rgb(214, 232, 255)');
  }
  await attach(info, 'live-theme', colors);
});

test('Dialog keeps composition, outside dismissal, submenu Escape and keyboard clear within its owner', async ({ page }, info) => {
  await tap(page, info, page.getByRole('button', { name: 'Open Dialog', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'Share workspace', exact: true });
  const input = dialog.getByRole('combobox', { name: 'Workspace', exact: true });
  await tap(page, info, input);
  await expect(page.getByRole('listbox')).toBeVisible();
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true });
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(dialog).toBeVisible();
  await input.dispatchEvent('compositionend');
  await tap(page, info, page.getByRole('heading', { name: 'Share workspace', includeHidden: true }));
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await expect(dialog).toBeVisible();
  const actions = dialog.getByRole('button', { name: 'Session actions', exact: true });
  await tap(page, info, actions);
  await tap(page, info, page.getByRole('menuitem', { name: 'Provider', exact: true }));
  await expect(page.getByRole('menu')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await input.focus();
  await page.keyboard.press('Tab');
  const clear = dialog.getByRole('button', { name: 'Clear selection' }).nth(1);
  await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('status', { name: 'Workspace value', exact: true })).toHaveText('null');
  await expect(input).toBeFocused();
  await attach(info, 'dialog-boundaries', { compositionIgnored: true, outsideClosesChild: true, submenuEscapesOneLayer: true, keyboardClear: true });
});

for (const kind of ['multiple', 'tags']) test(`${kind} chip appearance matches current labels and email fields`, async ({ page }, info) => {
  const all = {};
  for (const state of ['default', 'disabled']) {
    const values = {};
    for (const system of ['antd', 'orbit']) {
      await page.goto(`${fixture}?sample=${kind}&system=${system}&state=${state}`);
      await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
      const control = page.locator('.sample-choice');
      await page.mouse.move(0, 0);
      await page.getByTestId('neutral').focus();
      await settle(control);
      values[system] = { control: await measure(control, true) };
      await shot(info, `${system}-${kind}-${state}`, control);
      if (state === 'disabled') await expect(control.getByRole('combobox')).toBeDisabled();
      if (state === 'default' && kind === 'multiple') {
        await control.getByRole('combobox').click();
        const surface = page.locator('.sample-surface:visible');
        await settle(surface);
        await page.mouse.move(0, 0);
        values[system].popup = await measure(surface);
        await shot(info, `${system}-multiple-options`, surface);
      }
    }
    all[state] = values;
  }
  await attach(info, 'multi-appearance', all);
  for (const values of Object.values(all)) expect(values.orbit).toEqual(values.antd);
});

test('multiple labels search, toggle, collapse, remove and clear without losing the remaining values', async ({ page }, info) => {
  const region = page.getByRole('region', { name: 'Multiple choices', exact: true });
  const input = region.getByRole('combobox', { name: 'Labels', exact: true });
  const value = region.locator('output[aria-label="Labels value"]');
  await input.fill('docs');
  await expect(page.getByRole('option', { name: 'Docs', exact: true })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(value).toHaveText('["bug","docs"]');
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option', { name: 'Docs', exact: true })).toHaveAttribute('aria-selected', 'true');
  await tap(page, info, page.getByRole('option', { name: 'Ops', exact: true }));
  await expect(value).toHaveText('["bug","docs","ops"]');
  await expect(region.getByLabel('1 more selected', { exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Archived', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await input.focus();
  await page.keyboard.press('Backspace');
  await expect(value).toHaveText('["bug","docs"]');
  await page.keyboard.press('Escape');
  await expect(input).toBeFocused();
  await region.getByRole('button', { name: 'Remove Bug', exact: true }).click();
  await expect(value).toHaveText('["docs"]');
  await expect(input).toBeFocused();
  await input.click();
  await page.getByRole('option', { name: 'Docs', exact: true }).click();
  await expect(value).toHaveText('[]');
  await page.getByRole('option', { name: 'Bug', exact: true }).click();
  await page.keyboard.press('Escape');
  await input.focus();
  await page.keyboard.press('Tab');
  await expect(region.getByRole('button', { name: 'Clear selection' }).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(value).toHaveText('[]');
  await expect(input).toBeFocused();
  await expect(region.getByRole('combobox', { name: 'Disabled labels', exact: true })).toBeDisabled();
  await attach(info, 'multiple-labels', { search: true, toggle: true, staysOpen: true, collapsedCount: true, removesHiddenLastValue: true, removeFocus: true, keyboardClear: true });
});

test('email tags support controlled typing, separators, composition, Enter, blur and deletion', async ({ page }, info) => {
  const region = page.getByRole('region', { name: 'Multiple choices', exact: true });
  const input = region.getByRole('combobox', { name: 'People to add', exact: true });
  const value = region.getByRole('status', { name: 'People value', exact: true });
  const query = region.getByRole('status', { name: 'People query', exact: true });
  await input.fill('first@orbit.test, second@orbit.test ');
  await expect(value).toHaveText('["owner@orbit.test","first@orbit.test","second@orbit.test"]');
  await expect(query).toHaveText('');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.fill('draft@orbit.test');
  await expect(query).toHaveText('draft@orbit.test');
  await page.keyboard.press('Enter');
  await expect(value).toContainText('draft@orbit.test');
  await input.dispatchEvent('compositionstart');
  await input.fill('中文@orbit.test');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await expect(value).not.toContainText('中文@orbit.test');
  await input.dispatchEvent('compositionend');
  await page.keyboard.press('Enter');
  await expect(value).toContainText('中文@orbit.test');
  await input.fill('blur@orbit.test');
  await region.getByRole('button', { name: 'After tags' }).click();
  await expect(value).toContainText('blur@orbit.test');
  await expect(query).toHaveText('');
  await input.focus();
  await page.keyboard.press('Backspace');
  await expect(value).not.toContainText('blur@orbit.test');
  await region.getByRole('button', { name: 'Remove first@orbit.test', exact: true }).click();
  await expect(value).not.toContainText('first@orbit.test');
  await expect(input).toBeFocused();
  await input.fill('owner@orbit.test ');
  const emails = JSON.parse(await value.textContent());
  expect(emails.filter((email) => email === 'owner@orbit.test')).toHaveLength(1);
  await input.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(value).toHaveText('[]');
  await attach(info, 'email-tags', { controlledQuery: true, commaSpace: true, enter: true, blurCommits: true, syntheticComposition: true, backspace: true, remove: true, deduplicated: true, keyboardClear: true });
});

test('multiple choices in Dialog keep their owner and menus do not activate a clickable row', async ({ page }, info) => {
  const trigger = page.getByRole('button', { name: 'Open multi Dialog', exact: true });
  await tap(page, info, trigger);
  const dialog = page.getByRole('dialog', { name: 'Multiple choices', exact: true });
  const input = dialog.getByRole('combobox', { name: 'Labels', exact: true });
  await tap(page, info, input);
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  expect(await list.evaluate((el) => !!el.closest('[role="dialog"]'))).toBe(true);
  await tap(page, info, page.getByRole('option', { name: 'Docs', exact: true }));
  await expect(dialog.locator('output[aria-label="Labels value"]')).toHaveText('["bug","docs"]');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).not.toBeVisible();
  await expect(input).toBeFocused();
  const tags = dialog.getByRole('combobox', { name: 'People to add', exact: true });
  await tags.focus();
  await tags.dispatchEvent('compositionstart');
  await tags.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true });
  await expect(dialog).toBeVisible();
  await tags.dispatchEvent('compositionend');
  await tags.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  const menu = page.getByRole('button', { name: 'Row actions', exact: true });
  await tap(page, info, menu);
  await tap(page, info, page.getByRole('menuitem', { name: 'Run action', exact: true }));
  await expect(page.getByRole('status', { name: 'Row actions', exact: true })).toHaveText('1');
  await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('0');
  await menu.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Row actions', exact: true })).toHaveText('2');
  await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('0');
  await page.getByRole('button', { name: 'Open row', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Row clicks', exact: true })).toHaveText('1');
  await attach(info, 'multi-dialog-and-row', { portalInsideOwner: true, sequentialEscape: true, compositionIgnored: true, focusReturn: true, pointerAndKeyboardStopRowClick: true });
});

test('search option touch selects once and preserves input focus', async ({ page }, info) => {
  const region = page.getByRole('region', { name: 'Standalone choices', exact: true });
  const input = region.getByRole('combobox', { name: 'Workspace', exact: true });
  await input.fill('Docs');
  await tap(page, info, page.getByRole('option', { name: '文档 Docs', exact: true }));
  await expect(region.getByRole('status', { name: 'Workspace value', exact: true })).toHaveText('docs');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await attach(info, 'search-touch', { selected: 'docs', focusKept: true, input: info.project.use.hasTouch ? 'touch' : 'mouse' });
});

test('disabled-button and long tooltips remain accessible; a plan-usage-sized popover fits the screen', async ({ page }, info) => {
  await page.keyboard.press('Tab');
  const disabledWrapper = page.getByRole('button', { name: 'Unavailable action', exact: true }).locator('..');
  await disabledWrapper.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Runner is offline');
  await expect(disabledWrapper).toHaveAttribute('aria-describedby', /.+/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  const longHelp = page.getByRole('button', { name: 'Long help', exact: true });
  await longHelp.focus();
  const tooltip = page.getByRole('tooltip');
  await settle(tooltip);
  const tipBox = await tooltip.boundingBox();
  expect(tipBox.width).toBeLessThanOrEqual(250);
  expect(tipBox.height).toBeGreaterThan(34);
  expect(tipBox.x).toBeGreaterThanOrEqual(8);
  expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(info.project.use.viewport.width - 8);
  await shot(info, 'long-tooltip', tooltip);
  await page.keyboard.press('Escape');
  const trigger = page.getByRole('button', { name: 'Plan usage panel', exact: true });
  await tap(page, info, trigger);
  const popover = page.getByRole('dialog', { name: 'Plan usage', exact: true });
  await settle(popover);
  const box = await popover.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(info.project.use.viewport.width - 8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(info.project.use.viewport.width);
  await shot(info, 'plan-usage-sized-popover', popover);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await attach(info, 'tooltip-and-popover-edges', { disabledButtonDescription: true, tooltip: tipBox, popover: box, horizontalOverflow: false });
});
