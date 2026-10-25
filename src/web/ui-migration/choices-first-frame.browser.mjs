import { test, expect } from '@playwright/test';

// Where an opened popup is drawn, frame by frame from the opening input: its first shown frame must
// already be where it settles, on the page and inside a positioned owner (dialog, drawer), scrolled,
// moved, flipped and at the screen edge.
const fixture = '/ui-migration/choices.html';
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });
// The attached frame record is the diagnostic; per-action trace snapshots would add ~40% to ~20 loads a test.
test.use({ trace: 'off' });

const places = [
  { name: 'page', query: '', motion: true },
  { name: 'page, flipped above', query: '&anchor=bottom' },
  { name: 'page, right edge', query: '&anchor=right' },
  { name: 'page, scrolled', query: '&pagescroll' },
  { name: 'page, scrolled box', query: '&scroll' },
  { name: 'page, moved box', query: '&transform' },
  { name: 'dialog', query: '&owner=dialog', motion: true },
  { name: 'dialog, flipped above', query: '&owner=dialog&anchor=bottom', motion: true },
  { name: 'dialog, right edge', query: '&owner=dialog&anchor=right' },
  { name: 'dialog, scrolled', query: '&owner=dialog&scroll' },
  { name: 'dialog, moved', query: '&owner=dialog&transform' },
  { name: 'drawer', query: '&owner=drawer', motion: true },
];

const region = (page) => page.getByRole('region', { name: 'Appearance sample' });
const press = (info, locator) => info.project.use.hasTouch ? locator.tap() : locator.click();
const choice = (page) => region(page).getByRole('combobox', { name: 'Sample choice' });
const button = (page) => region(page).getByRole('button').first();
// Each kind: its fixture sample, its anchor and popup surface when they are not the sample's first button
// and .sample-surface, and how it opens. A menu opened from the keyboard is placed without the extra
// render a pointer opening gets, so both are sampled.
const choiceAnchor = '.sample-choice';
const kinds = {
  menu: { sample: 'attachment', openings: { pointer: (page, info) => press(info, button(page)),
    keyboard: async (page) => { await button(page).focus(); await page.keyboard.press('ArrowDown'); } } },
  submenu: { sample: 'submenu', anchor: '[role="menuitem"][aria-haspopup]', surface: '.orbit-menu[data-nested]',
    before: async (page, info) => {
      await press(info, button(page));
      await expect(page.getByRole('menuitem', { name: 'Provider' })).toBeVisible();
    },
    // A pointer moving onto the item in steps, as a hand does.
    openings: { pointer: async (page) => {
      const item = await page.getByRole('menuitem', { name: 'Provider' }).boundingBox();
      await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 5 });
    } } },
  select: { sample: 'expiry', anchor: choiceAnchor, openings: { pointer: (page, info) => press(info, choice(page)) } },
  combobox: { sample: 'search', anchor: choiceAnchor, openings: { pointer: (page, info) => press(info, choice(page)) } },
  multiselect: { sample: 'multiple', anchor: choiceAnchor, openings: { pointer: (page, info) => press(info, choice(page)) } },
  popover: { sample: 'popover', openings: { pointer: (page, info) => press(info, button(page)) } },
  tooltip: { sample: 'tooltip', openings: { pointer: (page) => button(page).hover() } },
  popconfirm: { sample: 'popconfirm', openings: { pointer: (page, info) => press(info, button(page)) } },
};

// Waits until the anchor holds still (the owner's entrance and a scrolled place's scroll done), then
// records the newest matching surface twice a frame: in requestAnimationFrame, before the frame's layout
// observers run, and after the frame has been produced. Shown is laid out with a non-zero opacity. Once
// the surface has been there 12 frames and its motion has finished, one settled reading.
async function arm(page, selector, anchorSelector, scroll) {
  await page.evaluate(async ({ selector, anchorSelector, scroll }) => {
    const finished = () => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})));
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const anchorOf = () => [...document.querySelectorAll(anchorSelector)].at(-1);
    const still = async () => {
      let last = '';
      for (let count = 0; count < 120; count += 1) {
        await finished();
        await frame();
        // The owner's contents may still be rendering.
        const box = JSON.stringify(anchorOf()?.getBoundingClientRect() ?? null);
        if (box !== 'null' && box === last && document.getAnimations().every((animation) => animation.playState !== 'running')) return;
        last = box;
      }
    };
    await document.fonts.ready;
    await still();
    if (scroll) {
      document.querySelector('[data-testid="neutral"]').scrollIntoView({ block: 'center' });
      await still();
    }
    const round = (value) => Math.round(value * 1000) / 1000;
    // Where the anchor's scrolling boxes (an owner's viewport, a scrolled box, the page) are scrolled to.
    const scrollers = [];
    for (let node = anchorOf().parentElement; node; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflow)) scrollers.push(node);
    }
    scrollers.push(document.scrollingElement);
    const scrolled = () => scrollers.map((node) => [node.scrollLeft, node.scrollTop]).join(' ');
    const read = (when) => {
      const surface = [...document.querySelectorAll(selector)].at(-1);
      if (!surface) return { when, shown: false };
      const box = surface.getBoundingClientRect();
      const anchor = anchorOf().getBoundingClientRect();
      let opacity = 1;
      for (let node = surface; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      let root = surface;
      while (root.parentElement && !['absolute', 'fixed'].includes(getComputedStyle(root).position)) root = root.parentElement;
      const at = root.getBoundingClientRect();
      return { when, shown: box.width > 0 && opacity > 0 && getComputedStyle(surface).visibility === 'visible',
        x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height), opacity: round(opacity),
        anchor: { x: round(anchor.x), y: round(anchor.y) }, scrolled: scrolled(),
        viewport: [round(visualViewport.width), document.documentElement.clientWidth],
        root: { position: getComputedStyle(root).position, opacity: Number(getComputedStyle(root).opacity), x: round(at.x), y: round(at.y) } };
    };
    const state = { frames: [], scrolled: scrolled() };
    let seen = 0;
    state.done = new Promise((resolve) => {
      const after = new MessageChannel();
      after.port1.onmessage = () => state.frames.push(read('produced'));
      const tick = () => {
        if (document.querySelector(selector)) seen += 1;
        state.frames.push(read('frame'));
        after.port2.postMessage(null);
        if (seen < 12 && performance.now() - start < 10_000) requestAnimationFrame(tick);
        else setTimeout(async () => { await finished(); await frame(); await frame(); state.settled = read('settled'); resolve(); });
      };
      const start = performance.now();
      requestAnimationFrame(tick);
    });
    window.firstFrame = state;
  }, { selector, anchorSelector, scroll });
}

async function sample(page, info, kind, place, opening) {
  await page.goto(`${fixture}?sample=${kind.sample}${place.query}`);
  // The pointer stays where the last sample left it, which can be where this sample's popup will open.
  await page.mouse.move(0, 0);
  if (kind.before) {
    // A fixed sample inside an owner moves with its entrance: wait it out before the first step too.
    await page.evaluate(async () => {
      await document.fonts.ready;
      let last = '';
      for (let count = 0; count < 120; count += 1) {
        await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const box = JSON.stringify(document.querySelector('[data-testid="neutral"]')?.getBoundingClientRect() ?? null);
        if (box !== 'null' && box === last && document.getAnimations().every((animation) => animation.playState !== 'running')) return;
        last = box;
      }
    });
    await kind.before(page, info);
  }
  await arm(page, kind.surface ?? '.sample-surface', kind.anchor ?? '[aria-label="Appearance sample"] button',
    place.query.includes('scroll'));
  await kind.openings[opening](page, info);
  return page.evaluate(async () => { await window.firstFrame.done; const { frames, settled, scrolled } = window.firstFrame; return { frames, settled, scrolled }; });
}

const box = (frame) => frame?.shown && { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
for (const [name, kind] of Object.entries(kinds)) {
  test(`${name} is drawn where it settles from its first frame`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const record = {};
    for (const place of places) for (const opening of Object.keys(kind.openings)) {
      const { frames, settled, scrolled } = await sample(page, info, kind, place, opening);
      const shown = frames.filter((frame) => frame.shown);
      record[`${place.name} (${opening})`] = { first: shown[0], settled, frames };
      expect.soft(shown.length, `${place.name}, ${opening}: shown`).toBeGreaterThan(0);
      // Every shown sample, the first frame's included, at the settled box.
      expect.soft(shown.map(box), `${place.name}, ${opening}: every shown frame`).toEqual(shown.map(() => box(settled)));
      // Nor does opening scroll the owner: focus moved into a popup drawn off its place scrolls to it.
      expect.soft([...frames, settled].map((frame) => frame.scrolled ?? scrolled), `${place.name}, ${opening}: owner's scroll`)
        .toEqual([...frames, settled].map(() => scrolled));
    }
    await info.attach('first-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  });

  test(`${name} keeps its place through the normal entrance motion`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const record = {};
    for (const place of places.filter((entry) => entry.motion)) for (const opening of Object.keys(kind.openings)) {
      const { frames } = await sample(page, info, kind, place, opening);
      // From the frame Base UI shows the positioner, while the surface fades and scales in inside it.
      const shown = frames.filter((frame) => frame.root?.opacity > 0);
      record[`${place.name} (${opening})`] = frames;
      expect.soft(shown.length, `${place.name}, ${opening}: placed`).toBeGreaterThan(0);
      const at = (frame) => ({ x: frame.root.x, y: frame.root.y });
      expect.soft(shown.map(at), `${place.name}, ${opening}: positioner`).toEqual(shown.map(() => at(shown.at(-1))));
    }
    await info.attach('motion-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
  });
}
