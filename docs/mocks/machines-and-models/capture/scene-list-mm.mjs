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

/* 02: Machines & models reached from Settings (mm-set = mm-new + mm/settings-web.py), beside mm-new (renamed only). */

/** The sidebar's fixed rows (Projects, Tasks, Wiki, and Machines & models where it still is), as one box. */
const topRows = (labels) => async (page) => page.evaluate((labels) => {
  const rows = labels.map((label) => [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && e.textContent.trim() === label && e.getBoundingClientRect().left < 340))
    .filter(Boolean).map((el) => (el.closest('a, button, [role="button"], [role="link"], li') ?? el).getBoundingClientRect());
  if (rows.length === 0) return null;
  const x = Math.min(...rows.map((r) => r.left)), y = Math.min(...rows.map((r) => r.top));
  return { x, y, width: Math.max(...rows.map((r) => r.right)) - x, height: Math.max(...rows.map((r) => r.bottom)) - y };
}, labels);
/** The Settings card titled so. */
const card = (title) => async (page) => page.evaluate((title) => {
  const h = [...document.querySelectorAll('.orbit-card-title')].find((e) => e.textContent.trim() === title);
  if (!h) return null;
  const r = h.closest('.orbit-card').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}, title);
/** A row of the open menu. */
const menuRow = (label) => async (page) => page.evaluate((label) => {
  const el = [...document.querySelectorAll('.orbit-menu .orbit-menu-label')].find((e) => e.textContent.trim() === label);
  if (!el) return null;
  const r = el.closest('[role^="menuitem"]').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}, label);
const WORK = ['Projects', 'Tasks', 'Wiki'];

const settingsDesk = (tree, boxes) => ({
  tree, path: '/settings', routes: infraRoutes(), width: 1280, height: 1020, viewport: true, boxes,
});
const accountMenu = (tree, boxes) => ({
  tree, path: '/settings', routes: infraRoutes(), width: 1280, height: 900,
  act: async (page) => { await page.locator('button.tp-user-trigger').first().click(); await page.waitForTimeout(700); },
  mouse: null,
  clip: async (page) => page.evaluate(() => {
    const a = document.querySelector('.orbit-menu').getBoundingClientRect();
    const b = document.querySelector('button.tp-user-trigger').getBoundingClientRect();
    const x = 0, y = Math.max(0, Math.min(a.top, b.top) - 16);
    return { x, y, width: Math.max(a.right, b.right) + 16, height: Math.min(innerHeight, Math.max(a.bottom, b.bottom) + 12) - y };
  }),
  boxes,
});
const pageHead = (tree, boxes) => ({
  tree, path: '/infrastructure', routes: infraRoutes(), width: 1280, height: 900,
  clip: async () => ({ x: 0, y: 0, width: 1280, height: 330 }), boxes,
});
const phoneSettings = (tree) => ({
  tree, path: '/settings', routes: infraRoutes(), size: 'phone', height: 844,
  act: async (page) => {
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('.orbit-card-title')].find((e) => e.textContent.trim() === 'Machines & models');
      h.closest('.orbit-card').scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(400);
  },
  clip: async (page) => page.evaluate(() => {
    const h = [...document.querySelectorAll('.orbit-card-title')].find((e) => e.textContent.trim() === 'Machines & models');
    const r = h.closest('.orbit-card').getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.top - 110), width: 390, height: r.height + 220 };
  }),
  boxes: { card: card('Machines & models') },
});

export const SCENES = {
  's-settings-B': settingsDesk('mm-new', { nav: navRow('Machines & models') }),
  's-settings-A': settingsDesk('mm-set', { work: topRows(WORK), card: card('Machines & models') }),
  's-menu-B': accountMenu('mm-new', { settings: menuRow('Settings') }),
  's-menu-A': accountMenu('mm-set', { row: menuRow('Machines & models') }),
  's-head-A': pageHead('mm-set', { back: '.provider-back', work: topRows(WORK) }),
  's-drawer-A': { ...drawer('mm-set', 'Wiki'), boxes: { work: topRows(WORK) } },
  's-psettings-A': phoneSettings('mm-set'),
  'drawer-today': drawer('mm-today', 'Infrastructure'),
  'drawer-new': drawer('mm-new', 'Machines & models'),
  'head-today': head('mm-today', 'Infrastructure'),
  'head-new': head('mm-new', 'Machines & models'),
  'back-today': back('mm-today'),
  'back-new': back('mm-new'),
  'phone-today': phone('mm-today'),
  'phone-new': phone('mm-new'),
};
