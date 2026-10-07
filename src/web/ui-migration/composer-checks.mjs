import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Helpers for composer*.browser.mjs. Every check runs the same script against the fixture's AntD
// field (?impl=ant, what WorkspaceView/TaskDetailPanel render today) and the Orbit Textarea, then
// compares what the browser reports. Nothing here injects styles except the explicit glyph probe.

export const IMPLS = ['ant', 'orbit'];
// AntD keeps its hidden measuring textarea in <body>; the field under test is the labelled one.
export const FIELD = 'textarea[aria-label]';

export const STYLE = ['display', 'boxSizing', 'width', 'height', 'minHeight', 'maxHeight', 'overflowX', 'overflowY', 'resize',
  'verticalAlign', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom',
  'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderBottomWidth', 'borderLeftColor', 'borderRadius',
  'backgroundColor', 'color', 'webkitTextFillColor', 'caretColor', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'textRendering', 'fontVariant',
  'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'boxShadow', 'outlineStyle', 'outlineWidth', 'outlineColor',
  'outlineOffset', 'cursor', 'textOverflow', 'position', 'zIndex', 'opacity', 'transform', 'flexGrow', 'flexShrink', 'flexBasis'];
// Transitions are compared on their own: under prefers-reduced-motion Orbit text controls do not
// animate (P1.2/P2.1 rule) while AntD keeps 0.3s; with normal motion they must be equal.
export const MOTION = ['transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'transitionDelay'];

export function fixtureUrl(impl, scenario = 'session', query = '') {
  return `/ui-migration/composer.html?impl=${impl}&scenario=${scenario}${query}`;
}

export async function open(page, info, impl, scenario = 'session', query = '') {
  await page.goto(fixtureUrl(impl, scenario, query));
  await expect(page.getByTestId('theme')).toHaveText(info.project.use.colorScheme);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport.scale })))
    .toEqual({ width: page.viewportSize().width, dpr: 1, scale: 1 });
  const field = page.locator(FIELD);
  await expect(field).toBeVisible();
  return field;
}

/** Two frames, then every running transition/animation in the document has finished. */
export async function settle(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/** Geometry, inline auto-size style and computed style of the field and everything aligned to it. */
export async function fieldState(page, { motion = false } = {}) {
  return page.evaluate(({ FIELD, STYLE, MOTION, motion }) => {
    const field = document.querySelector(FIELD);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const pick = (style, keys) => Object.fromEntries(keys.map((key) => [key, style[key]]));
    const placeholder = getComputedStyle(field, '::placeholder');
    const mirror = document.querySelector('.composer-mirror');
    const content = (() => {
      const style = getComputedStyle(field);
      const r = field.getBoundingClientRect();
      const left = r.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const top = r.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
      return { left, top, width: field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    })();
    return {
      value: field.value,
      focused: document.activeElement === field,
      field: rect(field),
      content,
      inline: {
        height: field.style.height, minHeight: field.style.minHeight, maxHeight: field.style.maxHeight,
        overflowY: field.style.overflowY, overflowX: field.style.overflowX, resize: field.style.resize,
      },
      computed: pick(getComputedStyle(field), motion ? [...STYLE, ...MOTION] : STYLE),
      placeholder: pick(placeholder, ['color', 'webkitTextFillColor', 'opacity', 'fontSize', 'lineHeight']),
      scroll: { scrollHeight: field.scrollHeight, clientHeight: field.clientHeight, clientWidth: field.clientWidth, scrollTop: field.scrollTop },
      box: rect(document.querySelector('.composer-box, .tdp-compose')),
      composerField: rect(document.querySelector('.composer-field')),
      mirror: mirror ? { ...rect(mirror), scrollTop: mirror.scrollTop, scrollHeight: mirror.scrollHeight,
        computed: pick(getComputedStyle(mirror), ['fontFamily', 'fontSize', 'lineHeight', 'paddingTop', 'paddingLeft', 'paddingRight', 'whiteSpace', 'wordBreak', 'overflowWrap']) } : null,
      attachments: rect(document.querySelector('.composer-attachments')),
      thumbnails: [...document.querySelectorAll('.composer-attach, .composer-file')].map(rect),
      toolbar: rect(document.querySelector('.composer-toolbar')),
      menu: rect(document.querySelector('.composer-slash-menu, .tdp-mention-menu')),
      handle: !!document.querySelector('.composer-resize-handle'),
      textareas: document.querySelectorAll('textarea').length,
    };
  }, { FIELD, STYLE, MOTION, motion });
}

/** Exact comparison; layout numbers may differ by one CSS subpixel (1/64px), nothing more. */
export function differences(name, actual, reference, path = '') {
  const out = [];
  if (typeof actual === 'number' && typeof reference === 'number') {
    if (Math.abs(actual - reference) > 1 / 64) out.push({ case: name, path, orbit: actual, ant: reference });
    return out;
  }
  if (actual && reference && typeof actual === 'object' && typeof reference === 'object') {
    for (const key of new Set([...Object.keys(actual), ...Object.keys(reference)])) {
      out.push(...differences(name, actual[key], reference[key], path ? `${path}.${key}` : key));
    }
    return out;
  }
  if (actual !== reference) out.push({ case: name, path, orbit: actual, ant: reference });
  return out;
}

/** Pixel comparison of two PNGs, decoded by the page itself (no image library in this repo). */
export async function pixelDiff(page, a, b) {
  return page.evaluate(async ([a, b]) => {
    const load = async (data) => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const [first, second] = await Promise.all([load(a), load(b)]);
    if (first.width !== second.width || first.height !== second.height) {
      return { sameSize: false, sizes: [[first.width, first.height], [second.width, second.height]] };
    }
    const canvas = document.createElement('canvas');
    canvas.width = first.width;
    canvas.height = first.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(first, 0, 0);
    const one = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(second, 0, 0);
    const two = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let different = 0;
    let maxChannelDelta = 0;
    let box = null;
    for (let index = 0; index < one.length; index += 4) {
      const delta = Math.max(Math.abs(one[index] - two[index]), Math.abs(one[index + 1] - two[index + 1]),
        Math.abs(one[index + 2] - two[index + 2]), Math.abs(one[index + 3] - two[index + 3]));
      if (!delta) continue;
      different++;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      const x = (index / 4) % canvas.width;
      const y = Math.floor(index / 4 / canvas.width);
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
    }
    return { sameSize: true, width: canvas.width, height: canvas.height, different, maxChannelDelta, box };
  }, [a.toString('base64'), b.toString('base64')]);
}

/**
 * The composer and anything it opens above itself, clipped from the viewport — as first painted,
 * and again after both pages repaint it from scratch. AntD's two-pass measurement repaints part of
 * the field while it settles, which Chromium can rasterize into slightly different antialiased
 * corner pixels than one full paint; a brief opacity change on <main> (no layout, focus or hover
 * change) repaints the whole region the same way in both pages. The repainted capture is compared.
 */
export async function composerShot(page) {
  const raw = await clipShot(page);
  await page.evaluate(async () => {
    const main = document.querySelector('main');
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    main.style.opacity = '0.99';
    await frames();
    main.style.opacity = '';
    await frames();
  });
  return { raw, repainted: await clipShot(page) };
}

async function clipShot(page) {
  const clip = await page.evaluate(() => {
    const parts = [...document.querySelectorAll('.workspace-composer, .fixture-task-panel, .fixture-plain, .composer-slash-menu, .tdp-mention-menu')]
      .map((element) => element.getBoundingClientRect());
    const left = Math.floor(Math.min(...parts.map((r) => r.left)));
    const top = Math.floor(Math.min(...parts.map((r) => r.top)));
    const right = Math.ceil(Math.max(...parts.map((r) => r.right)));
    const bottom = Math.ceil(Math.max(...parts.map((r) => r.bottom)));
    return { x: Math.max(0, left - 4), y: Math.max(0, top - 4), width: Math.min(innerWidth, right + 4) - Math.max(0, left - 4), height: Math.min(innerHeight, bottom + 4) - Math.max(0, top - 4) };
  });
  return page.screenshot({ clip, caret: 'hide', animations: 'disabled' });
}

/** Immutable P0 measurements of the real WorkspaceView / TaskDetailPanel field in this project. */
export function p0Field(project, page, capture) {
  const file = new URL(`../../../docs/evidence/base-ui-migration/p0.2/baseline-run/${project}--${page}--computed-styles-and-timings.json`, import.meta.url);
  const evidence = JSON.parse(readFileSync(file));
  const control = evidence.captures.find((entry) => entry.name === capture).controls.find((entry) => entry.tag === 'TEXTAREA');
  return control;
}

export async function attachJson(info, name, body) {
  await info.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });
}
