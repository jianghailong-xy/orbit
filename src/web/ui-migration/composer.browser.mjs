import { test, expect } from '@playwright/test';
import {
  IMPLS, FIELD, attachJson, composerShot, differences, fieldState, open, p0Field, pixelDiff, settle,
} from './composer-checks.mjs';

// P3.1: the Orbit Textarea in the session composer (WorkspaceView) and the task comment box
// (TaskDetailPanel), against the AntD field those pages render today. Same fixture, same script,
// same environment; only the field differs.

const LINES = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');
const WRAPPING = 'A long sentence that keeps going and going '.repeat(7).trim();
const CHINESE = '中文输入法测试，自动增高输入框与镜像对齐。'.repeat(4);

/** Run one script on both pages; every recorded state is measured and photographed. */
async function compareRuns(page, info, scenario, query, script) {
  const runs = {};
  for (const impl of IMPLS) {
    const field = await open(page, info, impl, scenario, query);
    const states = [];
    const record = async (name, { shot = true } = {}) => {
      await settle(page);
      states.push({ name, state: await fieldState(page), shot: shot ? await composerShot(page) : null });
    };
    await script({ page, field, record, impl });
    runs[impl] = states;
  }
  expect(runs.orbit.map((entry) => entry.name)).toEqual(runs.ant.map((entry) => entry.name));
  const found = [];
  const pixels = {};
  for (const [index, ant] of runs.ant.entries()) {
    const orbit = runs.orbit[index];
    const { textareas: antTextareas, ...antState } = ant.state;
    const { textareas: orbitTextareas, ...orbitState } = orbit.state;
    found.push(...differences(ant.name, orbitState, antState));
    // AntD leaves its measuring twin in <body>; Orbit attaches one only while measuring.
    expect(orbitTextareas, `${ant.name}: no stray textarea`).toBe(1);
    expect(antTextareas).toBe(2);
    if (ant.shot) {
      pixels[ant.name] = { repainted: await pixelDiff(page, ant.shot.repainted, orbit.shot.repainted),
        firstPaint: await pixelDiff(page, ant.shot.raw, orbit.shot.raw) };
      await info.attach(`${scenario}-${ant.name}-ant`, { body: ant.shot.repainted, contentType: 'image/png' });
      await info.attach(`${scenario}-${ant.name}-orbit`, { body: orbit.shot.repainted, contentType: 'image/png' });
    }
  }
  await attachJson(info, `${scenario}${query.replace(/[^a-z0-9]+/gi, '-')}-states`, {
    states: Object.fromEntries(IMPLS.map((impl) => [impl, runs[impl].map(({ name, state }) => ({ name, state }))])),
    differences: found, pixels,
  });
  expect(found).toEqual([]);
  for (const [name, result] of Object.entries(pixels)) {
    expect(result.repainted, `${name}: composer pixels`).toMatchObject({ sameSize: true, different: 0 });
  }
  return runs;
}

/** The fixture's AntD field must be the real page's field: same size and style as recorded in P0. */
function expectP0(info, pageName, capture, state, focused) {
  const real = p0Field(info.project.name, pageName, capture);
  expect({ width: state.field.width, height: state.field.height, focused: state.focused })
    .toEqual({ width: real.rect.width, height: real.rect.height, focused });
  return real;
}

test('session composer grows, caps, scrolls and draws exactly like the AntD field', async ({ page }, info) => {
  const runs = await compareRuns(page, info, 'session', '', async ({ page, field, record }) => {
    await record('idle');
    await field.fill('Review the migration');
    await record('one-line');
    // The P0 session scenario's own keystrokes.
    await field.press('End');
    await field.press('Shift+Enter');
    await field.pressSequentially('Keep keyboard behavior.');
    await expect(field).toHaveValue('Review the migration\nKeep keyboard behavior.');
    await record('two-lines');
    await field.fill(WRAPPING);
    await record('wrapping', { shot: false });
    await field.fill(CHINESE);
    await record('chinese', { shot: false });
    await field.fill('Ends with a newline\n');
    await record('trailing-newline', { shot: false });
    await field.fill(LINES(12));
    await record('twelve-lines', { shot: false });
    await field.fill(LINES(13));
    await record('thirteen-lines', { shot: false });
    await field.fill(LINES(15));
    await field.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await record('capped-scrolled-to-end');
    await field.evaluate((element) => { element.scrollTop = 30; });
    await record('capped-scrolled-up', { shot: false });
    await field.fill('!ls -la');
    await record('shell-mode');
    await field.fill('');
    await record('cleared');
    // A narrower pane re-wraps the same text; the field follows on the next frame.
    await field.fill(WRAPPING);
    await settle(page);
    await page.locator('main').evaluate((element) => element.style.setProperty('--fixture-width', '420px'));
    await record('narrowed', { shot: false });
    await page.locator('main').evaluate((element) => element.style.removeProperty('--fixture-width'));
    await record('widened-again', { shot: false });
    // The placeholder is not a re-measure trigger in either field; the next value change is.
    await field.fill('');
    await page.getByRole('button', { name: 'Use long placeholder' }).click();
    await record('long-placeholder-before-edit');
    await field.pressSequentially('x');
    await field.press('Backspace');
    await record('long-placeholder-after-edit');
  });
  const idle = runs.ant.find((entry) => entry.name === 'idle').state;
  const twoLines = runs.ant.find((entry) => entry.name === 'two-lines').state;
  const real = expectP0(info, 'session', 'session-idle', idle, false);
  expect({ padding: `${idle.computed.paddingTop} ${idle.computed.paddingRight} ${idle.computed.paddingBottom}`,
    fontSize: idle.computed.fontSize, lineHeight: idle.computed.lineHeight, color: idle.computed.color })
    .toEqual({ padding: real.style.padding, fontSize: real.style.fontSize, lineHeight: real.style.lineHeight, color: real.style.color });
  expectP0(info, 'session', 'session-composer-focus', twoLines, true);
  // Mirror and field share every wrapping metric, and the mirror follows the field's scroll.
  for (const impl of IMPLS) {
    for (const { name, state } of runs[impl]) {
      expect(state.mirror.scrollTop, `${impl} ${name}: mirror scroll`).toBe(state.scroll.scrollTop);
      expect(state.mirror.computed.paddingLeft).toBe(state.computed.paddingLeft);
      expect(state.mirror.computed.fontSize).toBe(state.computed.fontSize);
      expect(state.mirror.computed.lineHeight).toBe(state.computed.lineHeight);
    }
  }
});

test('session composer with staged attachments and while disabled matches the AntD field', async ({ page }, info) => {
  const attached = await compareRuns(page, info, 'session', '&attachments', async ({ field, record }) => {
    await record('attachments-idle');
    await field.fill('With a staged screenshot and file\nsecond line');
    await record('attachments-two-lines');
  });
  for (const impl of IMPLS) {
    for (const { name, state } of attached[impl]) {
      // The first thumbnail, the text and the card's straight edge all start 24px in.
      expect(state.thumbnails[0].x - state.box.x, `${impl} ${name}: thumbnail inset`).toBe(24);
      expect(state.content.left - state.box.x, `${impl} ${name}: text inset`).toBe(24);
      expect(state.field.y, `${impl} ${name}: text below attachments`).toBe(state.attachments.y + state.attachments.height);
    }
  }
  await compareRuns(page, info, 'session', '&disabled&text=Read%20only%20draft', async ({ record }) => {
    await record('disabled');
  });
});

test('task comment field sizes from its placeholder, grows to four rows and keeps outlined states', async ({ page }, info) => {
  const runs = await compareRuns(page, info, 'comment', '', async ({ page, field, record }) => {
    await record('idle');
    if (!info.project.use.isMobile) {
      await field.hover();
      await record('hover');
    }
    await field.focus();
    await record('focused');
    await field.fill('A comment');
    await record('one-line');
    await field.press('Shift+Enter');
    await field.pressSequentially('second line');
    await record('two-lines');
    await field.fill(LINES(4));
    await record('four-lines', { shot: false });
    await field.fill(LINES(6));
    await field.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await record('capped-scrolled');
    await field.fill(CHINESE);
    await record('chinese', { shot: false });
    await field.fill('');
    await field.blur();
    await record('cleared');
  });
  expectP0(info, 'task', 'task-detail', runs.ant.find((entry) => entry.name === 'idle').state, false);
  await compareRuns(page, info, 'comment', '&disabled&text=Read%20only', async ({ record }) => {
    await record('disabled');
  });
});

test('the borderless variant on its own matches AntD at rest, focused, hovered and disabled', async ({ page }, info) => {
  // In the composer index.css removes this ring; on its own the variant keeps AntD's 1px one.
  const runs = await compareRuns(page, info, 'plain', '', async ({ page, field, record }) => {
    await record('rest');
    await page.keyboard.press('Tab');
    await expect(field).toBeFocused();
    await record('keyboard-focus');
    await field.hover();
    await record('focus-and-hover');
    await field.fill('Two\nlines');
    await record('typed');
  });
  const focused = runs.orbit.find((entry) => entry.name === 'keyboard-focus').state.computed;
  expect({ outlineStyle: focused.outlineStyle, outlineWidth: focused.outlineWidth, outlineOffset: focused.outlineOffset })
    .toEqual({ outlineStyle: 'solid', outlineWidth: '1px', outlineOffset: '-1px' });
  await compareRuns(page, info, 'plain', '&disabled&text=Disabled', async ({ record }) => {
    await record('disabled');
  });
});

test('manual height: drag the handle, clamp it, and double-click back to auto-size', async ({ page }, info) => {
  const runs = await compareRuns(page, info, 'session', '', async ({ page, field, record }) => {
    const handle = page.locator('.composer-resize-handle');
    await field.fill('short');
    await expect(page.getByLabel('Capped')).toHaveText('false');
    await expect(handle).toHaveCount(0);
    await field.fill(LINES(15));
    await expect(page.getByLabel('Capped')).toHaveText('true');
    await expect(handle).toHaveCount(1);
    await record('capped-handle-shown');
    // Drag the top grip to an absolute y inside the viewport: up is taller, down is shorter.
    const dragTo = async (target) => {
      const box = await handle.boundingBox();
      const x = box.x + box.width / 2;
      await page.mouse.move(x, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, target(box.y + box.height / 2), { steps: 4 });
      await page.mouse.up();
    };
    await dragTo((y) => y - 100);
    await expect(page.getByLabel('Manual height')).toHaveText('402');
    await record('dragged-taller');
    await dragTo(() => page.viewportSize().height - 4);
    await expect(page.getByLabel('Manual height')).toHaveText('44');
    await field.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await record('clamped-minimum');
    await dragTo(() => 4);
    await expect(page.getByLabel('Manual height')).toHaveText('640');
    await record('clamped-maximum', { shot: false });
    await field.fill('short again');
    await record('manual-height-kept-for-short-text');
    await handle.dblclick();
    await expect(page.getByLabel('Manual height')).toHaveText('auto');
    await record('reset-to-auto');
    await expect(handle).toHaveCount(0);
    await field.fill(LINES(15));
    await record('auto-size-resumed', { shot: false });
  });
  for (const impl of IMPLS) {
    const byName = Object.fromEntries(runs[impl].map(({ name, state }) => [name, state]));
    expect(byName['dragged-taller'].field.height).toBe(402);
    expect(byName['clamped-minimum'].field.height).toBe(44);
    expect(byName['clamped-maximum'].field.height).toBe(640);
    // The dragged height wins over auto-size: no row bounds, the field scrolls instead.
    expect(byName['dragged-taller'].inline).toMatchObject({ height: '402px', minHeight: '', maxHeight: '' });
    expect(byName['manual-height-kept-for-short-text'].field.height).toBe(640);
    expect(byName['reset-to-auto'].inline).toMatchObject({ height: '38px', minHeight: '38px', maxHeight: '302px', overflowY: 'hidden' });
    expect(byName['auto-size-resumed'].field.height).toBe(byName['capped-handle-shown'].field.height);
  }
});

const PROBE = `
[data-probe='field'] .composer-mirror { visibility: hidden !important; }
[data-probe='field'] .composer-field textarea[aria-label] { -webkit-text-fill-color: #000 !important; }
[data-probe='mirror'] .composer-mirror, [data-probe='mirror'] .composer-mirror * {
  color: #000 !important; background: transparent !important; box-shadow: none !important;
}`;

test('the mirror paints its glyphs exactly where the field lays out its own text', async ({ page }, info) => {
  // Diagnostic probe, not an appearance check: draw the field's own glyphs (mirror hidden), then the
  // mirror's glyphs (field transparent, chip fills removed), and count pixels that differ.
  const cases = {
    plain: async (field) => field.fill('Review the migration plan'),
    lines: async (field) => field.fill('First line\nSecond line with more words\n\nAfter a blank line'),
    wrapping: async (field) => field.fill(WRAPPING),
    chinese: async (field) => field.fill(CHINESE),
    chips: async (field, page) => {
      await field.fill('');
      await field.pressSequentially('Ask @orbit-dev');
      await page.keyboard.press('Enter');
      await field.pressSequentially('about #Base');
      await page.keyboard.press('Enter');
      await field.pressSequentially('today');
      await expect(page.locator('.composer-chip')).toHaveCount(2);
    },
    capped: async (field) => {
      await field.fill(LINES(15));
      await field.evaluate((element) => { element.scrollTop = 40; });
    },
  };
  const results = {};
  for (const impl of IMPLS) {
    const field = await open(page, info, impl);
    await page.addStyleTag({ content: PROBE });
    results[impl] = {};
    for (const [name, prepare] of Object.entries(cases)) {
      await prepare(field, page);
      await settle(page);
      const main = page.locator('main');
      const region = page.locator('.composer-field');
      await main.evaluate((element) => element.setAttribute('data-probe', 'field'));
      const own = await region.screenshot({ caret: 'hide', animations: 'disabled' });
      await main.evaluate((element) => element.setAttribute('data-probe', 'mirror'));
      const mirrored = await region.screenshot({ caret: 'hide', animations: 'disabled' });
      await main.evaluate((element) => element.removeAttribute('data-probe'));
      results[impl][name] = { ...(await pixelDiff(page, own, mirrored)), scroll: await page.evaluate((selector) => [
        document.querySelector(selector).scrollTop, document.querySelector('.composer-mirror').scrollTop], FIELD) };
      if (name === 'chips' || name === 'wrapping') {
        await info.attach(`probe-${name}-${impl}-field`, { body: own, contentType: 'image/png' });
        await info.attach(`probe-${name}-${impl}-mirror`, { body: mirrored, contentType: 'image/png' });
      }
    }
  }
  await attachJson(info, 'mirror-probe', results);
  // Orbit must land every glyph where AntD's field does: the same count of probe differences, case
  // by case. Most cases are exactly 0; chip spans in Chromium shape slightly differently from one
  // run of text in both fields alike, which the attachment records.
  for (const name of Object.keys(cases)) {
    expect(results.orbit[name]).toEqual(results.ant[name]);
    expect(results.orbit[name].scroll[0]).toBe(results.orbit[name].scroll[1]);
  }
  for (const name of ['plain', 'lines', 'wrapping', 'chinese']) expect(results.orbit[name].different).toBe(0);
});

test.describe('existing breakpoints', () => {
  test.skip(({ isMobile }) => isMobile, 'Breakpoint widths use the desktop pointer, as P0 breakpoints.browser.mjs does.');
  for (const width of [599, 601, 959, 961]) {
    test(`fields match at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      for (const scenario of ['session', 'comment']) {
        const runs = await compareRuns(page, info, scenario, '&width=360', async ({ field, record }) => {
          await record('idle');
          await field.fill('Two\nlines');
          await record('two-lines');
        });
        // index.css lifts the AntD textarea to 16px at ≤960px; the composer keeps its own 15px.
        const expected = scenario === 'session' ? '15px' : width <= 960 ? '16px' : '14px';
        expect(runs.orbit[0].state.computed.fontSize).toBe(expected);
      }
    });
  }
});

test.describe('normal motion', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('auto-size transitions match AntD; reduced motion drops them as other Orbit controls do', async ({ page }, info) => {
    const timeline = async (field, action) => {
      await action();
      return field.evaluate(async (element) => {
        const animations = element.getAnimations().map((animation) => ({
          property: animation.transitionProperty, duration: animation.effect.getTiming().duration,
          easing: animation.effect.getTiming().easing, delay: animation.effect.getTiming().delay,
        })).filter((entry) => entry.property === 'height');
        await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})));
        return { animations, height: element.getBoundingClientRect().height };
      });
    };
    const results = {};
    for (const impl of IMPLS) {
      results[impl] = {};
      let field = await open(page, info, impl, 'comment');
      await settle(page);
      results[impl].commentMotion = (await fieldState(page, { motion: true })).computed;
      await field.fill('first');
      results[impl].commentShiftEnter = await timeline(field, () => field.press('Shift+Enter'));
      field = await open(page, info, impl, 'session');
      await field.fill('first');
      results[impl].sessionFocusedShiftEnter = await timeline(field, () => field.press('Shift+Enter'));
      const restore = page.getByRole('button', { name: 'Restore draft' });
      await field.fill('');
      await settle(page);
      results[impl].sessionUnfocusedRestore = await timeline(field, () => restore.click());
      await settle(page);
      results[impl].sessionMotion = (await fieldState(page, { motion: true })).computed;
    }
    await attachJson(info, 'normal-motion', results);
    expect(results.orbit).toEqual(results.ant);
    // AntD animates the height while not focus-visible; focused typing in the composer is immediate.
    expect(results.orbit.commentShiftEnter.animations).toEqual([{ property: 'height', duration: 300, easing: 'ease', delay: 0 }]);
    expect(results.orbit.sessionFocusedShiftEnter.animations).toEqual([]);
    expect(results.orbit.sessionUnfocusedRestore.animations).toEqual([{ property: 'height', duration: 300, easing: 'ease', delay: 0 }]);
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });
    test('records the one intended difference: Orbit text fields stop transitioning', async ({ page }, info) => {
      const recorded = {};
      for (const impl of IMPLS) {
        await open(page, info, impl, 'comment');
        recorded[impl] = (await fieldState(page, { motion: true })).computed.transitionDuration;
      }
      await attachJson(info, 'reduced-motion', recorded);
      expect(recorded).toEqual({ ant: '0.3s', orbit: '0s' });
    });
  });
});
