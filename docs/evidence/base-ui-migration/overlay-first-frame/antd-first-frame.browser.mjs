import { test, expect } from '@playwright/test';

// The replaced AntD popups at the places of choices-first-frame.browser.mjs, sampled every frame from the opening
// input (in requestAnimationFrame and after the frame is produced), reduced motion. rc-trigger positions its popup
// root with left/top and animates it with a transform even with reduced motion, so its first frame is compared by
// layout: the root's computed left/top in the first shown frame against the settled ones. Each record also keeps
// the first shown frame's opacity (the replaced popups fade in) and box.
const fixture = '/ui-migration/choices.html';
test.use({ trace: 'off' });
const places = [
  ['page', ''], ['page, flipped above', '&anchor=bottom'], ['page, right edge', '&anchor=right'], ['dialog', '&owner=dialog'],
  ['dialog, flipped above', '&owner=dialog&anchor=bottom'], ['dialog, right edge', '&owner=dialog&anchor=right'], ['drawer', '&owner=drawer'],
];
const region = (page) => page.getByRole('region', { name: 'Appearance sample' });
const press = (info, locator) => info.project.use.hasTouch ? locator.tap() : locator.click();
const kinds = {
  menu: { sample: 'attachment', open: (page, info) => press(info, region(page).getByRole('button').first()) },
  submenu: { sample: 'submenu', surface: '.sample-submenu', before: async (page, info) => {
    await press(info, region(page).getByRole('button').first());
    await expect(page.getByRole('menuitem', { name: 'Provider' })).toBeVisible();
    await page.waitForTimeout(400);
  }, open: async (page) => {
    const item = await page.getByRole('menuitem', { name: 'Provider' }).boundingBox();
    await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 5 });
  } },
  select: { sample: 'expiry', open: (page, info) => press(info, region(page).getByRole('combobox', { name: 'Sample choice' })) },
  combobox: { sample: 'search', open: (page, info) => press(info, region(page).getByRole('combobox', { name: 'Sample choice' })) },
  multiselect: { sample: 'multiple', open: (page, info) => press(info, region(page).getByRole('combobox', { name: 'Sample choice' })) },
  popover: { sample: 'popover', open: (page, info) => press(info, region(page).getByRole('button').first()) },
  tooltip: { sample: 'tooltip', open: (page) => region(page).getByRole('button').first().hover() },
  popconfirm: { sample: 'popconfirm', open: (page, info) => press(info, region(page).getByRole('button').first()) },
};

for (const [name, kind] of Object.entries(kinds)) test(`replaced ${name} is laid out where it settles from its first shown frame`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const record = {};
  for (const [place, query] of places) {
    await page.goto(`${fixture}?sample=${kind.sample}&system=antd${query}`);
    await page.mouse.move(0, 0);
    // As the first-frame test: the owner's entrance has finished and the sample holds still (a fixed sample section
    // inside the replaced modal is placed by the modal while its zoom-in runs).
    await page.evaluate(async () => {
      await document.fonts.ready;
      let last = '';
      for (let i = 0; i < 120; i += 1) {
        await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const box = JSON.stringify(document.querySelector('[data-testid="neutral"]')?.getBoundingClientRect() ?? null);
        if (box !== 'null' && box === last && document.getAnimations().every((animation) => animation.playState !== 'running')) return;
        last = box;
      }
    });
    await kind.before?.(page, info);
    await page.evaluate(async () => {
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (document.getAnimations().every((animation) => animation.playState !== 'running')) return;
      }
    });
    await page.evaluate((selector) => {
      const state = { frames: [] };
      const read = (when) => {
        const surface = [...document.querySelectorAll(selector)].at(-1);
        if (!surface) return { when, shown: false };
        let opacity = 1;
        for (let node = surface; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
        let root = surface;
        while (root.parentElement && !['absolute', 'fixed'].includes(getComputedStyle(root).position)) root = root.parentElement;
        const box = surface.getBoundingClientRect();
        return { when, shown: box.width > 0 && opacity > 0 && getComputedStyle(surface).visibility === 'visible', opacity: Math.round(opacity * 1000) / 1000,
          left: getComputedStyle(root).left, top: getComputedStyle(root).top, box: [box.x, box.y, box.width, box.height].map((v) => Math.round(v * 1000) / 1000) };
      };
      let seen = 0;
      state.done = new Promise((resolve) => {
        const after = new MessageChannel();
        after.port1.onmessage = () => state.frames.push(read('produced'));
        const tick = () => {
          const sample = read('frame');
          state.frames.push(sample);
          after.port2.postMessage(null);
          if (sample.shown) seen += 1;
          if (seen < 20 && state.frames.length < 600) requestAnimationFrame(tick);
          else setTimeout(async () => {
            await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            state.settled = read('settled');
            resolve();
          });
        };
        requestAnimationFrame(tick);
      });
      window.antdFirstFrame = state;
    }, kind.surface ?? '.sample-surface');
    await kind.open(page, info);
    const { frames, settled } = await page.evaluate(async () => { await window.antdFirstFrame.done; return { frames: window.antdFirstFrame.frames, settled: window.antdFirstFrame.settled }; });
    const first = frames.find((frame) => frame.shown);
    record[place] = { first, settled, shownReadings: frames.filter((frame) => frame.shown).length };
    expect.soft(first && { left: first.left, top: first.top }, `${place}: first shown frame's layout`).toEqual(settled.shown ? { left: settled.left, top: settled.top } : 'settled');
  }
  await info.attach('antd-first-frames', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
});
