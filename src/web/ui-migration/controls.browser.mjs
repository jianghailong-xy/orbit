import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const fixture = '/ui-migration/controls.html';
const textProperties = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'];
const surfaceProperties = [...textProperties, 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderTopStyle',
  'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxShadow'];

async function measurement(locator, properties = surfaceProperties, pseudo) {
  return locator.evaluate((element, { keys, pseudo }) => {
    const style = getComputedStyle(element, pseudo), rect = element.getBoundingClientRect();
    return { ...(pseudo ? {} : { width: rect.width, height: rect.height }), ...Object.fromEntries(keys.map((key) => [key, style[key]])) };
  }, { keys: properties, pseudo });
}

// Compare painted text and icons relative to each control, including baseline
// alignment. Text ranges avoid comparing nonpainted wrapper inheritance.
async function contentGeometry(locator) {
  return locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const rect = (value) => ({ left: value.left - root.left, top: value.top - root.top, width: value.width, height: value.height });
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      texts.push(rect(range.getBoundingClientRect()));
    }
    const icons = [...element.querySelectorAll('svg')].map((icon) => {
      // The loading glyph rotates continuously; compare its layout box and SVG
      // size, not two animation phases sampled at different instants.
      const frame = icon.closest('.orbit-button-icon, .ant-btn-icon') || icon;
      return { ...rect(frame.getBoundingClientRect()), svgWidth: getComputedStyle(icon).width, svgHeight: getComputedStyle(icon).height };
    });
    return { texts, icons };
  });
}

function sides(page, name) {
  const row = page.locator(`[data-case="${name}"]`);
  return { orbit: row.locator('[data-side="orbit"] > :nth-child(2)'), ant: row.locator('[data-side="ant"] > :nth-child(2)') };
}

async function open(page, info) {
  await page.goto(fixture);
  await expect(page.getByTestId('theme')).toHaveText(`Theme: ${info.project.use.colorScheme}`);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
    .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
}

test('fixed control states match AntD geometry, typography and surfaces', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, info);
  const measured = {}, differences = [];
  const record = (name, actual, reference) => {
    measured[name] = { orbit: actual, ant: reference };
    for (const key of Object.keys(actual)) {
      // Layout coordinates may lie on different fractional columns; one CSS subpixel
      // (1/64 px) is the browser's layout rounding, not a visual-diff allowance.
      if (typeof actual[key] === 'number' && Math.abs(actual[key] - reference[key]) <= 1 / 64) continue;
      if (actual[key] !== reference[key]) differences.push({ case: name, property: key, orbit: actual[key], ant: reference[key] });
    }
  };
  const compare = async (name, orbit, ant, properties = surfaceProperties, pseudo) => {
    record(name, await measurement(orbit, properties, pseudo), await measurement(ant, properties, pseudo));
  };
  const compareContent = async (name, orbit, ant) => {
    const actual = await contentGeometry(orbit), reference = await contentGeometry(ant);
    for (const kind of ['texts', 'icons']) {
      record(`${name} ${kind} count`, { count: actual[kind].length }, { count: reference[kind].length });
      for (let index = 0; index < Math.min(actual[kind].length, reference[kind].length); index++) {
        record(`${name} ${kind} ${index}`, actual[kind][index], reference[kind][index]);
      }
    }
  };
  for (const name of await page.locator('[data-case]').evaluateAll((rows) => rows.map((row) => row.dataset.case))) {
    const { orbit, ant } = sides(page, name);
    if (name.startsWith('checkbox')) {
      await compare(name, orbit, ant, []);
      await compare(`${name} label`, orbit.locator('.orbit-choice-label'), ant.locator('.ant-checkbox-label'), textProperties);
      await compare(`${name} box`, orbit.locator('.orbit-checkbox'), ant.locator('.ant-checkbox'), ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderRadius']);
      if (name !== 'checkbox') await compare(`${name} mark`, orbit.locator('.orbit-checkbox'), ant.locator('.ant-checkbox'),
        ['width', 'height', 'top', 'left', 'backgroundColor', 'borderRightWidth', 'borderRightColor', 'borderBottomWidth', 'borderBottomColor', 'opacity', 'transform'], '::after');
      await compareContent(name, orbit, ant);
    } else if (name === 'radio') {
      await compare(name, orbit, ant, []);
      for (let index = 0; index < 3; index++) {
        await compare(`${name} ${index} label`, orbit.locator('.orbit-choice-label').nth(index), ant.locator('.ant-radio-label').nth(index), textProperties);
        await compare(`${name} ${index} box`, orbit.locator('.orbit-radio').nth(index), ant.locator('.ant-radio').nth(index), ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderRadius']);
      }
      await compare(`${name} checked mark`, orbit.locator('.orbit-radio').first(), ant.locator('.ant-radio').first(),
        ['width', 'height', 'top', 'left', 'backgroundColor', 'borderRadius', 'opacity', 'transform'], '::after');
      await compareContent(name, orbit, ant);
    } else if (name.startsWith('radio-button')) {
      await compare(name, orbit, ant, []);
      for (let index = 0; index < 3; index++) {
        await compare(`${name} ${index}`, orbit.locator('.orbit-radio-button').nth(index), ant.locator('.ant-radio-button-wrapper').nth(index));
      }
      await compareContent(name, orbit, ant);
    } else if (name.startsWith('switch')) {
      await compare(name, orbit, ant, [...surfaceProperties, 'opacity']);
      await compare(`${name} thumb geometry`, orbit.locator('.orbit-switch-thumb'), ant.locator('.ant-switch-handle'), ['top', 'left']);
      const thumb = await measurement(orbit.locator('.orbit-switch-thumb'), ['backgroundColor', 'boxShadow']);
      record(`${name} thumb surface`, { backgroundColor: thumb.backgroundColor, boxShadow: thumb.boxShadow },
        await measurement(ant.locator('.ant-switch-handle'), ['backgroundColor', 'boxShadow'], '::before'));
    } else if (name.startsWith('spinner')) {
      await compare(name, orbit, ant, ['color']);
      // Compare layout sizes and animation timing, not a rotating bounding box
      // sampled at different moments. AntSpin continues moving in reduced motion.
      const motion = (locator) => locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(['width', 'height', 'animationDuration', 'animationDelay',
          'animationIterationCount', 'animationTimingFunction', 'animationDirection'].map((key) => [key, style[key]]));
      });
      record(`${name} rotation`, await motion(orbit.locator('.orbit-spinner-dots')), await motion(ant.locator('.ant-spin-dot-spin')));
      for (let index = 0; index < 4; index++) {
        record(`${name} dot ${index}`, await motion(orbit.locator('i').nth(index)), await motion(ant.locator('.ant-spin-dot-item').nth(index)));
      }
    } else {
      await compare(name, orbit, ant);
      if (name.startsWith('button') || name.startsWith('badge')) await compareContent(name, orbit, ant);
    }
  }
  // Anchor the primary control palette and dimensions to immutable P0 evidence.
  const theme = info.project.use.colorScheme;
  const p0 = JSON.parse(readFileSync(new URL(`../../../docs/evidence/base-ui-migration/p0.2/baseline-run/chromium-${theme}-desktop--task--computed-styles-and-timings.json`, import.meta.url)));
  const primary = p0.captures.flatMap((capture) => capture.controls).find((control) => control.label === 'Run now');
  expect(measured['button-primary'].orbit.backgroundColor).toBe(primary.style.backgroundColor);
  expect(measured['button-primary'].orbit.height).toBe(primary.rect.height);
  expect(measured['button-primary'].orbit.borderRadius).toBe(primary.style.borderRadius);
  const fontProbe = await page.evaluate(() => {
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
    context.font = `${getComputedStyle(document.querySelector('.controls-page')).fontSize} ${getComputedStyle(document.querySelector('.controls-page')).fontFamily}`;
    return { text: 'Orbit baseline 0123 — 中文输入', width: context.measureText('Orbit baseline 0123 — 中文输入').width, font: context.font };
  });
  await info.attach('computed-controls', { body: JSON.stringify({ theme, measured, differences, fontProbe, errors }, null, 2), contentType: 'application/json' });
  await info.attach('controls-state-comparison', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
  expect(errors).toEqual([]);
  expect(differences).toEqual([]);
});

test('hover and keyboard focus preserve visible control feedback', async ({ page }, info) => {
  await open(page, info);
  const measured = {};
  for (const name of ['button-middle', 'button-primary', 'button-text', 'button-link', 'button-danger-default', 'button-danger-primary', 'button-danger-text',
    'button-disabled', 'button-disabled-default', 'button-disabled-text', 'button-disabled-link', 'button-disabled-danger', 'button-disabled-danger-text',
    'input-middle', 'input-invalid', 'textarea']) {
    const { orbit, ant } = sides(page, name);
    await orbit.hover();
    // Let each library's normal transition settle; no injected CSS changes states.
    await orbit.hover();
    await orbit.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const actual = await measurement(orbit);
    await ant.hover();
    await ant.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    const reference = await measurement(ant);
    measured[`${name} hover`] = { orbit: actual, ant: reference };
    expect(actual, `${name} hover`).toEqual(reference);
  }
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Tab');
  const focusStyle = (locator) => locator.evaluate((element) => ({ visible: element.matches(':focus-visible'),
    outline: getComputedStyle(element).outline, offset: getComputedStyle(element).outlineOffset,
    borderColor: getComputedStyle(element).borderColor, boxShadow: getComputedStyle(element).boxShadow }));
  for (const name of ['button-primary', 'input-middle', 'input-invalid', 'textarea']) {
    const { orbit, ant } = sides(page, name);
    await orbit.focus();
    const actual = await focusStyle(orbit);
    expect(actual.visible).toBe(true);
    await ant.focus();
    await expect.poll(() => focusStyle(ant)).toEqual(actual);
    measured[`${name} focus`] = actual;
  }
  await info.attach('hover-focus-controls', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});

test('keyboard, labels, loading, disabled and native form values work', async ({ page }, info) => {
  await open(page, info);
  const region = page.getByRole('region', { name: 'Interactive controls' });
  const activate = region.getByRole('button', { name: 'Activate', exact: true });
  await activate.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(region.getByLabel('Activation count')).toHaveText('2');
  await page.keyboard.press('Tab');
  await expect(region.getByRole('button', { name: 'Loading action', exact: true })).toBeFocused();
  for (const name of ['Disabled action', 'Loading action']) {
    const button = region.getByRole('button', { name, exact: true });
    await expect(button).toBeDisabled();
    await button.evaluate((element) => element.click());
  }
  const loading = region.getByRole('button', { name: 'Loading action', exact: true });
  await loading.focus();
  await expect(loading).toBeFocused();
  await expect(loading).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(region.getByLabel('Activation count')).toHaveText('2');
  const checkbox = region.getByRole('checkbox', { name: 'Controlled checkbox', exact: true });
  await region.getByText('Controlled checkbox', { exact: true }).click();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press('Tab');
  await checkbox.focus();
  await expect(checkbox).toHaveCSS('outline-width', '3px');
  await expect(checkbox).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Space');
  await expect(checkbox).not.toBeChecked();
  const group = region.getByRole('radiogroup', { name: 'Controlled choice' });
  await group.getByRole('radio', { name: 'First choice', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(group.getByRole('radio', { name: 'Second choice', exact: true })).toBeChecked();
  await expect(group.getByRole('radio', { name: 'Second choice', exact: true })).toBeFocused();
  await expect(group.getByRole('radio', { name: 'Second choice', exact: true })).toHaveCSS('outline-width', '3px');
  await expect(group.getByRole('radio', { name: 'Unavailable choice' })).toBeDisabled();
  const toggle = region.getByRole('switch', { name: 'Controlled switch', exact: true });
  await toggle.focus();
  await expect(toggle).toHaveCSS('outline-width', '3px');
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect(region.getByRole('switch', { name: 'Loading switch' })).toBeDisabled();
  await region.getByRole('switch', { name: 'Loading switch' }).evaluate((element) => element.click());
  await expect(region.getByLabel('Activation count')).toHaveText('2');
  const mixed = page.locator('[data-case="checkbox-mixed"] [data-side="orbit"]').getByRole('checkbox');
  await expect(mixed).toHaveAttribute('aria-checked', 'mixed');
  const form = region.getByRole('form', { name: 'Native form' });
  await form.getByRole('textbox', { name: 'Project name' }).fill('Updated project');
  await form.getByRole('textbox', { name: 'Description' }).fill('First\nUpdated second');
  await form.getByText('Accept updates', { exact: true }).click();
  await form.getByRole('button', { name: 'Submit form' }).click();
  await expect(region.getByLabel('Submitted values')).toHaveText(JSON.stringify({ project: 'Updated project', description: 'First\nUpdated second', accepted: 'yes', mode: 'two', notifications: 'enabled' }));
  await form.getByRole('button', { name: 'Reset form' }).click();
  await expect(form.getByRole('textbox', { name: 'Project name' })).toHaveValue('Orbit');
  await expect(form.getByRole('textbox', { name: 'Description' })).toHaveValue('Fixed text');
  const externalCheckbox = region.getByRole('checkbox', { name: 'External checkbox', exact: true });
  await expect(externalCheckbox).toBeChecked();
  await region.getByText('External checkbox', { exact: true }).click();
  await expect(externalCheckbox).not.toBeChecked();
  const explicitCheckbox = region.getByRole('checkbox', { name: 'Explicit checkbox name', exact: true });
  await expect(explicitCheckbox).toBeVisible();
  await region.getByText('Visible checkbox text', { exact: true }).click();
  await expect(explicitCheckbox).toBeChecked();
  const externalRadios = region.getByRole('radiogroup', { name: 'External labels', exact: true });
  await region.getByText('External radio two', { exact: true }).click();
  await expect(externalRadios.getByRole('radio', { name: 'External radio two', exact: true })).toBeChecked();
  const affix = page.locator('[data-case="input-affix"] [data-side="orbit"]');
  await affix.locator('.anticon-search').click();
  await expect(affix.getByRole('textbox', { name: 'Search' })).toBeFocused();
  await page.keyboard.type('typed through prefix');
  await expect(affix.getByRole('textbox', { name: 'Search' })).toHaveValue('typed through prefix');
  const link = region.getByRole('link', { name: 'Open target' });
  await expect(link).toHaveAttribute('href', '#fixture-link-target');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#fixture-link-target$/);
  await info.attach('behavior-controls', { body: JSON.stringify({ activationCount: 2, radioArrowSkipsDisabled: true, checkboxLabelAndSpace: true,
    switchSpace: true, disabledAndLoadingBlocked: true, mixedExposed: true, values: await region.getByLabel('Submitted values').textContent(), nativeTextReset: true }, null, 2), contentType: 'application/json' });
  await info.attach('interactive-controls', { body: await region.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
});

test('a focused field under the pointer and the 601–960px font size match AntD', async ({ page }, info) => {
  // P3.1 regression: the shared text-control rules let hover outrank focus, and lifted unadorned
  // fields to 16px only at ≤600px where index.css lifts the AntD fields at ≤960px.
  await open(page, info);
  const state = (locator) => locator.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
    const field = element.matches('input, textarea') ? element : element.querySelector('input');
    const style = getComputedStyle(element);
    return { hovered: element.matches(':hover'), focused: element.matches(':focus-within'), borderColor: style.borderColor,
      boxShadow: style.boxShadow, fontSize: getComputedStyle(field).fontSize, lineHeight: getComputedStyle(field).lineHeight,
      height: element.getBoundingClientRect().height };
  });
  const measured = {};
  for (const name of ['input-middle', 'input-invalid', 'input-affix', 'textarea', 'textarea-invalid']) {
    const { orbit, ant } = sides(page, name);
    for (const [side, locator] of [['orbit', orbit], ['ant', ant]]) {
      await locator.click();
      measured[`${name} ${side}`] = await state(locator);
    }
    expect(measured[`${name} orbit`]).toMatchObject({ hovered: true, focused: true });
    expect(measured[`${name} orbit`], `${name} focused under the pointer`).toEqual(measured[`${name} ant`]);
  }
  if (!info.project.use.isMobile) {
    await page.mouse.move(0, 0);
    for (const width of [601, 800, 959, 961]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['input-middle', 'input-affix', 'textarea']) {
        const { orbit, ant } = sides(page, name);
        const size = async (locator) => {
          const { fontSize, lineHeight, height } = await state(locator);
          return { fontSize, lineHeight, height };
        };
        measured[`${name} ${width}px`] = { orbit: await size(orbit), ant: await size(ant) };
        expect(measured[`${name} ${width}px`].orbit, `${name} at ${width}px`).toEqual(measured[`${name} ${width}px`].ant);
      }
    }
  }
  await info.attach('focused-hover-and-breakpoint', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});
