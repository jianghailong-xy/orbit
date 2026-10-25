// Scenes for docs/mocks/machines-and-models: the same page and fixtures as the infra-focus kit, on two trees
// of main: mm-today as it is, mm-new with the rename prototype (mm/rename-web.py).
import { IDS, infraRoutes } from '../data.mjs';
import { around } from '../scene-list.mjs';

/** The sidebar row that names the page: the clickable around the element whose words are the label. */
const navRow = (label) => async (page) => page.evaluate((label) => {
  const el = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && e.textContent.trim() === label && e.getBoundingClientRect().left < 340);
  if (!el) return null;
  const row = el.closest('a, button, [role="button"], [role="link"], li') ?? el;
  const r = row.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}, label);

const head = (tree, label) => ({
  tree, path: '/infrastructure', routes: infraRoutes(), width: 1280, height: 900,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 330 }),
  boxes: { nav: navRow(label), h1: 'h1.page-title' },
});
/** The key page's top: its back link, its title and the vendor's card under it. */
const keyTop = async (page) => page.evaluate(() => {
  const link = document.querySelector('.provider-back').getBoundingClientRect();
  return { x: Math.max(0, link.left - 24), y: Math.max(0, link.top - 20), width: 760, height: 190 };
});
const keyRoutes = () => () => ({
  ...infraRoutes()(),
  'GET /api/providers/presets': {},
  [`GET /api/providers/mine/${IDS.keyDeepseek}/usage`]: { providerId: IDS.keyDeepseek, engines: [], sessions: 0, tasks: 0 },
});
const back = (tree) => ({
  tree, path: `/providers/${IDS.keyDeepseek}`, routes: keyRoutes(), width: 1280, height: 900,
  clip: keyTop,
  boxes: { back: '.provider-back' },
});
const phone = (tree) => ({
  tree, path: '/infrastructure', routes: infraRoutes(), size: 'phone', height: 844,
  clip: async () => ({ x: 0, y: 0, width: 390, height: 300 }),
  boxes: { h1: 'h1.page-title' },
});

/** The phone's drawer, opened from the header's menu button. */
const drawer = (tree, label) => ({
  tree, path: '/infrastructure', routes: infraRoutes(), size: 'phone', height: 844,
  act: async (page) => {
    const btn = page.locator('button[aria-label]').filter({ hasText: '' }).first();
    const labelled = page.locator('header button, button').filter({ has: page.locator('svg') });
    const menu = page.locator('button[aria-label*="menu" i], button[aria-label*="navigation" i], button[aria-label*="sidebar" i]').first();
    await (await menu.count() ? menu : btn).click();
    await page.waitForTimeout(700);
  },
  clip: async () => ({ x: 0, y: 0, width: 390, height: 420 }),
  boxes: { nav: navRow(label) },
});

export const SCENES = {
  'drawer-today': drawer('mm-today', 'Infrastructure'),
  'drawer-new': drawer('mm-new', 'Machines & models'),
  'head-today': head('mm-today', 'Infrastructure'),
  'head-new': head('mm-new', 'Machines & models'),
  'back-today': back('mm-today'),
  'back-new': back('mm-new'),
  'phone-today': phone('mm-today'),
  'phone-new': phone('mm-new'),
};
