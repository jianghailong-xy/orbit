// The scenes the infra-focus board is made of. `tree` is the vite tree they run on: `today` is HEAD's own
// src/web + src/shared, `proposal` the same with the board prototype.
import { IDS, infraRoutes, runners } from './data.mjs';

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
  /* States the board never drew: an engine one of whose two accounts is signed out, a machine with
     nothing installed, an offline one; and the keys while they are being read. */
  'impl-edges': {
    tree: 'impl', path: '/infrastructure', height: 1400,
    routes: infraRoutes({
      runnerList: () => {
        const [wikova, workstation, mac, hpc] = runners();
        const claude = wikova.engines.find((e) => e.engine === 'claude');
        const partly = { ...claude, accounts: [claude.accounts[0], { ...claude.accounts[1], auth: 'no' }] };
        return [
          { ...hpc, name: 'lab', displayName: 'lab', engines: hpc.engines.map((e) => (e.engine === 'claude' ? partly : e)) },
          { ...mac, name: 'fresh-box', displayName: 'fresh-box', hostname: 'fresh-box',
            engines: ['claude', 'codex', 'kimi'].map((engine) => ({ engine, installed: false, auth: 'unknown' })) },
          { ...workstation, name: 'thinkpad', displayName: 'thinkpad', online: false, activeSessions: 0,
            lastHeartbeatAt: new Date(Date.parse('2026-09-28T12:00:00Z') - 26 * 3600_000).toISOString() },
        ];
      },
    }),
    clip: around('#machines', { pad: 4 }), boxes: { partly: '.mc-chip.out' },
  },
  'impl-loading': {
    tree: 'impl', path: '/infrastructure', height: 1400,
    routes: () => ({ ...infraRoutes()(), 'GET /api/providers/mine': () => new Promise((resolve) => setTimeout(() => resolve([]), 20_000)) }),
    clip: around('#keys', { pad: 4 }), boxes: { loading: '.vk-loading' },
  },

  /* ── the implementation (the worktree's src/web), the same scenes as the board's 改后 ── */
  'impl-page': {
    tree: 'impl', path: '/infrastructure', routes: infraRoutes(), height: 1400, grow: '.infra-engines',
    clip: column(),
    boxes: { chips: '.mc-row', signin: '.mc-signin', keys: '#keys', vendor: '.vk-card', more: '.pv-more', pools: '#pools', index: '.infra-engines' },
  },
  'impl-fold': { tree: 'impl', path: '/infrastructure', routes: infraRoutes(), viewport: true, width: 1280, height: 900, boxes: {} },
  'impl-signin': {
    tree: 'impl', path: '/infrastructure', routes: infraRoutes(), height: 1800,
    act: async (page) => { await page.locator('.mc-signin').first().click(); await page.waitForTimeout(900); },
    clip: around('.re-runner-card', { pad: 1 }), boxes: { panel: '.re-panel:has(.rsi)', row: '[data-engine="kimi"]' },
  },
  'impl-phone': {
    tree: 'impl', path: '/infrastructure', routes: infraRoutes(), size: 'phone', height: 844, grow: '.vk-card',
    clip: around('.prov-page-head', { pad: 8, toFirst: '.vk-card' }), boxes: { chips: '.mc-row' },
  },

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
