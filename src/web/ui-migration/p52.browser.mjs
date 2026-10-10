import { test, expect } from './harness.mjs';
import { P52_PATHS, P52_SIZES, P52_STREAM, gate, installObjectUrlLog, installP52Fixtures, p52Stream } from './p52-fixtures.mjs';

// P5.2 states: the transcript's pictures and the viewer they open, on the production build with the P0 conversation's
// transcript replaced by one that carries every kind of picture (p52-fixtures.mjs). A turn's attachments load through
// the bearer-guarded route and hold their place while they do; one fails in place; a reply's Markdown picture, a
// session artifact and a tool's screenshot (one of them refetched whole) are drawn; the viewer pages through the
// conversation's pictures, zooms, turns, flips, moves, and closes; a picture on its own (a Markdown one, the composer's
// chip of a picture put back) opens on its own; the conversation keeps following its tail while pictures land and a
// turn streams in; the object URLs go with the conversation, Back included; and the shared page draws the same through
// the public routes. Locators are roles, accessible names and the pages' own classes, so the same file drives the
// replaced Image (same-commit reference tree) and the Orbit one; a box only one of them draws is named by both class
// names. Screenshots, computed styles and each step's observation (`trace`) are compared between the two runs
// (p43a.browser.mjs's method).

const VIEWER = '.ant-image-preview, .orbit-image-preview';
const PICTURE = '.ant-image-preview-img, .orbit-image-preview-img';
const PROGRESS = '.ant-image-preview-progress, .orbit-image-preview-progress';
const MASK = '.ant-image-preview-mask, .orbit-image-preview-mask';
const SINGLE = '.ant-image, .orbit-image';
// The conversation's scroller (the session list's column is a .workspace-sessions too), or the shared page's.
const CONVERSATION = '.workspace-scroll-wrap > .workspace-sessions, .share-scroll';
// The replaced viewer's buttons are named by their icons (close, left, right) or by internal keys (flipY …); the Orbit
// ones by what they do. A step records the Orbit name for both; the names themselves are attached apart (`names`).
const NAMES = {
  close: 'Close', left: 'Previous image', right: 'Next image', flipY: 'Flip vertically', flipX: 'Flip horizontally',
  rotateLeft: 'Rotate left', rotateRight: 'Rotate right', zoomOut: 'Zoom out', zoomIn: 'Zoom in',
};
const CONTROLS = Object.fromEntries(Object.entries(NAMES).map(([replaced, orbit]) => [orbit, new RegExp(`^(?:${replaced}|${orbit})$`, 'i')]));
const control = (page, name) => page.locator(VIEWER).getByRole('button', { name: CONTROLS[name] });
const viewer = (page) => page.locator(VIEWER).filter({ visible: true });
const phone = (testInfo) => !!testInfo.project.use.isMobile;
const row = (page, seq) => page.locator(`.workspace-scroll-wrap > .workspace-sessions [data-seq="${seq}"]`).first();
/** Bring a row to the top of the conversation and keep it there: the conversation follows its tail while it is at the
 *  bottom, so a picture landing before the scroll is read can pull it back down. Scrolls until the row stays put. */
async function top(locator) {
  await expect.poll(() => locator.evaluate(async (el) => {
    const scroller = el.closest('.workspace-sessions, .share-scroll');
    el.scrollIntoView({ block: 'start' });
    const where = () => `${scroller.scrollTop}:${Math.round(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)}`;
    const before = where();
    for (let frame = 0; frame < 4; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const placed = Math.abs(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top) <= 1
      || scroller.scrollTop === 0 || scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
    return where() === before && placed ? 'placed' : 'moved';
  }), { timeout: 15_000 }).toBe('placed');
}
const attachJson = (testInfo, name, body) => testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });

/** Wait out enter and leave animations (the replaced viewer fades for .3s whatever motion is asked for). */
const settled = (page) => page.waitForFunction(
  () => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  null, { timeout: 5000 },
).catch(() => {});
const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Wait until an open viewer is drawn in full: faded in, grown, and its picture where it stays for two frames. The
 *  replaced viewer starts a fade a frame after it opens, when no animation is running yet for settled() to wait on. */
const steady = (page) => expect.poll(() => page.evaluate(async (VIEWER) => {
  const view = [...document.querySelectorAll(VIEWER)].find((el) => el.getBoundingClientRect().width > 0);
  if (!view) return 'closed';
  const body = view.querySelector('.ant-image-preview-body, .orbit-image-preview-body');
  const where = () => JSON.stringify(view.querySelector('img')?.getBoundingClientRect());
  const running = () => document.getAnimations().some((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);
  const before = where();
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return getComputedStyle(view).opacity === '1' && getComputedStyle(body).transform === 'none' && !running() && where() === before ? 'steady' : 'moving';
}, VIEWER), { timeout: 10_000 }).toMatch(/^(?:steady|closed)$/);

/** Every picture drawn in the page has its bytes decoded. */
const decoded = (page) => page.waitForFunction(() => [...document.querySelectorAll('img')]
  .every((img) => img.complete && img.naturalWidth > 0), null, { timeout: 15_000 });

/** Press as the environment's reader does: a tap on a phone, a click elsewhere. */
async function press(locator, testInfo) {
  if (phone(testInfo)) await locator.tap();
  else await locator.click();
}

/** Wait until the conversation's scroller has stopped: a follow to the tail may be a smooth scroll still under way. */
const scrolled = (page) => expect.poll(() => page.evaluate(async (CONVERSATION) => {
  const scroller = document.querySelector(CONVERSATION);
  if (!scroller) return 'still';
  const before = scroller.scrollTop;
  for (let frame = 0; frame < 3; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return scroller.scrollTop === before ? 'still' : 'scrolling';
}, CONVERSATION), { timeout: 10_000 }).toBe('still');

async function observe(page, fixtures, step) {
  await settled(page);
  await steady(page);
  await scrolled(page);
  await frames(page);
  const state = await page.evaluate(({ VIEWER, PICTURE, PROGRESS, SIZES, NAMES, CONVERSATION }) => {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const label = (el) => el.getAttribute('aria-label') || el.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label')
      || el.getAttribute('title') || el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) || '';
    const named = (el) => NAMES[label(el)] ?? label(el);
    const size = (img) => (img && img.naturalWidth ? SIZES[`${img.naturalWidth}x${img.naturalHeight}`] ?? `${img.naturalWidth}x${img.naturalHeight}` : null);
    const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100); };
    // A class the page or the transcript gave the picture, not the component's own.
    const own = (img) => [...img.classList].filter((name) => !/^(?:ant-|orbit-image|css-)/.test(name)).join(' ');
    const view = [...document.querySelectorAll(VIEWER)].find(shown);
    const picture = view?.querySelector(PICTURE);
    const scroller = document.querySelector(CONVERSATION) ?? document.scrollingElement;
    const active = document.activeElement;
    const urls = window.__p52ObjectUrls ?? { created: [], revoked: [] };
    const live = urls.created.filter(({ url }) => !urls.revoked.includes(url));
    const scope = [...document.querySelectorAll(`${CONVERSATION}, .composer-attachments, ${VIEWER}`)];
    return {
      url: location.pathname,
      focus: active && active !== document.body ? { role: active.getAttribute('role') ?? active.tagName.toLowerCase(), name: named(active) } : 'body',
      viewer: view ? {
        name: view.getAttribute('aria-label') ?? null,
        position: view.querySelector(PROGRESS)?.textContent ?? null,
        picture: size(picture),
        transform: picture?.style.transform ?? null,
        box: picture ? box(picture) : null,
        controls: [...view.querySelectorAll('button')].filter(shown).map((button) => `${named(button)}${button.disabled ? ' (disabled)' : ''}`),
      } : null,
      lock: { html: getComputedStyle(document.documentElement).overflowY, body: getComputedStyle(document.body).overflowY },
      pictures: [...document.querySelectorAll(`${CONVERSATION}, .composer-attachments`)].flatMap((root) => [...root.querySelectorAll('img')]).filter(shown).map((img) => ({
        at: img.closest('[data-seq]')?.getAttribute('data-seq') ?? (img.closest('.composer-attachments') ? 'composer' : null),
        picture: size(img), class: own(img), opens: img.closest('button.chat-image-btn') ? 'group' : img.closest('[role="button"]') ? 'alone' : 'none',
        box: box(img),
      })),
      placeholders: [...document.querySelectorAll('.chat-image-loading, .md-image-loading, .chat-result-image-loading')].filter(shown)
        .map((el) => ({ at: el.closest('[data-seq]')?.getAttribute('data-seq') ?? null, class: el.className, box: box(el) })),
      chips: [...document.querySelectorAll('.chat-file, .md-image-unavailable')].filter(shown).map((el) => label(el)),
      scroll: scroller ? { top: Math.round(scroller.scrollTop), height: scroller.scrollHeight, gap: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) } : null,
      objectUrls: { created: urls.created.length, revoked: urls.revoked.length, live: live.length },
      // The runtime census: AntD-classed elements in the conversation, the composer's attachments and the viewer, by
      // class; an icon's `anticon` is allowed and not counted.
      antd: [...new Set(scope.flatMap((root) => [root, ...root.querySelectorAll('[class*="ant-"]')])
        .filter((el) => shown(el))
        .flatMap((el) => [...el.classList].filter((token) => token.startsWith('ant-') && !token.startsWith('anticon'))
          .map((token) => token.replace(/-(?:css-var|hash)-.*$/, ''))))].sort(),
    };
  }, { VIEWER, PICTURE, PROGRESS, SIZES: P52_SIZES, NAMES, CONVERSATION });
  const requests = fixtures.requests.splice(0).map(({ method, path, query, authorization }) => ({ method, path: query ? `${path}?${query}` : path, authorization }));
  return { step, ...state, requests };
}

/** The accessible names the viewer and its buttons carry in this tree, as they are. */
async function names(page) {
  return page.evaluate((VIEWER) => {
    const label = (el) => el.getAttribute('aria-label') || el.querySelector('[role="img"][aria-label]')?.getAttribute('aria-label') || '';
    const view = document.querySelector(VIEWER);
    return { viewer: view?.getAttribute('aria-label') ?? null, buttons: view ? [...view.querySelectorAll('button')].map(label) : [] };
  }, VIEWER);
}

/** One step of a touch gesture on the open picture, then two frames: points are [x, y] in the viewport. False where the
 *  browser cannot make touches from a script (Playwright's WebKit: `new Touch` is an illegal constructor). */
async function touch(page, type, points) {
  const done = await page.locator(PICTURE).first().evaluate((img, { type, points }) => {
    let list;
    try {
      list = points.map(([x, y], identifier) => new Touch({ identifier, target: img, clientX: x, clientY: y, pageX: x, pageY: y }));
    } catch {
      return false;
    }
    img.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : list, targetTouches: type === 'touchend' ? [] : list, changedTouches: list }));
    return true;
  }, { type, points });
  await frames(page);
  return done;
}

async function loadAll(page, fixtures) {
  await expect(row(page, 1).locator('img')).toHaveCount(2);
  // A tool's result is drawn inside its call's card, which carries the call's seq.
  await expect(row(page, 8).locator('img')).toHaveCount(1);
  await expect(page.locator('.md img')).toHaveCount(2);
  await decoded(page);
  await settled(page);
}

const pictureCenter = async (page) => {
  const box = await page.locator(PICTURE).first().boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test.describe('P5.2 the transcript’s pictures', () => {
  test('load through the authorized route, hold their place while they do, and fail in place', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    const attachments = gate();
    const whole = gate();
    fixtures.state.holdAttachments = attachments;
    fixtures.state.holdFull = whole;
    const trace = [];
    await page.goto(P52_PATHS.session);
    await expect(row(page, 1).locator('.chat-image-loading')).toHaveCount(2);
    await expect(page.locator('.chat-result-image-loading')).toBeVisible();
    await expect(page.locator('.md img')).toHaveCount(1);
    await decoded(page);
    await top(row(page, 1));
    trace.push(await observe(page, fixtures, 'attachments and a clipped screenshot on their way'));
    await capture('p52-loading', { bubble: row(page, 1), placeholder: row(page, 1).locator('.chat-image-loading').first() });
    await top(row(page, 8));
    await capture('p52-result-loading', { card: row(page, 8), placeholder: page.locator('.chat-result-image-loading') });

    attachments.release();
    whole.release();
    await loadAll(page, fixtures);
    await top(row(page, 1));
    trace.push(await observe(page, fixtures, 'drawn'));
    await capture('p52-turn-1', { bubble: row(page, 1), thumbnail: row(page, 1).locator('img').first() });
    await top(row(page, 2));
    await capture('p52-reply-pictures', { diagram: page.locator(`.md ${SINGLE}`).first(), mock: page.locator(`.md ${SINGLE}`).nth(1) });
    await top(row(page, 3));
    await capture('p52-result', { card: row(page, 3), picture: row(page, 3).locator('img') });
    await top(row(page, 6));
    trace.push(await observe(page, fixtures, 'the second turn: one picture failed, a mock gone, the clipped screenshot fetched whole'));
    await capture('p52-turn-2', { bubble: row(page, 6), placeholder: row(page, 6).locator('.chat-image-loading'), chip: page.locator('.chat-file').first() });
    await top(row(page, 8));
    await capture('p52-result-whole', { card: row(page, 8), picture: row(page, 8).locator('img') });

    // The affordances: a hover over a picture on its own and over a thumbnail of the group, and the keyboard's ring.
    const diagram = page.locator(`.md ${SINGLE}`).first();
    await top(row(page, 2));
    if (!phone(testInfo)) {
      await diagram.hover();
      await settled(page);
      trace.push(await observe(page, fixtures, 'hover over a picture on its own'));
      await capture('p52-diagram-hover', { diagram, cover: diagram.locator('.ant-image-cover, .orbit-image-cover') });
      const thumbnail = row(page, 1).locator('button.chat-image-btn').first();
      await top(row(page, 1));
      await thumbnail.hover();
      await settled(page);
      await capture('p52-thumbnail-hover', { thumbnail, mask: thumbnail.locator('.chat-image-mask') });
      await page.mouse.move(0, 0);
      await settled(page);
    }
    await top(row(page, 2));
    await diagram.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(diagram).toBeFocused();
    await settled(page);
    trace.push(await observe(page, fixtures, 'keyboard focus on a picture on its own'));
    await capture('p52-diagram-focus', { diagram });
    await testInfo.attach('object-urls', { body: JSON.stringify(await page.evaluate(() => window.__p52ObjectUrls), null, 2), contentType: 'application/json' });
    await attachJson(testInfo, 'trace', trace);
  });

  test('open in the viewer, which pages through them, zooms, turns, flips, moves and closes', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    await page.goto(P52_PATHS.session);
    await loadAll(page, fixtures);
    const trace = [];
    trace.push(await observe(page, fixtures, 'drawn'));

    // Open at the second picture of the first turn.
    await top(row(page, 1));
    const tall = row(page, 1).locator('button.chat-image-btn').nth(1);
    await press(tall, testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'opened at the pressed picture'));
    await attachJson(testInfo, 'names', await names(page));
    await capture('p52-viewer', { viewer: viewer(page), picture: page.locator(PICTURE), close: control(page, 'Close'), position: page.locator(PROGRESS) });

    // Paging: →, the arrows, and either end.
    await page.keyboard.press('ArrowRight');
    trace.push(await observe(page, fixtures, '→'));
    await capture('p52-viewer-next', { picture: page.locator(PICTURE) });
    await press(control(page, 'Next image'), testInfo);
    trace.push(await observe(page, fixtures, 'next'));
    await press(control(page, 'Previous image'), testInfo);
    trace.push(await observe(page, fixtures, 'previous'));
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    trace.push(await observe(page, fixtures, 'first'));
    await capture('p52-viewer-first', { previous: control(page, 'Previous image'), position: page.locator(PROGRESS) });
    await page.keyboard.press('ArrowLeft');
    trace.push(await observe(page, fixtures, '← at the first'));
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('ArrowRight');
    trace.push(await observe(page, fixtures, 'last'));
    await capture('p52-viewer-last', { next: control(page, 'Next image'), position: page.locator(PROGRESS), picture: page.locator(PICTURE) });

    // Zoom: the buttons, the wheel, a double click — on the screenshot, which is larger than the window when zoomed.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowLeft');
    trace.push(await observe(page, fixtures, 'the screenshot'));
    await press(control(page, 'Zoom in'), testInfo);
    trace.push(await observe(page, fixtures, 'zoom in'));
    await capture('p52-viewer-zoomed', { picture: page.locator(PICTURE), zoomOut: control(page, 'Zoom out') });
    await press(control(page, 'Zoom in'), testInfo);
    trace.push(await observe(page, fixtures, 'zoom in again'));
    await press(control(page, 'Zoom out'), testInfo);
    await press(control(page, 'Zoom out'), testInfo);
    trace.push(await observe(page, fixtures, 'zoom out twice'));
    if (!phone(testInfo)) {
      let center = await pictureCenter(page);
      await page.mouse.move(center.x - 120, center.y - 60);
      await page.mouse.wheel(0, -100);
      trace.push(await observe(page, fixtures, 'wheel up off centre'));
      await page.mouse.wheel(0, 100);
      trace.push(await observe(page, fixtures, 'wheel down'));
      center = await pictureCenter(page);
      await page.mouse.dblclick(center.x + 100, center.y + 50);
      trace.push(await observe(page, fixtures, 'double click'));
      await capture('p52-viewer-double-click', { picture: page.locator(PICTURE) });
      // Drag the zoomed picture, then let it go: it settles against the window's edges.
      center = await pictureCenter(page);
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 400, center.y + 300, { steps: 8 });
      trace.push(await observe(page, fixtures, 'dragging'));
      await page.mouse.up();
      trace.push(await observe(page, fixtures, 'let go'));
      await capture('p52-viewer-dragged', { picture: page.locator(PICTURE) });
      center = await pictureCenter(page);
      await page.mouse.dblclick(center.x, center.y);
      trace.push(await observe(page, fixtures, 'double click back'));
    } else {
      // A pinch out around a point, a one-finger move, and the fingers lifted.
      const center = await pictureCenter(page);
      const pinch = [];
      pinch.push(await touch(page, 'touchstart', [[center.x - 40, center.y], [center.x + 40, center.y]]));
      for (const spread of [60, 90, 120]) pinch.push(await touch(page, 'touchmove', [[center.x - spread, center.y + 10], [center.x + spread, center.y + 10]]));
      pinch.push(await touch(page, 'touchend', [[center.x - 120, center.y + 10], [center.x + 120, center.y + 10]]));
      trace.push({ ...(await observe(page, fixtures, 'pinch out')), touch: pinch });
      await capture('p52-viewer-pinched', { picture: page.locator(PICTURE) });
      const move = [];
      move.push(await touch(page, 'touchstart', [[center.x, center.y]]));
      for (const step of [1, 2, 3]) move.push(await touch(page, 'touchmove', [[center.x + 30 * step, center.y + 20 * step]]));
      move.push(await touch(page, 'touchend', [[center.x + 90, center.y + 60]]));
      trace.push({ ...(await observe(page, fixtures, 'one finger moved and lifted')), touch: move });
      const shrink = [];
      shrink.push(await touch(page, 'touchstart', [[center.x - 120, center.y], [center.x + 120, center.y]]));
      for (const spread of [80, 40, 20]) shrink.push(await touch(page, 'touchmove', [[center.x - spread, center.y], [center.x + spread, center.y]]));
      shrink.push(await touch(page, 'touchend', [[center.x - 20, center.y], [center.x + 20, center.y]]));
      trace.push({ ...(await observe(page, fixtures, 'pinch in below its own size, lifted')), touch: shrink });
    }

    // Turn and flip.
    await press(control(page, 'Rotate right'), testInfo);
    trace.push(await observe(page, fixtures, 'rotate right'));
    await press(control(page, 'Flip horizontally'), testInfo);
    trace.push(await observe(page, fixtures, 'flip horizontally'));
    await capture('p52-viewer-turned', { picture: page.locator(PICTURE) });
    await press(control(page, 'Rotate left'), testInfo);
    await press(control(page, 'Rotate left'), testInfo);
    await press(control(page, 'Flip vertically'), testInfo);
    trace.push(await observe(page, fixtures, 'rotate left twice, flip vertically'));
    // A switch shows the next picture at its own size.
    await page.keyboard.press('ArrowRight');
    trace.push(await observe(page, fixtures, '→ after turning'));
    await page.keyboard.press('ArrowLeft');
    trace.push(await observe(page, fixtures, '← back: at its own size again'));

    // The buttons under the pointer, and the keyboard's way through them.
    if (!phone(testInfo)) {
      await control(page, 'Zoom in').hover();
      await settled(page);
      await capture('p52-viewer-hover-zoom-in', { zoomIn: control(page, 'Zoom in') });
      await control(page, 'Close').hover();
      await settled(page);
      await capture('p52-viewer-hover-close', { close: control(page, 'Close') });
      await page.mouse.move(640, 120);
      await settled(page);
    }
    const order = [];
    for (let step = 0; step < 10; step += 1) {
      await page.keyboard.press('Tab');
      order.push((await observe(page, fixtures, 'tab')).focus);
    }
    await page.keyboard.press('Shift+Tab');
    order.push((await observe(page, fixtures, 'shift+tab')).focus);
    trace.push({ step: 'keyboard order', order });
    await capture('p52-viewer-focus', { focused: page.locator(':focus') });

    // While open: the page behind does not scroll under a desktop's wheel (Playwright has no wheel in mobile WebKit).
    if (!phone(testInfo)) {
      const before = await page.locator(CONVERSATION).evaluate((el) => el.scrollTop);
      await page.mouse.move(40, 120);
      await page.mouse.wheel(0, -400);
      await settled(page);
      trace.push({ ...(await observe(page, fixtures, 'wheel over the mask')), scrolledBehind: (await page.locator(CONVERSATION).evaluate((el) => el.scrollTop)) !== before });
    }

    // Close: Escape, the close button, the mask — not the picture.
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'Escape'));
    await press(tall, testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    await press(page.locator(PICTURE), testInfo);
    trace.push(await observe(page, fixtures, 'a press on the picture'));
    await press(control(page, 'Close'), testInfo);
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'Close'));
    await press(row(page, 1).locator('button.chat-image-btn').first(), testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    const mask = await page.locator(MASK).boundingBox();
    if (phone(testInfo)) await page.touchscreen.tap(mask.x + 40, mask.y + 120);
    else await page.mouse.click(mask.x + 40, mask.y + 120);
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'a press on the mask'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('open on their own: a reply’s Markdown picture, the session’s mock and a picture put back in the composer', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    await page.goto(P52_PATHS.session);
    await loadAll(page, fixtures);
    const trace = [];
    trace.push(await observe(page, fixtures, 'drawn'));

    const diagram = page.locator(`.md ${SINGLE}`).first();
    await top(row(page, 2));
    await press(diagram, testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the diagram on its own'));
    await attachJson(testInfo, 'names', await names(page));
    await capture('p52-single', { viewer: viewer(page), picture: page.locator(PICTURE) });
    await page.keyboard.press('ArrowRight');
    trace.push(await observe(page, fixtures, '→ does nothing'));
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'Escape'));

    const mock = page.locator(`.md ${SINGLE}`).nth(1);
    await press(mock, testInfo);
    await expect(viewer(page)).toBeVisible();
    await press(control(page, 'Zoom in'), testInfo);
    await press(control(page, 'Rotate left'), testInfo);
    trace.push(await observe(page, fixtures, 'the mock, zoomed and turned'));
    await capture('p52-single-mock', { picture: page.locator(PICTURE) });
    await press(control(page, 'Close'), testInfo);
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed'));

    // The undelivered message's picture, put back: the composer draws its chip from the stored bytes.
    await top(row(page, 11));
    await page.getByRole('button', { name: 'Put back in the composer', exact: true }).click();
    const chip = page.locator('.composer-attach');
    await expect(chip.locator('img')).toHaveCount(1);
    await decoded(page);
    await settled(page);
    trace.push(await observe(page, fixtures, 'put back'));
    await capture('p52-composer-chip', { chip, picture: chip.locator('img') });
    if (!phone(testInfo)) {
      await chip.locator(SINGLE).hover();
      await settled(page);
      await capture('p52-composer-chip-hover', { chip, cover: chip.locator('.ant-image-cover, .orbit-image-cover') });
    }
    await press(chip.locator(SINGLE), testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'the chip opened'));
    await capture('p52-composer-chip-viewer', { picture: page.locator(PICTURE) });
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed again'));
    await page.getByRole('button', { name: 'Remove image', exact: true }).click();
    await expect(chip).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'removed from the composer'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('keep the conversation on its tail while they land, and in order while a turn streams in', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    const attachments = gate();
    fixtures.state.holdAttachments = attachments;
    const trace = [];
    await page.goto(P52_PATHS.session);
    await expect(row(page, 1).locator('.chat-image-loading')).toHaveCount(2);
    await settled(page);
    trace.push(await observe(page, fixtures, 'opened at the tail, pictures on their way'));
    attachments.release();
    await loadAll(page, fixtures);
    trace.push(await observe(page, fixtures, 'pictures landed'));
    await capture('p52-tail', { composer: '.composer-field' });

    await p52Stream(page, P52_STREAM.start);
    await expect(page.getByText('Looking at the screenshot', { exact: true })).toBeVisible();
    await decoded(page);
    trace.push(await observe(page, fixtures, 'a turn with a picture, its reply streaming'));
    await p52Stream(page, P52_STREAM.tool);
    await expect(row(page, 14).locator('img')).toHaveCount(1);
    await decoded(page);
    trace.push(await observe(page, fixtures, 'a screenshot mid-reply'));
    await capture('p52-streaming', { card: row(page, 14) });
    await p52Stream(page, P52_STREAM.end);
    await expect(page.getByText('Looking at the screenshot and the one it took: both match.', { exact: true })).toBeVisible();
    await decoded(page);
    trace.push(await observe(page, fixtures, 'settled'));
    trace.push({ step: 'rows in order', rows: await page.locator(`${CONVERSATION} [data-seq]`).evaluateAll((rows) => rows.map((el) => `${el.getAttribute('data-seq')} ${el.className.split(' ')[0]}`)) });

    // The newest picture is the last page of the viewer.
    await press(row(page, 14).locator('button.chat-image-btn'), testInfo);
    await expect(viewer(page)).toBeVisible();
    trace.push(await observe(page, fixtures, 'the newest picture in the viewer'));
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('give their object URLs back with the conversation, Back with the viewer open included', async ({ evidence }, testInfo) => {
    const { page } = evidence;
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    const trace = [];
    // Arrive at the conversation from the task list, in the app, so Back returns there.
    await page.goto(P52_PATHS.tasks);
    await expect(page.locator('.app-nav, aside').first()).toBeVisible();
    await page.evaluate((path) => {
      window.history.pushState({ usr: null, key: 'p52', idx: 1 }, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    }, P52_PATHS.session);
    await loadAll(page, fixtures);
    trace.push(await observe(page, fixtures, 'drawn'));
    await top(row(page, 1));
    await press(row(page, 1).locator('button.chat-image-btn').first(), testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'viewer open'));
    await page.goBack();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(viewer(page)).toHaveCount(0);
    await settled(page);
    trace.push(await observe(page, fixtures, 'Back'));
    const urls = await page.evaluate(() => window.__p52ObjectUrls);
    trace.push({ step: 'object URLs', notRevoked: urls.created.filter(({ url }) => !urls.revoked.includes(url)).map(({ type, size }) => `${type} ${size}`) });
    await attachJson(testInfo, 'trace', trace);
  });

  test('open, zoom and close with the replaced viewer’s motion when motion is allowed', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    // The other cases run with reduced motion, where the Orbit viewer changes at once and the replaced one still eased;
    // here both ease, so the fade and growth on opening, the zoom's easing and the fade on closing are compared.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    await page.goto(P52_PATHS.session);
    await loadAll(page, fixtures);
    const trace = [];
    await top(row(page, 3));
    // Sample the viewer's root opacity, its body's scale and the picture's scale every frame: for half a second while
    // it opens or zooms, and until it is gone (two seconds at most) while it closes — the replaced viewer removes itself
    // only after its fade has ended, which on a loaded host can be well past half a second.
    const motion = (step) => page.evaluate(async ({ VIEWER, step }) => {
      const samples = [];
      const start = performance.now();
      const limit = step === 'closing' ? 2000 : 500;
      while (performance.now() - start < limit) {
        const view = [...document.querySelectorAll(VIEWER)].find((el) => el.getBoundingClientRect().width > 0);
        const body = view?.querySelector('.ant-image-preview-body, .orbit-image-preview-body');
        const img = view?.querySelector('img');
        const scale = (el) => (el ? new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform).a : null);
        samples.push({ opacity: view ? Number(getComputedStyle(view).opacity) : null, body: scale(body), picture: scale(img) });
        if (step === 'closing' && !view) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const values = (key) => samples.map((sample) => sample[key]).filter((value) => value !== null);
      const between = (key, low, high) => values(key).some((value) => value > low && value < high);
      const last = samples.at(-1);
      // What eased and where it ended; how many frames it took under load is not compared.
      return {
        step,
        faded: between('opacity', 0.01, 0.99), grew: between('body', 0.01, 0.99), zoomed: between('picture', 1.01, 1.49),
        end: last.opacity === null ? 'closed' : { opacity: last.opacity, body: last.body, picture: Math.round(last.picture * 100) / 100 },
      };
    }, { VIEWER, step });
    const thumbnail = row(page, 3).locator('button.chat-image-btn');
    await press(thumbnail, testInfo);
    trace.push(await motion('opening'));
    trace.push(await observe(page, fixtures, 'open'));
    await capture('p52-motion-open', { picture: page.locator(PICTURE) });
    await press(control(page, 'Zoom in'), testInfo);
    trace.push(await motion('zooming'));
    trace.push(await observe(page, fixtures, 'zoomed'));
    await capture('p52-motion-zoomed', { picture: page.locator(PICTURE) });
    await press(control(page, 'Rotate right'), testInfo);
    trace.push(await observe(page, fixtures, 'turned'));
    await capture('p52-motion-turned', { picture: page.locator(PICTURE) });
    await page.keyboard.press('Escape');
    trace.push(await motion('closing'));
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed'));
    await attachJson(testInfo, 'trace', trace);
  });

  test('are drawn and open the same on the shared conversation, through the public routes', async ({ evidence }, testInfo) => {
    const { page, capture } = evidence;
    await installObjectUrlLog(page);
    const fixtures = await installP52Fixtures(page);
    const trace = [];
    await page.goto(P52_PATHS.shared);
    await expect(page.locator('.chat-user[data-seq="1"] img')).toHaveCount(2);
    await expect(page.locator('.md img')).toHaveCount(2);
    await decoded(page);
    await settled(page);
    await top(page.locator('.chat-user[data-seq="1"]'));
    trace.push(await observe(page, fixtures, 'drawn'));
    await capture('p52-shared', { bubble: page.locator('.chat-user[data-seq="1"]') });
    await press(page.locator('.chat-user[data-seq="1"] button.chat-image-btn').first(), testInfo);
    await expect(viewer(page)).toBeVisible();
    await settled(page);
    trace.push(await observe(page, fixtures, 'viewer open'));
    await capture('p52-shared-viewer', { viewer: viewer(page), picture: page.locator(PICTURE) });
    await page.keyboard.press('ArrowRight');
    trace.push(await observe(page, fixtures, '→'));
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    trace.push(await observe(page, fixtures, 'closed'));
    await attachJson(testInfo, 'trace', trace);
  });
});
