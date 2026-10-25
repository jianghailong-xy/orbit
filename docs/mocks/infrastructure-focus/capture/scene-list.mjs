// The scenes the infra-focus board is made of. `tree` is the vite tree they run on: `today` is HEAD's own
// src/web + src/shared, `proposal` the same with the board prototype.
import { IDS, infraRoutes } from './data.mjs';

/** localStorage the Infrastructure page keeps its folds in. */
export const folds = (runnersOpen = [], groupsOpen = []) => ({
  fn: ({ r, g }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(r));
    localStorage.setItem('orbit:providers-open-accounts', JSON.stringify(g));
  },
  arg: { r: runnersOpen, g: groupsOpen },
});

/** The page's own column: from its head to the bottom of its last section, padded. */
export const column = (pad = 16) => async (page) => page.evaluate((pad) => {
  const head = document.querySelector('.prov-page-head');
  if (!head) throw new Error('no page head');
  const col = head.parentElement;
  const r = col.getBoundingClientRect();
  return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: r.width + 2 * pad, height: r.height + 2 * pad };
}, pad);

/** The box of the nearest ancestor of `sel` matching `up` (or `sel` itself), padded. */
export const around = (sel, { up, pad = 0, to, toFirst } = {}) => async (page) => page.evaluate(({ sel, up, pad, to, toFirst }) => {
  let el = document.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  if (up) el = el.closest(up);
  const r = el.getBoundingClientRect();
  let bottom = r.bottom;
  if (to) { const last = [...document.querySelectorAll(to)].pop(); if (last) bottom = last.getBoundingClientRect().bottom; }
  if (toFirst) { const first = document.querySelector(toFirst); if (first) bottom = first.getBoundingClientRect().bottom; }
  return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: r.width + 2 * pad, height: bottom - r.top + 2 * pad };
}, { sel, up, pad, to, toFirst });

const flag = (name) => ({ fn: (k) => localStorage.setItem(k, '1'), arg: name });

export const SCENES = {
  'new-page': {
    tree: 'proposal', path: '/infrastructure', routes: infraRoutes(), height: 1400, grow: '.infra-index',
    clip: column(),
    boxes: { chips: '.re-chips', signin: '.re-chip-signin', status: '.re-runner-status', keys: '#keys', vendor: '.vk-card', vhead: '.vk-card .re-head', model: '.vk-model', state: '.vk-state', more: '.pv-more', pools: '#pools', index: '.infra-index' },
  },
  'new-banner': {
    tree: 'proposal', path: '/infrastructure', routes: infraRoutes(), init: flag('proto:banner'), height: 1400,
    clip: around('.prov-page-head', { pad: 16, toFirst: '.re-runner-card' }), boxes: { attn: '.infra-attn' },
  },
  'new-strip': {
    tree: 'proposal', path: '/infrastructure', routes: infraRoutes(), init: flag('proto:strip'), height: 1400,
    clip: around('.prov-page-head', { pad: 16, toFirst: '.re-runner-card' }), boxes: { strip: '.infra-strip' },
  },
  'new-signin': {
    tree: 'proposal', path: '/infrastructure', routes: infraRoutes(), height: 1800,
    act: async (page) => { await page.locator('.re-chip-signin').first().click(); await page.waitForTimeout(900); },
    clip: around('.re-runner-card', { pad: 1 }), boxes: { panel: '.re-panel', row: '[data-engine="kimi"]' },
  },
  'new-fold': { tree: 'proposal', path: '/infrastructure', routes: infraRoutes(), viewport: true, width: 1280, height: 900, boxes: {} },
  'today-fold': { tree: 'today', path: '/infrastructure', routes: infraRoutes(), viewport: true, width: 1280, height: 900, boxes: {} },
  'new-phone': {
    tree: 'proposal', path: '/infrastructure', routes: infraRoutes(), size: 'phone', height: 844, grow: '.vk-card',
    clip: around('.prov-page-head', { pad: 8, toFirst: '.vk-card' }), boxes: { chips: '.re-chips' },
  },
  'today-page': {
    tree: 'today', path: '/infrastructure', routes: infraRoutes(), height: 1400, grow: '#pools',
    clip: column(),
    boxes: { attn: '.infra-attn', engines: '.infra-engines', machines: '#machines', keys: '#keys', gallery: '.provider-more', pools: '#pools' },
  },
};
