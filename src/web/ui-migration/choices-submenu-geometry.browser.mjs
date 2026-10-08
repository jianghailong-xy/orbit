import { test, expect } from '@playwright/test';

// Where a submenu settles beside its item, against the replaced AntD submenu opened at the same place: the side
// it opens to, its box from the item's top left corner, its width and height. The parent menu is at the left of
// the page, in its middle, at its right edge or at the right edge of a dialog (the replaced one's in the replaced
// modal); the submenu's second label is short, as long as an account name, or wider than a phone leaves beside
// the item; in the submenu sample (Provider alone) and the session menu (Provider among other items).
const fixture = '/ui-migration/choices.html';
test.use({ trace: 'off' });

const places = [
  { name: 'left of the page', query: '', antdSide: 'right' },
  { name: 'middle of the page', query: '&anchor=center' },
  { name: 'right edge', query: '&anchor=right', antdSide: 'left' },
  { name: 'right edge of a dialog', query: '&owner=dialog&anchor=right', antdSide: 'left' },
];
const cases = ['submenu', 'session'].flatMap((sample) => ['short', 'medium', 'long'].map((labels) => ({ sample, labels })));
const surfaces = {
  orbit: '.orbit-menu[data-nested]',
  antd: '.ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden) .ant-dropdown-menu-sub',
};
const press = (info, locator) => info.project.use.hasTouch ? locator.tap() : locator.click();

// Until the menus and the sample's trigger hold still, no animation runs and the replaced popups have shed
// their motion classes (WebKit can hold one at its starting zoom for a few frames before animating it).
async function still(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const moving = /-(appear|enter|leave)\b/;
    let last = '';
    for (let count = 0; count < 120; count += 1) {
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const boxes = JSON.stringify([...document.querySelectorAll('[role="menu"], [aria-label="Appearance sample"] button')]
        .map((node) => node.getBoundingClientRect()));
      if (boxes === last && document.getAnimations().every((animation) => animation.playState !== 'running')
        && [...document.querySelectorAll('.ant-dropdown, .ant-dropdown-menu-submenu-popup')].every((node) => !moving.test(node.className))) return;
      last = boxes;
    }
  });
}

async function settled(page, info, system, place, { sample, labels }) {
  await page.goto(`${fixture}?sample=${sample}&system=${system}${place.query}${labels === 'short' ? '' : `&labels=${labels}`}`);
  await page.mouse.move(0, 0);
  // Linux WebKit's phone emulation narrows the visual viewport by the page's classic scrollbar (382 of 390px),
  // and a fixed sample laid out before that keeps the wider place until the page scrolls; one page then opens
  // its menu where the other does not (see choices-first-frame). A scroll puts both samples at the same place.
  await page.evaluate(async () => {
    scrollTo(0, 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    scrollTo(0, 0);
  });
  await still(page);
  await press(info, page.getByRole('region', { name: 'Appearance sample' }).getByRole('button').first());
  // Not exact: the replaced item's arrow icon adds its label ("right") to the item's name.
  const item = page.getByRole('menuitem', { name: 'Provider' });
  await expect(item).toBeVisible();
  await still(page);
  // A pointer moving onto the item in steps, as a hand does; one jump can miss the replaced menu's enter.
  const box = await item.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(page.locator(surfaces[system])).toBeVisible();
  await still(page);
  return page.evaluate((selector) => {
    const round = (value) => Math.round(value * 1000) / 1000;
    const rect = (node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x: round(x), y: round(y), width: round(width), height: round(height) };
    };
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === 'Provider');
    return { item: rect(item), submenu: rect([...document.querySelectorAll(selector)].at(-1)),
      viewport: [round(visualViewport.width), document.documentElement.clientWidth] };
  }, surfaces[system]);
}

// The submenu's side, and its box from its item's top left corner.
const shape = ({ item, submenu }) => ({
  side: submenu.x + submenu.width / 2 > item.x + item.width / 2 ? 'right' : 'left',
  x: Math.round((submenu.x - item.x) * 1000) / 1000, y: Math.round((submenu.y - item.y) * 1000) / 1000,
  width: submenu.width, height: submenu.height,
});

for (const place of places) test(`submenu at the ${place.name} settles where the replaced submenu does`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const record = {};
  for (const entry of cases) {
    const name = `${entry.sample}, ${entry.labels} label`;
    const antd = await settled(page, info, 'antd', place, entry);
    const orbit = await settled(page, info, 'orbit', place, entry);
    record[name] = { antd, orbit };
    // The same place: the item where the replaced one was. Not in a dialog in Linux WebKit's desktop, whose page
    // has a classic scrollbar: the replaced modal's scroll lock removes it and the Orbit dialog keeps its gutter
    // (the known dialog scroll-lock difference, p4.2), so the two pages differ in width there and the item is 8px
    // apart; there the submenu is compared from its item only.
    if (antd.viewport[1] === orbit.viewport[1]) expect.soft(orbit.item, `${name}: the item`).toEqual(antd.item);
    else info.annotations.push({ type: 'not the same place', description: `${name}: viewport ${antd.viewport} / ${orbit.viewport}` });
    if (place.antdSide) expect.soft(shape(antd).side, `${name}: the replaced submenu's side`).toBe(place.antdSide);
    expect.soft(shape(orbit), `${name}: the replaced submenu's box`).toEqual(shape(antd));
  }
  await info.attach('submenu-geometry', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
});
