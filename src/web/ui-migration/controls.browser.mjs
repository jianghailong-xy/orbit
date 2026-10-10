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
      // An illustration's <title> names it; it is not painted text.
      if (walker.currentNode.parentElement?.closest('svg')) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      texts.push(rect(range.getBoundingClientRect()));
    }
    const icons = [...element.querySelectorAll('svg')].map((icon) => {
      // The loading glyph rotates continuously; compare its layout box and SVG
      // size, not two animation phases sampled at different instants.
      const frame = icon.closest('.orbit-button-icon') || icon;
      return { ...rect(frame.getBoundingClientRect()), svgWidth: getComputedStyle(icon).width, svgHeight: getComputedStyle(icon).height };
    });
    return { texts, icons };
  });
}

// The P4.3a composites, part by part: each is a selector inside the case's root; '' is the root itself.
// Each part is measured for its box, margins, text and surface, and for where it sits inside its root.
// A card head's own font and corner radius are not painted (the title and extra carry their own text, and
// the head has no fill), so they are left out for that part.
const PART_PROPERTIES = [...surfaceProperties, 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'display', 'visibility',
  'textAlign', 'wordBreak', 'backgroundImage', 'backgroundSize', 'opacity'];
const UNPAINTED = { '.orbit-card-head': ['fontSize', 'fontWeight', 'lineHeight', 'borderRadius'], '.orbit-card-body': ['borderRadius'] };
const COMPOSITE_PARTS = {
  alert: ['', '.orbit-alert-icon', '.orbit-alert-title', '.orbit-alert-description', '.orbit-alert-actions'],
  card: ['', '.orbit-card-head', '.orbit-card-title', '.orbit-card-extra', '.orbit-card-body'],
  empty: ['', '.orbit-empty-image', 'svg', '.orbit-empty-description', '.orbit-empty-footer'],
  skeleton: ['.orbit-skeleton', '.orbit-skeleton-section', '.orbit-skeleton-paragraph',
    ...[0, 1, 2].map((n) => `.orbit-skeleton-paragraph > li:nth-child(${n + 1})`)],
  typography: ['', 'code', 'strong', '.orbit-typography-copy'],
  list: ['', '.orbit-list-items', ...[0, 1].flatMap((n) => [
    `.orbit-list-item:nth-child(${n + 1})`,
    `.orbit-list-item:nth-child(${n + 1}) .orbit-list-item-meta`,
    `.orbit-list-item:nth-child(${n + 1}) .orbit-list-item-meta-content`,
    `.orbit-list-item:nth-child(${n + 1}) .orbit-list-item-meta-title`,
    `.orbit-list-item:nth-child(${n + 1}) .orbit-list-item-meta-description`])],
  // The frame, the text field and the clear control, and every glyph's position.
  'input-clear': ['', '.orbit-input-field', '.orbit-input-clear'],
};
const compositeOf = (name) => Object.keys(COMPOSITE_PARTS).find((kind) => name.startsWith(kind));

async function partMeasurement(root, selector) {
  const part = selector ? root.locator(selector).first() : root;
  if (!(await part.count())) return { present: false };
  const keys = PART_PROPERTIES.filter((key) => !(UNPAINTED[selector] ?? []).includes(key));
  return part.evaluate((element, { keys, rootElement }) => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect(), base = rootElement.getBoundingClientRect();
    return { present: true, left: rect.left - base.left, top: rect.top - base.top, width: rect.width, height: rect.height,
      ...Object.fromEntries(keys.map((key) => [key, style[key]])) };
  }, { keys, rootElement: await root.elementHandle() });
}

/** Each painted shape of an illustration: its computed fill, stroke and opacity, in document order. */
const shapes = (root) => root.evaluate((element) => [...element.querySelectorAll('svg ellipse, svg path, svg circle')].map((shape) => {
  const style = getComputedStyle(shape);
  return { fill: style.fill, fillOpacity: style.fillOpacity, stroke: style.stroke, d: shape.getAttribute('d') ?? shape.tagName };
}));

function sample(page, name) {
  return page.locator(`[data-case="${name}"] [data-side="orbit"] > :nth-child(2)`);
}

async function open(page, info) {
  await page.goto(fixture);
  await expect(page.getByTestId('theme')).toHaveText(`Theme: ${info.project.use.colorScheme}`);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
    .toEqual({ width: info.project.use.viewport.width, dpr: 1, scale: 1 });
}

test('fixed control states keep the frozen P0 palette', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, info);
  const measured = {};
  const record = (name, actual) => { measured[name] = { orbit: actual }; };
  const measure = async (name, orbit, properties = surfaceProperties, pseudo) => {
    record(name, await measurement(orbit, properties, pseudo));
  };
  const measureContent = async (name, orbit) => {
    const actual = await contentGeometry(orbit);
    for (const kind of ['texts', 'icons']) {
      record(`${name} ${kind} count`, { count: actual[kind].length });
      actual[kind].forEach((entry, index) => record(`${name} ${kind} ${index}`, entry));
    }
  };
  for (const name of await page.locator('[data-case]').evaluateAll((rows) => rows.map((row) => row.dataset.case))) {
    const orbit = sample(page, name);
    if (name.startsWith('checkbox')) {
      await measure(name, orbit, []);
      await measure(`${name} label`, orbit.locator('.orbit-choice-label'), textProperties);
      await measure(`${name} box`, orbit.locator('.orbit-checkbox'), ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderRadius']);
      if (name !== 'checkbox') await measure(`${name} mark`, orbit.locator('.orbit-checkbox'),
        ['width', 'height', 'top', 'left', 'backgroundColor', 'borderRightWidth', 'borderRightColor', 'borderBottomWidth', 'borderBottomColor', 'opacity', 'transform'], '::after');
      await measureContent(name, orbit);
    } else if (name === 'radio') {
      await measure(name, orbit, []);
      for (let index = 0; index < 3; index++) {
        await measure(`${name} ${index} label`, orbit.locator('.orbit-choice-label').nth(index), textProperties);
        await measure(`${name} ${index} box`, orbit.locator('.orbit-radio').nth(index), ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderRadius']);
      }
      await measure(`${name} checked mark`, orbit.locator('.orbit-radio').first(),
        ['width', 'height', 'top', 'left', 'backgroundColor', 'borderRadius', 'opacity', 'transform'], '::after');
      await measureContent(name, orbit);
    } else if (name.startsWith('radio-button')) {
      await measure(name, orbit, []);
      for (let index = 0; index < 3; index++) await measure(`${name} ${index}`, orbit.locator('.orbit-radio-button').nth(index));
      await measureContent(name, orbit);
    } else if (name.startsWith('switch')) {
      await measure(name, orbit, [...surfaceProperties, 'opacity']);
      await measure(`${name} thumb geometry`, orbit.locator('.orbit-switch-thumb'), ['top', 'left']);
      const thumb = await measurement(orbit.locator('.orbit-switch-thumb'), ['backgroundColor', 'boxShadow']);
      record(`${name} thumb surface`, { backgroundColor: thumb.backgroundColor, boxShadow: thumb.boxShadow });
    } else if (name.startsWith('spinner')) {
      await measure(name, orbit, ['color']);
      // Layout sizes and animation timing, not a rotating bounding box sampled at a moment.
      const motion = (locator) => locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(['width', 'height', 'animationDuration', 'animationDelay',
          'animationIterationCount', 'animationTimingFunction', 'animationDirection'].map((key) => [key, style[key]]));
      });
      record(`${name} rotation`, await motion(orbit.locator('.orbit-spinner-dots')));
      for (let index = 0; index < 4; index++) record(`${name} dot ${index}`, await motion(orbit.locator('i').nth(index)));
    } else if (compositeOf(name)) {
      for (const part of COMPOSITE_PARTS[compositeOf(name)]) record(`${name} ${part || 'root'}`, await partMeasurement(orbit, part));
      if (name.startsWith('empty')) {
        const actual = await shapes(orbit);
        record(`${name} shapes count`, { count: actual.length });
        actual.forEach((shape, index) => record(`${name} shape ${index}`, shape));
      }
      if (name.startsWith('skeleton')) {
        const motion = (locator) => locator.evaluate((element) => {
          const style = getComputedStyle(element);
          return Object.fromEntries(['animationName', 'animationDuration', 'animationTimingFunction', 'animationIterationCount']
            .map((key) => [key, key === 'animationName' ? (style[key] === 'none' ? 'none' : 'named') : style[key]]));
        });
        record(`${name} motion`, await motion(orbit.locator('li').first()));
      }
      await measureContent(name, orbit);
    } else {
      await measure(name, orbit);
      if (name.startsWith('button') || name.startsWith('badge')) await measureContent(name, orbit);
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
  await info.attach('computed-controls', { body: JSON.stringify({ theme, measured, fontProbe, errors }, null, 2), contentType: 'application/json' });
  await info.attach('controls-states', { body: await page.screenshot({ fullPage: true, animations: 'disabled' }), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('hover and keyboard focus preserve visible control feedback', async ({ page }, info) => {
  await open(page, info);
  const measured = {};
  for (const name of ['button-middle', 'button-primary', 'button-text', 'button-link', 'button-danger-default', 'button-danger-primary', 'button-danger-text',
    'button-disabled', 'button-disabled-default', 'button-disabled-text', 'button-disabled-link', 'button-disabled-danger', 'button-disabled-danger-text',
    'input-middle', 'input-invalid', 'input-warning', 'textarea']) {
    const orbit = sample(page, name);
    await orbit.hover();
    // Let the control's normal transition settle; no injected CSS changes states.
    await orbit.hover();
    await orbit.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    measured[`${name} hover`] = { orbit: await measurement(orbit) };
  }
  await page.getByRole('heading', { level: 1 }).click();
  await page.keyboard.press('Tab');
  const focusStyle = (locator) => locator.evaluate((element) => ({ visible: element.matches(':focus-visible'),
    outline: getComputedStyle(element).outline, offset: getComputedStyle(element).outlineOffset,
    borderColor: getComputedStyle(element).borderColor, boxShadow: getComputedStyle(element).boxShadow }));
  for (const name of ['button-primary', 'input-middle', 'input-invalid', 'input-warning', 'textarea']) {
    const orbit = sample(page, name);
    await orbit.focus();
    const actual = await focusStyle(orbit);
    expect(actual.visible).toBe(true);
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

test('a focused field under the pointer stays hovered and focused; its 601–961px sizes are recorded', async ({ page }, info) => {
  // P3.1 regression: the shared text-control rules let hover outrank focus.
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
    const orbit = sample(page, name);
    await orbit.click();
    measured[`${name} orbit`] = await state(orbit);
    expect(measured[`${name} orbit`]).toMatchObject({ hovered: true, focused: true });
  }
  if (!info.project.use.isMobile) {
    await page.mouse.move(0, 0);
    for (const width of [601, 800, 959, 961]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['input-middle', 'input-affix', 'textarea']) {
        const { fontSize, lineHeight, height } = await state(sample(page, name));
        measured[`${name} ${width}px`] = { orbit: { fontSize, lineHeight, height } };
      }
    }
  }
  await info.attach('focused-hover-and-breakpoint', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
});
