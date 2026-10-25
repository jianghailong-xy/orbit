// The scenes the cursor-engine boards are made of. `tree` is the vite tree they run on: `today` is this
// branch's own src/web + src/shared, `proposal` the same with the board prototype (prototype.patch).
import {
  IDS, NOW, runners, providers, workspaces, runnersProposal, providersProposal, cursorHealth, cursorKey, CURSOR_TEAM,
} from './data.mjs';

const ago = (min) => new Date(NOW - min * 60_000).toISOString();

/** localStorage the Infrastructure page keeps its folds in: which machine cards and account groups are open. */
const folds = (runnersOpen = [], groupsOpen = []) => ({
  fn: ({ r, g }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(r));
    localStorage.setItem('orbit:providers-open-accounts', JSON.stringify(g));
  },
  arg: { r: runnersOpen, g: groupsOpen },
});

const balance = { ok: true, balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '0.00', toppedUpBalance: '110.00' }], isAvailable: true, fetchedAt: ago(2), sharedWith: [] };

const infra = (runnerList, keys) => () => ({
  'GET /api/runners': runnerList(),
  'GET /api/providers/mine': keys(),
  'GET /api/providers': keys(),
  'GET /api/workspaces': workspaces(),
  'GET /api/providers/pools': [],
  'GET /api/providers/shared-pools': [],
  [`GET /api/providers/mine/${IDS.keyDeepseek}/balance`]: balance,
});

/** The box of the nearest ancestor of `sel` matching `up` (or `sel` itself), padded. */
const around = (sel, { up, pad = 0, to } = {}) => async (page) => page.evaluate(({ sel, up, pad, to }) => {
  let el = document.querySelector(sel);
  if (!el) throw new Error(`no ${sel}`);
  if (up) el = el.closest(up);
  const r = el.getBoundingClientRect();
  let bottom = r.bottom;
  if (to) { const last = [...document.querySelectorAll(to)].pop(); if (last) bottom = last.getBoundingClientRect().bottom; }
  return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: r.width + 2 * pad, height: bottom - r.top + 2 * pad };
}, { sel, up, pad, to });

/** The hpc card with only `cursor` changed. */
const hpcWith = (cursor, extra = {}) => () => {
  const [hpc] = runnersProposal({ cursor });
  return [{ ...hpc, ...extra }];
};

export const SCENES = {
  /* ── 2 · Infrastructure ─────────────────────────────────────────────── */
  'w2-overview-now': {
    tree: 'today', path: '/infrastructure', routes: infra(runners, providers),
    clip: around('.infra-engines', { up: '.re-sec', pad: 2 }),
    boxes: {},
  },
  'w2-overview-new': {
    tree: 'proposal', path: '/infrastructure', routes: infra(runnersProposal, providersProposal),
    clip: around('.infra-engines', { up: '.re-sec', pad: 2 }),
    boxes: { card: '.infra-engine:has(.provider-tile) >> nth=6' },
  },
  'w2-machine-now': {
    tree: 'today', path: '/infrastructure', routes: infra(runners, providers), init: folds([IDS.hpc]), height: 1400,
    clip: around('.re-runner-card', { pad: 1 }),
    boxes: {},
  },
  'w2-machine-folded': {
    tree: 'proposal', path: '/infrastructure', routes: infra(runnersProposal, providersProposal), init: folds([IDS.hpc]), height: 1400,
    clip: around('.re-runner-card', { pad: 1 }),
    boxes: { row: '[data-engine="cursor"]', add: '[data-engine="cursor"] .re-add-account', quota: '[data-engine="cursor"] .re-quota', meta: '[data-engine="cursor"] .re-meta' },
  },
  'w2-machine-open': {
    tree: 'proposal', path: '/infrastructure', routes: infra(runnersProposal, providersProposal), init: folds([IDS.hpc], [`${IDS.hpc}/cursor`]), height: 1500,
    clip: around('[data-engine="cursor"]', { to: '.re-acct', pad: 0 }),
    boxes: {
      head: '[data-engine="cursor"]', def: '.re-acct >> nth=0', team: '.re-acct >> nth=1',
      defQuota: '.re-acct >> nth=0 >> .re-quota', teamQuota: '.re-acct >> nth=1 >> .re-quota',
    },
  },
  'w2-attention': {
    tree: 'proposal', path: '/infrastructure',
    routes: infra(hpcWith(cursorHealth({ auth: 'no', accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'no' }] })), providersProposal),
    clip: around('.infra-attn', { pad: 1 }),
    boxes: { line: '.infra-attn-row' },
  },
  'w2-state-signed-out': {
    tree: 'proposal', path: '/infrastructure', init: folds([IDS.hpc]), height: 1400,
    routes: infra(hpcWith(cursorHealth({ auth: 'no', accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'no' }] })), providersProposal),
    clip: around('[data-engine="cursor"]'),
  },
  'w2-state-not-installed': {
    tree: 'proposal', path: '/infrastructure', init: folds([IDS.box]), height: 1400,
    routes: infra(() => [runnersProposal()[2]], providersProposal),
    clip: around('[data-engine="cursor"]'),
  },
  'w2-state-update-runner': {
    tree: 'proposal', path: '/infrastructure', init: folds([IDS.mac]), height: 1400,
    routes: infra(() => [runnersProposal()[1]], providersProposal),
    clip: around('[data-engine="cursor"]'),
  },
  'w2-state-wrong-version': {
    tree: 'proposal', path: '/infrastructure', init: folds([IDS.hpc]), height: 1400,
    routes: infra(hpcWith(cursorHealth({ version: '2026.10.16-e3cb207', accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' }] })), providersProposal),
    clip: around('[data-engine="cursor"]'),
  },
};

/* ── 3 · Add account, Re-sign in, Remove (Cursor rows on hpc) ───────── */
const LOGIN_URL = 'https://cursor.com/loginDeepControl?challenge=Hk3v9QxP2mWcT8sLr0aYbN6dEfJ4uZgKq1oVhI7nM5w&uuid=6f0c2a4e-81d3-4b9e-a7f2-3c5d9e1b0a47&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true';
const loginState = (status, over = {}) => ({ status, engine: 'cursor', url: null, userCode: null, message: null, account: null, ...over });
const linkState = (over = {}) => loginState('awaiting_approval', { url: LOGIN_URL, expiresAt: new Date(NOW + 26 * 60_000).toISOString(), ...over });
const hpcOpen = { init: folds([IDS.hpc], [`${IDS.hpc}/cursor`]), height: 1700 };
const signInRoutes = (post, get, extra = {}) => () => ({
  ...infra(runnersProposal, providersProposal)(),
  [`POST /api/runners/${IDS.hpc}/login`]: post,
  [`GET /api/runners/${IDS.hpc}/login`]: get,
  ...extra,
});
const addAccount = async (page) => {
  await page.locator('[data-engine="cursor"] .re-add-account').click();
  await page.waitForTimeout(300);
  await page.locator('[data-engine="cursor"] .re-add .rsi-input').fill('Work');
  await page.waitForTimeout(3200); // a poll at 2 s brings the state after POST
};
const cursorPanel = around('[data-engine="cursor"]', { pad: 0 });
const addBoxes = { name: '[data-engine="cursor"] .re-add', panel: '[data-engine="cursor"] .re-panel', open: '[data-engine="cursor"] .rsi-open', expiry: '[data-engine="cursor"] .rsi-row', warn: '[data-engine="cursor"] .rsi-warn', btn: '[data-engine="cursor"] .rsi-btn' };

Object.assign(SCENES, {
  'w3-add-pending': { tree: 'proposal', path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending'), loginState('pending')), act: addAccount, clip: cursorPanel, boxes: { name: addBoxes.name, panel: addBoxes.panel } },
  'w3-add-link': { tree: 'proposal', path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending'), linkState()), act: addAccount, clip: cursorPanel, boxes: { name: addBoxes.name, open: addBoxes.open, expiry: addBoxes.expiry, panel: addBoxes.panel } },
  'w3-add-expired': { tree: 'proposal', path: '/infrastructure', ...hpcOpen, routes: signInRoutes(linkState(), loginState('failed', { message: 'The sign-in link expired before anyone signed in with it.' })), act: addAccount, clip: cursorPanel, boxes: { warn: addBoxes.warn, btn: addBoxes.btn, panel: addBoxes.panel } },
  'w3-add-done': { tree: 'proposal', path: '/infrastructure', ...hpcOpen, routes: signInRoutes(linkState(), loginState('done')), act: addAccount, clip: cursorPanel, boxes: { panel: addBoxes.panel } },
  'w3-resign-menu': {
    tree: 'proposal', path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending'), loginState(null, { engine: null })),
    act: async (page) => { await page.locator('.re-acct >> nth=1 >> button[aria-label="More actions"]').click(); await page.waitForTimeout(500); },
    mouse: [0, 0],
    clip: async (page) => {
      const row = await page.locator('.re-acct >> nth=1').boundingBox();
      const menu = await page.locator('.re-account-menu').first().boundingBox();
      const top = Math.min(row.y, menu.y) - 8; const bottom = Math.max(row.y + row.height, menu.y + menu.height) + 8;
      return { x: row.x, y: top, width: row.width, height: bottom - top };
    },
    boxes: { resign: 'text=Re-sign in', remove: 'text=Remove account', row: '.re-acct >> nth=1' },
  },
  'w3-resign-link': {
    tree: 'proposal', path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending', { account: CURSOR_TEAM }), linkState({ account: CURSOR_TEAM })),
    act: async (page) => {
      await page.locator('.re-acct >> nth=1 >> button[aria-label="More actions"]').click(); await page.waitForTimeout(400);
      await page.locator('text=Re-sign in').click(); await page.waitForTimeout(3200);
    },
    clip: async (page) => page.locator('.re-acct').nth(1).boundingBox(),
    boxes: { open: '.re-acct >> nth=1 >> .rsi-open', expiry: '.re-acct >> nth=1 >> .rsi-row' },
  },
  'w3-remove-confirm': {
    tree: 'proposal', path: '/infrastructure', ...hpcOpen, width: 1440, routes: infra(runnersProposal, providersProposal),
    act: async (page) => {
      await page.locator('.re-acct >> nth=1 >> button[aria-label="More actions"]').click(); await page.waitForTimeout(400);
      await page.locator('text=Remove account').click(); await page.waitForTimeout(600);
    },
    mouse: [0, 0],
    clip: async (page) => {
      const row = await page.locator('.re-acct >> nth=1').boundingBox();
      const pop = await page.locator('[role="alertdialog"], [role="dialog"]').last().boundingBox();
      const top = Math.min(row.y, pop.y) - 8; const bottom = Math.max(row.y + row.height, pop.y + pop.height) + 8;
      const left = Math.min(row.x, pop.x - 8); const right = Math.max(row.x + row.width, pop.x + pop.width + 8);
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
    boxes: { pop: '[role="alertdialog"], [role="dialog"]' },
  },
  'w3-remove-refused': {
    tree: 'proposal', path: '/infrastructure', ...hpcOpen,
    routes: infra(() => { const r = runnersProposal(); r[0] = { ...r[0], accountRemove: { engine: 'cursor', account: CURSOR_TEAM, status: 'failed', message: 'Team is in use: 2 sessions on hpc are running on it. Remove it once they finish.' } }; return r; }, providersProposal),
    clip: async (page) => page.locator('.re-acct').nth(1).boundingBox(),
    boxes: { panel: '.re-acct >> nth=1 >> .re-panel' },
  },
});

/* ── 1 · New session: the engine list ──────────────────────────────── */
const NEW = `/workspaces/${IDS.ws}/new`;
const newSession = (runnerList, keys) => () => ({
  ...infra(runnerList, keys)(),
  'GET /api/sessions': [],
});
const openEngines = async (page) => { await page.locator('.np-card').first().click(); await page.waitForTimeout(500); };
const heroClip = async (page) => {
  const card = await page.locator('.np-card').first().boundingBox();
  const pop = await page.locator('.np-list').first().boundingBox();
  const left = Math.min(card.x, pop.x) - 70; const right = Math.max(card.x + card.width, pop.x + pop.width) + 70;
  const top = card.y - 24; const bottom = pop.y + pop.height + 16;
  return { x: left, y: top, width: right - left, height: bottom - top };
};
const cursorRowClip = async (page) => {
  const row = await page.locator('.np-row', { hasText: 'Cursor CLI' }).first().boundingBox();
  return { x: row.x - 6, y: row.y - 4, width: row.width + 12, height: row.height + 8 };
};
const hpcOnly = (cursor, caps) => () => { const [hpc] = runnersProposal({ cursor }); return [{ ...hpc, ...(caps ? { capabilities: caps } : {}) }]; };
const noCursorKey = () => providersProposal().filter((p) => p.presetSlug !== 'cursor');

Object.assign(SCENES, {
  'w1-engines-now': { tree: 'today', path: NEW, routes: newSession(runners, providers), act: openEngines, clip: heroClip, boxes: { list: '.np-list' } },
  'w1-engines-new': { tree: 'proposal', path: NEW, routes: newSession(runnersProposal, providersProposal), act: openEngines, clip: heroClip, boxes: { list: '.np-list', cursor: '.np-row:has-text("Cursor CLI")' } },
  'w1-row-not-installed': { tree: 'proposal', path: NEW, routes: newSession(hpcOnly({ engine: 'cursor', installed: false, auth: 'unknown' }), providersProposal), act: openEngines, clip: cursorRowClip },
  'w1-row-signed-out': { tree: 'proposal', path: NEW, routes: newSession(hpcOnly(cursorHealth({ auth: 'no', accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'no' }] })), noCursorKey), act: openEngines, clip: cursorRowClip },
  'w1-row-update-runner': { tree: 'proposal', path: NEW, routes: newSession(hpcOnly(undefined, ['provider:dsh']), providersProposal), act: openEngines, clip: cursorRowClip },
  'w1-row-version': { tree: 'proposal', path: NEW, routes: newSession(hpcOnly(cursorHealth({ version: '2026.10.16-e3cb207' })), providersProposal), act: openEngines, clip: cursorRowClip },
});

/* ── 4 · API keys: the gallery, the connect form, a key that stopped working ─────── */
const galleryClip = around('.provider-gallery', { pad: 2 });
const keysWith = (extra) => () => [...providers(), ...extra];
const connect = (testAnswer) => () => ({
  ...infra(runnersProposal, () => providers())(),
  'POST /api/providers/test': testAnswer,
});
const typeKey = async (page) => {
  await page.locator('input[type="password"], input[autocomplete="new-password"]').first().fill('key_8f3a0c2e9b7d41f6a5e0c3b2d1f4e6a8');
  await page.waitForTimeout(200);
};
const pressConnect = async (page) => { await typeKey(page); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.waitForTimeout(900); };
const formClip = around('.provider-form', { pad: 0 });

Object.assign(SCENES, {
  'w4-gallery-now': { tree: 'today', path: '/infrastructure', routes: infra(runners, providers), clip: galleryClip, grow: '.provider-gallery' },
  'w4-gallery-new': { tree: 'proposal', path: '/infrastructure', routes: infra(runnersProposal, providers), clip: galleryClip, grow: '.provider-gallery', boxes: { card: '.provider-card:has-text("Cursor")' } },
  'w4-keys-new': {
    tree: 'proposal', path: '/infrastructure', height: 1300, grow: '.provider-keys',
    routes: infra(runnersProposal, keysWith([cursorKey(), cursorKey({ id: IDS.keyCursor2, slug: 'cursor-api-2', label: 'Cursor 2', lastUsedAt: null, cursorCheck: 'rejected' })])),
    clip: async (page) => page.evaluate(() => {
      const rows = [...document.querySelectorAll('.provider-keys tr')];
      const grp = rows.find((r) => /^\s*Cursor/.test(r.textContent ?? '') && r.className.includes('grp')) ?? rows.find((r) => (r.textContent ?? '').includes('Cursor'));
      const table = document.querySelector('.provider-keys').getBoundingClientRect();
      const head = document.querySelector('.provider-keys thead')?.getBoundingClientRect();
      const g = grp.getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      return { x: table.left, y: g.top, width: table.width, height: last.bottom - g.top + 2, headTop: head?.top };
    }),
    boxes: { bad: '.dsb-line.fail >> nth=-1' },
  },
  'w4-connect': { tree: 'proposal', path: '/providers/new/cursor', routes: connect({ ok: true, message: 'ok' }), height: 1100, act: typeKey, clip: formClip, grow: '.provider-actions', boxes: { idbar: '.provider-idbar', works: '.provider-works', who: '.provider-who' } },
  'w4-connect-invalid': {
    tree: 'proposal', path: '/providers/new/cursor', height: 1100, grow: '.provider-actions',
    routes: connect({ ok: false, message: 'Cursor rejected this key: “The provided API key is invalid.” Check it on cursor.com and paste it again.' }),
    act: pressConnect, clip: around('.provider-actions', { pad: 6 }), boxes: { err: '.provider-actions-start' },
  },
  'w4-connect-unreachable': {
    tree: 'proposal', path: '/providers/new/cursor', height: 1100, grow: '.provider-actions',
    routes: connect({ ok: false, message: 'Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine.' }),
    act: pressConnect, clip: around('.provider-actions', { pad: 6 }), boxes: { err: '.provider-actions-start' },
  },
});

/* ── 5 · A Cursor session: model and variant, a message sent mid-turn, context ──────── */
import { SESSION, SESSION_PATH, WORKSPACE } from '/var/tmp/cursor-engine-mock/proposal/src/web/ui-migration/session-fixtures.mjs';
const T = (m, s = 0) => `2026-09-28T11:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const TURN1 = 'turnC1', TURN2 = 'turnC2';
const ws = { ...WORKSPACE, name: 'orbit', runnerId: IDS.hpc, lastProvider: 'cursor', provider: 'cursor' };
export const cursorSessionRow = (over = {}) => ({
  ...SESSION, workspace: ws, workspaceId: ws.id, runnerId: IDS.hpc, assignedRunnerId: IDS.hpc,
  provider: 'cursor', engine: 'cursor', model: 'default', effort: null, fastMode: false, permissionMode: 'acceptEdits',
  title: 'Fix the flaky export test', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  pendingApprovals: 0, engineTurnActive: false, tags: [], folderId: null, shared: false, pinnedAt: null,
  lastUserText: null, lastAssistantText: null, lastTurnAt: T(42), updatedAt: T(42), cursorAccount: 'default', ...over,
});
const doneTurn = [
  { seq: 1, type: 'user', payload: { text: 'The nightly export test fails about once a week. Find out why and fix it.' }, turnId: TURN1, ts: T(30) },
  { seq: 2, type: 'assistant', payload: { text: 'Running the export tests a few times to catch the failure.' }, turnId: TURN1, ts: T(30, 20) },
  { seq: 3, type: 'tool_use', payload: { id: 'c1', name: 'Bash', input: { command: 'npm test -- export.spec.ts --repeat 5', description: 'Run the export tests five times' } }, turnId: TURN1, ts: T(30, 30) },
  { seq: 4, type: 'tool_result', payload: { toolUseId: 'c1', content: '4 passed, 1 failed\nexport.spec.ts › rows for yesterday: expected 3 rows, got 2', isError: true }, turnId: TURN1, ts: T(31) },
  { seq: 5, type: 'assistant', payload: { text: 'The test builds "yesterday" in the machine’s local time zone, so it misses a row whenever it runs just after midnight UTC. I pinned the test clock to UTC in `export.spec.ts`; five runs in a row now pass.' }, turnId: TURN1, ts: T(33) },
  { seq: 6, type: 'turn_end', payload: {}, turnId: TURN1, ts: T(33, 5) },
];
const runningTurn = [
  ...doneTurn,
  { seq: 7, type: 'user', payload: { text: 'Run the whole suite before you commit.' }, turnId: TURN2, ts: T(40) },
  { seq: 8, type: 'assistant', payload: { text: 'Running the full suite now.' }, turnId: TURN2, ts: T(40, 15) },
  { seq: 9, type: 'tool_use', payload: { id: 'c2', name: 'Bash', input: { command: 'npm test', description: 'Run the full test suite' } }, turnId: TURN2, ts: T(40, 30) },
];
const sessionRoutes = ({ row = cursorSessionRow(), events = doneTurn, turns = [], runnerList = runnersProposal, keys = providersProposal } = {}) => () => ({
  ...infra(runnerList, keys)(),
  'GET /api/workspaces': [ws],
  [`GET /api/sessions/${SESSION.id}`]: row,
  'GET /api/sessions': [row],
  [`GET /api/sessions/${SESSION.id}/events/page`]: { events, hasMore: false },
  [`GET /api/sessions/${SESSION.id}/turns`]: turns,
});
const composerClip = async (page, { up = 0, down = 0, right = 0 } = {}) => {
  const box = await page.locator('.composer-box').first().boundingBox();
  return { x: box.x - 24, y: box.y - up, width: box.width + 48 + right, height: box.height + up + down + 18 };
};
const menuClip = async (page) => {
  const box = await page.locator('.composer-box').first().boundingBox();
  const menus = await page.locator('.composer-model-menu, [role="menu"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()).filter((r) => r.width > 0));
  const top = Math.min(box.y, ...menus.map((m) => m.y)) - 12;
  const left = Math.min(box.x, ...menus.map((m) => m.x)) - 12;
  const right = Math.max(box.x + box.width, ...menus.map((m) => m.x + m.width)) + 12;
  return { x: left, y: top, width: right - left, height: box.y + box.height - top + 14 };
};
const openModelMenu = async (page) => { await page.locator('.composer-model-chip').first().click(); await page.waitForTimeout(500); };

Object.assign(SCENES, {
  'w5-model-menu': {
    tree: 'proposal', path: SESSION_PATH, height: 900, routes: sessionRoutes(),
    act: openModelMenu, mouse: [5, 5], clip: menuClip,
    boxes: { title: '.composer-engine-title', auto: '.composer-model-menu .composer-route-note', chip: '.composer-model-chip', models: '.composer-model-menu [role="menuitem"]:has-text("Claude Opus 5.5")' },
  },
  'w5-model-variant': {
    tree: 'proposal', path: SESSION_PATH, height: 900,
    routes: sessionRoutes({ row: cursorSessionRow({ model: 'claude-opus-5-5', effort: 'high', fastMode: true, cursorContext: '1m' }) }),
    act: async (page) => { await openModelMenu(page); await page.locator('.composer-model-menu [role="menuitem"]:has-text("Context")').first().hover(); await page.waitForTimeout(600); },
    clip: menuClip,
    boxes: { chip: '.composer-model-chip', effort: '.composer-model-menu [role="menuitem"]:has-text("Effort")', context: '.composer-model-menu [role="menuitem"]:has-text("Context")', speed: '.composer-model-menu [role="menuitem"]:has-text("Speed")' },
  },
  'w5-running': {
    tree: 'proposal', path: SESSION_PATH, height: 900,
    routes: sessionRoutes({
      row: cursorSessionRow({ status: 'RUNNING', runState: 'RUNNING', engineTurnActive: true }), events: runningTurn,
      turns: [{ turnId: 'turnC3', kind: 'message', placement: 'queued', content: 'Also add a line about the fix to CHANGELOG.md', createdAt: T(41) }],
    }),
    clip: async (page) => {
      const tray = await page.locator('.pending-tray').first().boundingBox();
      const box = await page.locator('.composer-box').first().boundingBox();
      return { x: box.x - 24, y: tray.y - 16, width: box.width + 48, height: box.y + box.height - tray.y + 16 + 16 };
    },
    boxes: { tray: '.pending-tray', note: '.pending-tray-note', state: '.pending-tray-state', input: 'textarea', ring: '.composer-usage' },
  },
  'w5-context': {
    tree: 'proposal', path: SESSION_PATH, height: 900, routes: sessionRoutes(),
    act: async (page) => { await page.locator('.composer-usage').first().hover(); await page.waitForTimeout(700); },
    mouse: null,
    clip: async (page) => {
      const pop = await page.locator('.cu-pop').first().boundingBox();
      const box = await page.locator('.composer-box').first().boundingBox();
      const left = Math.min(pop.x, box.x + box.width - 520) - 12;
      return { x: left, y: pop.y - 50, width: box.x + box.width - left + 14, height: box.y + box.height - pop.y + 50 + 14 };
    },
    boxes: { pop: '.cu-pop', ring: '.composer-usage' },
  },
  'w5-context-now': {
    tree: 'today', path: SESSION_PATH, height: 900,
    routes: () => ({ ...infra(runners, providers)(), 'GET /api/workspaces': [{ ...ws, lastProvider: 'kimi', provider: 'kimi' }], [`GET /api/sessions/${SESSION.id}`]: { ...cursorSessionRow({ provider: 'kimi', engine: 'kimi', model: 'kimi-code/kimi-for-coding' }) }, 'GET /api/sessions': [cursorSessionRow({ provider: 'kimi', engine: 'kimi', model: 'kimi-code/kimi-for-coding' })], [`GET /api/sessions/${SESSION.id}/events/page`]: { events: doneTurn, hasMore: false } }),
    act: async (page) => { await page.locator('.composer-usage').first().hover(); await page.waitForTimeout(700); },
    mouse: null,
    clip: async (page) => {
      const pop = await page.locator('.cu-pop').first().boundingBox();
      const box = await page.locator('.composer-box').first().boundingBox();
      const left = Math.min(pop.x, box.x + box.width - 520) - 12;
      return { x: left, y: pop.y - 50, width: box.x + box.width - left + 14, height: box.y + box.height - pop.y + 50 + 14 };
    },
    boxes: { pop: '.cu-pop' },
  },
});

/* ── 5 (pane) · the whole session column, for context ──────────────────────────── */
const paneClip = async (page) => {
  const box = await page.locator('.composer-box').first().boundingBox();
  const vp = page.viewportSize();
  const x = box.x - 34;
  return { x, y: 0, width: vp.width - x, height: Math.min(vp.height, box.y + box.height + 18) };
};
Object.assign(SCENES, {
  'w5-running-pane': {
    tree: 'proposal', path: SESSION_PATH, height: 900, routes: SCENES['w5-running'].routes,
    clip: paneClip, boxes: SCENES['w5-running'].boxes,
  },
});

/* ── 6 · Permission modes on a Cursor session (D6 A and B) ─────────────────────── */
const openModes = async (page) => {
  await page.locator('.composer-pill').filter({ hasText: /Accept Edits|Default|Auto|Plan|Bypass|Don/ }).first().locator('button, [role="combobox"]').first().click();
  await page.waitForTimeout(600);
};
const modesClip = async (page) => {
  const list = await page.locator('[role="listbox"]').first().boundingBox();
  const box = await page.locator('.composer-box').first().boundingBox();
  const left = Math.min(list.x, box.x) - 12;
  const right = Math.max(list.x + list.width + 14, box.x + Math.min(box.width, 560));
  return { x: left, y: list.y - 12, width: right - left, height: box.y + box.height - list.y + 26 };
};
const modeBoxes = {
  def: '[role="option"]:has-text("Default")', plan: '[role="option"]:has-text("Plan")', accept: '[role="option"]:has-text("Accept Edits")',
  auto: '[role="option"]:has-text("Auto")', dont: '[role="option"]:has-text("Don")', bypass: '[role="option"]:has-text("Bypass")',
};
Object.assign(SCENES, {
  'w6-modes-a': { tree: 'proposal', path: SESSION_PATH, height: 900, routes: sessionRoutes(), act: openModes, clip: modesClip, boxes: modeBoxes },
  'w6-modes-b': { tree: 'proposal', path: SESSION_PATH, height: 900, routes: sessionRoutes(), init: { fn: () => { window.__ORBIT_D6__ = 'B'; } }, act: openModes, clip: modesClip, boxes: modeBoxes },
  'w6-modes-now': {
    tree: 'today', path: SESSION_PATH, height: 900,
    routes: () => ({ ...infra(runners, providers)(), 'GET /api/workspaces': [{ ...ws, lastProvider: 'dsh', provider: 'dsh' }], [`GET /api/sessions/${SESSION.id}`]: cursorSessionRow({ provider: 'deepseek', engine: 'dsh', model: 'deepseek-v4-pro', permissionMode: 'auto' }), 'GET /api/sessions': [cursorSessionRow({ provider: 'deepseek', engine: 'dsh', model: 'deepseek-v4-pro', permissionMode: 'auto' })], [`GET /api/sessions/${SESSION.id}/events/page`]: { events: doneTurn, hasMore: false } }),
    act: openModes, clip: modesClip, boxes: modeBoxes,
  },
});

/* ── 7 · Switching the account (D5) ─────────────────────────────────────────────── */
const openProvider = async (page) => {
  await openModelMenu(page);
  await page.locator('.composer-model-menu [role="menuitem"]:has-text("Provider")').first().hover();
  await page.waitForTimeout(700);
};
Object.assign(SCENES, {
  'w7-switch-blocked': { tree: 'proposal', path: SESSION_PATH, height: 900, routes: sessionRoutes(), act: openProvider, mouse: null, clip: menuClip,
    boxes: { foot: '.composer-provider-foot', team: '.composer-account-row:has-text("Team")' } },
  'w7-switch-open': { tree: 'proposal', path: SESSION_PATH, height: 900,
    routes: sessionRoutes({ runnerList: () => runnersProposal({ hpcCaps: ['cursor-account-move/v1'] }) }), act: openProvider, mouse: null, clip: menuClip,
    boxes: { team: '.composer-account-row:has-text("Team")' } },
  'w7-switch-draft': { tree: 'proposal', path: NEW, height: 900,
    routes: () => ({ ...newSession(runnersProposal, providersProposal)(), 'GET /api/workspaces': [ws] }),
    act: async (page) => { await openEngines(page); await page.locator('.np-row', { hasText: 'Cursor CLI' }).first().click(); await page.waitForTimeout(600); await openProvider(page); },
    mouse: null, clip: menuClip, boxes: { team: '.composer-account-row:has-text("Team")' } },
});

/* ── 5 · the quota error Cursor sends as text ("Upgrade your plan to continue") ── */
const quotaEvents = [
  ...doneTurn,
  { seq: 7, type: 'user', payload: { text: 'Add a regression test for the midnight case too.' }, turnId: TURN2, ts: T(44) },
  { seq: 8, type: 'error', payload: { message: 'You’ve hit your usage limit on Cursor (Default, Free plan). Cursor said: “Upgrade your plan to continue.” Try again at Oct 3rd, 2026 12:00 AM.' }, turnId: TURN2, ts: T(44, 2) },
  { seq: 9, type: 'turn_end', payload: {}, turnId: TURN2, ts: T(44, 3) },
];
Object.assign(SCENES, {
  'w5-quota': {
    tree: 'proposal', path: SESSION_PATH, height: 900,
    routes: sessionRoutes({ row: cursorSessionRow({ autoRetryAt: null }), events: quotaEvents }),
    clip: paneClip, boxes: { card: '.chat-quota' },
  },
});

/* today's tray for an engine that can't be steered either (Kimi Code), for comparison */
Object.assign(SCENES, {
  'w5-running-now': {
    tree: 'today', path: SESSION_PATH, height: 900,
    routes: () => ({
      ...infra(runners, providers)(), 'GET /api/workspaces': [{ ...ws, lastProvider: 'kimi', provider: 'kimi' }],
      [`GET /api/sessions/${SESSION.id}`]: cursorSessionRow({ provider: 'kimi', engine: 'kimi', model: 'kimi-code/kimi-for-coding', status: 'RUNNING', runState: 'RUNNING', engineTurnActive: true }),
      'GET /api/sessions': [cursorSessionRow({ provider: 'kimi', engine: 'kimi', model: 'kimi-code/kimi-for-coding', status: 'RUNNING', runState: 'RUNNING', engineTurnActive: true })],
      [`GET /api/sessions/${SESSION.id}/events/page`]: { events: runningTurn, hasMore: false },
      [`GET /api/sessions/${SESSION.id}/turns`]: [{ turnId: 'turnC3', kind: 'message', placement: 'queued', content: 'Also add a line about the fix to CHANGELOG.md', createdAt: T(41) }],
    }),
    clip: async (page) => {
      const tray = await page.locator('.pending-tray').first().boundingBox();
      const box = await page.locator('.composer-box').first().boundingBox();
      return { x: box.x - 24, y: tray.y - 16, width: box.width + 48, height: box.y + box.height - tray.y + 16 + 16 };
    },
    boxes: { tray: '.pending-tray' },
  },
});
