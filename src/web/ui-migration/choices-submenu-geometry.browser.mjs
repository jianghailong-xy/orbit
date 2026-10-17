import { test, expect } from '@playwright/test';

// Where a submenu settles beside its item: the side it opens to (the side the replaced submenu opened to), and its
// box from the item's top left corner, its width and height, recorded. The parent menu is at the left of the page,
// in its middle, at its right edge or at the right edge of a dialog; the submenu's second label is short, as long
// as an account name, or wider than a phone leaves beside the item; in the submenu sample (Provider alone) and the
// session menu (Provider among other items).
const fixture = '/ui-migration/choices.html';
test.use({ trace: 'off' });

const places = [
  { name: 'left of the page', query: '', side: 'right' },
  { name: 'middle of the page', query: '&anchor=center' },
  { name: 'right edge', query: '&anchor=right', side: 'left' },
  { name: 'right edge of a dialog', query: '&owner=dialog&anchor=right', side: 'left' },
];
const cases = ['submenu', 'session'].flatMap((sample) => ['short', 'medium', 'long'].map((labels) => ({ sample, labels })));
const SUBMENU = '.orbit-menu[data-nested]';
const press = (info, locator) => info.project.use.hasTouch ? locator.tap() : locator.click();

// Until the menus and the sample's trigger hold still and no animation runs.
async function still(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    let last = '';
    for (let count = 0; count < 120; count += 1) {
      await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const boxes = JSON.stringify([...document.querySelectorAll('[role="menu"], [aria-label="Appearance sample"] button')]
        .map((node) => node.getBoundingClientRect()));
      if (boxes === last && document.getAnimations().every((animation) => animation.playState !== 'running')) return;
      last = boxes;
    }
  });
}

async function settled(page, info, place, { sample, labels }) {
  await page.goto(`${fixture}?sample=${sample}${place.query}${labels === 'short' ? '' : `&labels=${labels}`}`);
  await page.mouse.move(0, 0);
  // Linux WebKit's phone emulation narrows the visual viewport by the page's classic scrollbar (382 of 390px),
  // and a fixed sample laid out before that keeps the wider place until the page scrolls. A scroll puts the
  // sample at its place.
  await page.evaluate(async () => {
    scrollTo(0, 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    scrollTo(0, 0);
  });
  await still(page);
  await press(info, page.getByRole('region', { name: 'Appearance sample' }).getByRole('button').first());
  const item = page.getByRole('menuitem', { name: 'Provider' });
  await expect(item).toBeVisible();
  await still(page);
  // A pointer moving onto the item in steps, as a hand does.
  const box = await item.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(page.locator(SUBMENU)).toBeVisible();
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
  }, SUBMENU);
}

// The submenu's side, and its box from its item's top left corner.
const shape = ({ item, submenu }) => ({
  side: submenu.x + submenu.width / 2 > item.x + item.width / 2 ? 'right' : 'left',
  x: Math.round((submenu.x - item.x) * 1000) / 1000, y: Math.round((submenu.y - item.y) * 1000) / 1000,
  width: submenu.width, height: submenu.height,
});

for (const place of places) test(`submenu at the ${place.name} opens to the replaced submenu's side; its box is recorded`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const record = {};
  for (const entry of cases) {
    const name = `${entry.sample}, ${entry.labels} label`;
    const orbit = await settled(page, info, place, entry);
    record[name] = { orbit };
    if (place.side) expect.soft(shape(orbit).side, `${name}: the replaced submenu's side`).toBe(place.side);
  }
  await info.attach('submenu-geometry', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
});
