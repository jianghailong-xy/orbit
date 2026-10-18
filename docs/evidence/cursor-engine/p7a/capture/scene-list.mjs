// The P7a scenes: every "after" frame of the owner's board (docs/mocks/cursor-engine, shots/), captured
// from the implementation, under the board's own names so each pairs with the frame it is checked
// against. Selectors follow the board's capture kit (docs/mocks/cursor-engine/capture/scene-list.mjs).
import {
  IDS, NOW, ago, runners, baseKeys, keys, workspaces, cursorHealth, cursorUsage, cursorKey, CURSOR_TEAM,
} from './data.mjs';
import { SESSION, SESSION_PATH, WORKSPACE } from '/root/.orbit/worktrees/50304226-c921-5ee2-89b9-8ddbb5247705/src/web/ui-migration/session-fixtures.mjs';

/** localStorage the Infrastructure page keeps its folds in: which machine cards and account groups are open. */
const folds = (runnersOpen = [], groupsOpen = []) => ({
  fn: ({ r, g }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(r));
    localStorage.setItem('orbit:providers-open-accounts', JSON.stringify(g));
  },
  arg: { r: runnersOpen, g: groupsOpen },
});

const balance = { ok: true, balances: [{ currency: 'CNY', totalBalance: '110.00', grantedBalance: '0.00', toppedUpBalance: '110.00' }], isAvailable: true, fetchedAt: ago(2), sharedWith: [] };

const infra = (runnerList = () => runners(), keyList = () => keys()) => () => ({
  'GET /api/runners': runnerList(),
  'GET /api/providers/mine': keyList(),
  'GET /api/providers': keyList(),
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

/** The hpc card alone, with only its Cursor CLI report (and anything else named) changed. */
const hpcWith = (cursor, extra = {}) => () => {
  const [hpc] = runners({ cursor });
  return [{ ...hpc, ...extra }];
};
const signedOut = () => cursorHealth({ auth: 'no', accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'no' }] });

export const SCENES = {
  /* ── 2 · Infrastructure ─────────────────────────────────────────────── */
  'w2-overview-new': {
    path: '/infrastructure', routes: infra(),
    clip: around('.infra-engines', { up: '.re-sec', pad: 2 }),
    boxes: { card: '.infra-engine >> nth=6' },
  },
  'w2-machine-folded': {
    path: '/infrastructure', routes: infra(), init: folds([IDS.hpc]), height: 1400,
    clip: around('.re-runner-card', { pad: 1 }),
    boxes: { row: '[data-engine="cursor"]', add: '[data-engine="cursor"] .re-add-account', quota: '[data-engine="cursor"] .re-quota', meta: '[data-engine="cursor"] .re-meta' },
  },
  'w2-machine-open': {
    path: '/infrastructure', routes: infra(), init: folds([IDS.hpc], [`${IDS.hpc}/cursor`]), height: 1500,
    clip: around('[data-engine="cursor"]', { to: '.re-acct', pad: 0 }),
    boxes: { head: '[data-engine="cursor"]', defQuota: '.re-acct >> nth=0 >> .re-quota', teamQuota: '.re-acct >> nth=1 >> .re-quota' },
  },
  'w2-attention': {
    path: '/infrastructure', routes: infra(hpcWith(signedOut())),
    clip: around('.infra-attn', { pad: 1 }),
    boxes: { line: '.infra-attn-row' },
  },
  'w2-state-signed-out': {
    path: '/infrastructure', init: folds([IDS.hpc]), height: 1400, routes: infra(hpcWith(signedOut())),
    clip: around('[data-engine="cursor"]'),
  },
  'w2-state-not-installed': {
    path: '/infrastructure', init: folds([IDS.box]), height: 1400, routes: infra(() => [runners()[2]]),
    clip: around('[data-engine="cursor"]'),
  },
  'w2-state-update-runner': {
    // mac-studio predates Cursor CLI; hpc beside it is what makes the account's pages draw it at all.
    path: '/infrastructure', init: folds([IDS.mac]), height: 1400, routes: infra(() => runners()),
    clip: around(`[data-engine="cursor"]`),
    pick: 'mac',
  },
  'w2-state-wrong-version': {
    path: '/infrastructure', init: folds([IDS.hpc]), height: 1400,
    routes: infra(hpcWith(cursorHealth({
      version: '2026.10.16-e3cb207', auth: 'unknown',
      installationError: 'CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e',
      accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'unknown' }],
    }), { capabilities: ['provider:dsh', 'cursor-account-login/v1', 'cursor-account-remove/v1'] })),
    clip: around('[data-engine="cursor"]'),
  },
};

/* ── 3 · Add account, Re-sign in, Remove (Cursor rows on hpc) ───────── */
const LOGIN_URL = 'https://cursor.com/loginDeepControl?challenge=Hk3v9QxP2mWcT8sLr0aYbN6dEfJ4uZgKq1oVhI7nM5w&uuid=6f0c2a4e-81d3-4b9e-a7f2-3c5d9e1b0a47&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true';
const loginState = (status, over = {}) => ({ status, engine: 'cursor', url: null, userCode: null, message: null, account: null, ...over });
const linkState = (over = {}) => loginState('awaiting_approval', { url: LOGIN_URL, expiresAt: new Date(NOW + 26 * 60_000).toISOString(), ...over });
const hpcOpen = { init: folds([IDS.hpc], [`${IDS.hpc}/cursor`]), height: 1700 };
const signInRoutes = (post, get, extra = {}) => () => ({
  ...infra()(),
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

Object.assign(SCENES, {
  'w3-add-pending': { path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending'), loginState('pending')), act: addAccount, clip: cursorPanel, boxes: { name: '[data-engine="cursor"] .re-add', panel: '[data-engine="cursor"] .re-panel' } },
  'w3-add-link': { path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending'), linkState()), act: addAccount, clip: cursorPanel, boxes: { open: '[data-engine="cursor"] .rsi-open', expiry: '[data-engine="cursor"] .rsi-row' } },
  'w3-add-expired': { path: '/infrastructure', ...hpcOpen, routes: signInRoutes(linkState(), loginState('failed', { message: 'The sign-in link expired before anyone signed in with it.', reason: 'expired' })), act: addAccount, clip: cursorPanel, boxes: { warn: '[data-engine="cursor"] .rsi-warn', btn: '[data-engine="cursor"] .rsi-btn' } },
  'w3-add-done': { path: '/infrastructure', ...hpcOpen, routes: signInRoutes(linkState(), loginState('done')), act: addAccount, clip: cursorPanel, boxes: { panel: '[data-engine="cursor"] .re-panel' } },
  'w3-resign-menu': {
    path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending'), loginState(null, { engine: null })),
    act: async (page) => { await page.locator('.re-acct >> nth=1 >> button[aria-label="More actions"]').click(); await page.waitForTimeout(500); },
    mouse: [0, 0],
    clip: async (page) => {
      const row = await page.locator('.re-acct >> nth=1').boundingBox();
      const menu = await page.locator('.re-account-menu').first().boundingBox();
      const top = Math.min(row.y, menu.y) - 8; const bottom = Math.max(row.y + row.height, menu.y + menu.height) + 8;
      return { x: row.x, y: top, width: row.width, height: bottom - top };
    },
    boxes: { resign: 'text=Re-sign in', remove: 'text=Remove account' },
  },
  'w3-resign-link': {
    path: '/infrastructure', ...hpcOpen, routes: signInRoutes(loginState('pending', { account: CURSOR_TEAM }), linkState({ account: CURSOR_TEAM })),
    act: async (page) => {
      await page.locator('.re-acct >> nth=1 >> button[aria-label="More actions"]').click(); await page.waitForTimeout(400);
      await page.locator('text=Re-sign in').click(); await page.waitForTimeout(3200);
    },
    clip: async (page) => page.locator('.re-acct').nth(1).boundingBox(),
    boxes: { open: '.re-acct >> nth=1 >> .rsi-open', expiry: '.re-acct >> nth=1 >> .rsi-row' },
  },
  'w3-remove-confirm': {
    path: '/infrastructure', ...hpcOpen, width: 1440, routes: infra(),
    act: async (page) => {
      await page.locator('.re-acct >> nth=1 >> button[aria-label="More actions"]').click(); await page.waitForTimeout(400);
      await page.locator('text=Remove account').click(); await page.waitForTimeout(600);
    },
    mouse: [0, 0],
    clip: async (page) => {
      const head = await page.locator('[data-engine="cursor"]').first().boundingBox();
      const row = await page.locator('.re-acct >> nth=1').boundingBox();
      const pop = await page.locator('[role="alertdialog"], [role="dialog"]').last().boundingBox();
      const top = Math.min(head.y, pop.y) - 8; const bottom = Math.max(row.y + row.height, pop.y + pop.height) + 8;
      const left = Math.min(row.x, pop.x - 8); const right = Math.max(row.x + row.width, pop.x + pop.width + 8);
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
    boxes: { pop: '[role="alertdialog"], [role="dialog"]' },
  },
  'w3-remove-refused': {
    path: '/infrastructure', ...hpcOpen,
    routes: infra(() => { const r = runners(); r[0] = { ...r[0], accountRemove: { engine: 'cursor', account: CURSOR_TEAM, status: 'failed', message: 'Team is in use: 2 sessions on hpc are running on it. Remove it once they finish.' } }; return r; }),
    clip: async (page) => page.locator('.re-acct').nth(1).boundingBox(),
    boxes: { panel: '.re-acct >> nth=1 >> .re-panel' },
  },
});

/* ── 1 · New session: the engine list ──────────────────────────────── */
const NEW = `/workspaces/${IDS.ws}/new`;
const newSession = (runnerList, keyList) => () => ({ ...infra(runnerList, keyList)(), 'GET /api/sessions': [] });
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
/** hpc alone, but with an older runner beside it that does know Cursor CLI — so the account draws it. */
const hpcOnly = (cursor, caps) => () => {
  const [hpc, , box] = runners({ cursor });
  return [{ ...hpc, ...(caps ? { capabilities: caps } : {}) }, box];
};
const noCursorKey = () => baseKeys();

Object.assign(SCENES, {
  'w1-engines-new': { path: NEW, routes: newSession(), act: openEngines, clip: heroClip, boxes: { list: '.np-list', cursor: '.np-row:has-text("Cursor CLI")' } },
  'w1-row-not-installed': { path: NEW, routes: newSession(hpcOnly({ engine: 'cursor', installed: false, auth: 'unknown', installationError: 'CURSOR_NOT_INSTALLED: …' }, ['provider:dsh'])), act: openEngines, clip: cursorRowClip },
  'w1-row-signed-out': { path: NEW, routes: newSession(hpcOnly(signedOut()), noCursorKey), act: openEngines, clip: cursorRowClip },
  'w1-row-update-runner': { path: NEW, routes: newSession(hpcOnly(null, ['provider:dsh'])), act: openEngines, clip: cursorRowClip },
  'w1-row-version': { path: NEW, routes: newSession(hpcOnly(cursorHealth({ version: '2026.10.16-e3cb207', installationError: 'CURSOR_VERSION_INCOMPATIBLE: …' }), ['provider:dsh'])), act: openEngines, clip: cursorRowClip },
});

/* ── 4 · API keys: the gallery, the connect form, a key Cursor refused ─────── */
const galleryClip = around('.provider-gallery', { pad: 2 });
const connect = (testAnswer) => () => ({
  ...infra(() => runners(), () => baseKeys())(),
  'POST /api/providers/test': testAnswer,
});
const typeKey = async (page) => {
  await page.locator('input[type="password"], input[autocomplete="new-password"]').first().fill('key_8f3a0c2e9b7d41f6a5e0c3b2d1f4e6a8');
  await page.waitForTimeout(200);
};
const pressConnect = async (page) => { await typeKey(page); await page.getByRole('button', { name: 'Connect', exact: true }).click(); await page.waitForTimeout(900); };
const formClip = around('.provider-form', { pad: 0 });

Object.assign(SCENES, {
  'w4-gallery-new': { path: '/infrastructure', routes: infra(() => runners(), () => baseKeys()), clip: galleryClip, grow: '.provider-gallery', boxes: { card: '.provider-card:has-text("Cursor")' } },
  'w4-keys-new': {
    path: '/infrastructure', height: 1300, grow: '.provider-keys',
    routes: infra(() => runners(), () => keys([cursorKey({ id: IDS.keyCursor2, slug: 'cursor-api-2', label: 'Cursor 2', lastUsedAt: null, keyCheckState: 'INVALID', keyCheckedAt: ago(4) })])),
    clip: async (page) => page.evaluate(() => {
      const rows = [...document.querySelectorAll('.provider-keys tr')];
      const grp = rows.find((r) => /^\s*Cursor/.test(r.textContent ?? '') && r.className.includes('grp')) ?? rows.find((r) => (r.textContent ?? '').includes('Cursor'));
      const table = document.querySelector('.provider-keys').getBoundingClientRect();
      const g = grp.getBoundingClientRect();
      const last = rows[rows.length - 1].getBoundingClientRect();
      return { x: table.left, y: g.top, width: table.width, height: last.bottom - g.top + 2 };
    }),
    boxes: { bad: '.dsb-line.fail >> nth=-1' },
  },
  'w4-connect': { path: '/providers/new/cursor-api', routes: connect({ ok: true, keyCheck: 'VALID', message: 'Cursor accepted this key.' }), height: 1100, act: typeKey, clip: formClip, grow: '.provider-actions', boxes: { idbar: '.provider-idbar', works: '.provider-works', who: '.provider-who' } },
  'w4-connect-invalid': {
    path: '/providers/new/cursor-api', height: 1100, grow: '.provider-actions',
    routes: connect({ ok: false, keyCheck: 'INVALID', message: 'Cursor rejected this key: “The provided API key is invalid.” Check it on cursor.com and paste it again.' }),
    act: pressConnect, clip: around('.provider-actions', { pad: 6 }), boxes: { err: '.provider-actions-start' },
  },
  'w4-connect-unreachable': {
    path: '/providers/new/cursor-api', height: 1100, grow: '.provider-actions',
    routes: connect({ ok: false, keyCheck: 'UNREACHABLE', message: 'Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine.' }),
    act: pressConnect, clip: around('.provider-actions', { pad: 6 }), boxes: { err: '.provider-actions-start' },
  },
});

/* ── 5 · A Cursor session: model and effort, a message sent mid-turn, context, the quota card ──── */
const T = (m, s = 0) => `2026-09-28T11:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`;
const TURN1 = 'turnC1', TURN2 = 'turnC2';
const ws = { ...WORKSPACE, name: 'orbit', runnerId: IDS.hpc, lastProvider: 'cursor', lastEngine: 'cursor', provider: 'cursor' };
/** A Cursor CLI session on hpc's Default account that has talked (a settled turn, a Cursor conversation). */
export const cursorSessionRow = (over = {}) => ({
  ...SESSION, workspace: ws, workspaceId: ws.id, runnerId: IDS.hpc, assignedRunnerId: IDS.hpc,
  provider: 'cursor', engine: 'cursor', model: 'default', effort: null, fastMode: false, permissionMode: 'acceptEdits',
  title: 'Fix the flaky export test', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  numTurns: 1, runtimeSessionId: '7f3b0c1e-2d4a-4e5f-9a8b-0c1d2e3f4a5b',
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
const sessionRoutes = ({ row = cursorSessionRow(), events = doneTurn, turns = [], runnerList = () => runners(), keyList = () => keys() } = {}) => () => ({
  ...infra(runnerList, keyList)(),
  'GET /api/workspaces': [ws],
  [`GET /api/sessions/${SESSION.id}`]: row,
  'GET /api/sessions': [row],
  [`GET /api/sessions/${SESSION.id}/events/page`]: { events, hasMore: false },
  [`GET /api/sessions/${SESSION.id}/turns`]: turns,
});
const menuClip = async (page) => {
  const box = await page.locator('.composer-box').first().boundingBox();
  const menus = await page.locator('.composer-model-menu, [role="menu"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()).filter((r) => r.width > 0));
  const top = Math.min(box.y, ...menus.map((m) => m.y)) - 12;
  const left = Math.min(box.x, ...menus.map((m) => m.x)) - 12;
  const right = Math.max(box.x + box.width, ...menus.map((m) => m.x + m.width)) + 12;
  return { x: left, y: top, width: right - left, height: box.y + box.height - top + 14 };
};
const openModelMenu = async (page) => { await page.locator('.composer-model-chip').first().click(); await page.waitForTimeout(500); };
const trayClip = async (page) => {
  const tray = await page.locator('.pending-tray').first().boundingBox();
  const box = await page.locator('.composer-box').first().boundingBox();
  return { x: box.x - 24, y: tray.y - 16, width: box.width + 48, height: box.y + box.height - tray.y + 16 + 16 };
};
const paneClip = async (page) => {
  const box = await page.locator('.composer-box').first().boundingBox();
  const vp = page.viewportSize();
  const x = box.x - 34;
  return { x, y: 0, width: vp.width - x, height: Math.min(vp.height, box.y + box.height + 18) };
};
const contextClip = async (page) => {
  const pop = await page.locator('.cu-pop').first().boundingBox();
  const box = await page.locator('.composer-box').first().boundingBox();
  const left = Math.min(pop.x, box.x + box.width - 520) - 12;
  return { x: left, y: pop.y - 50, width: box.x + box.width - left + 14, height: box.y + box.height - pop.y + 50 + 14 };
};
const running = sessionRoutes({
  row: cursorSessionRow({ status: 'RUNNING', runState: 'RUNNING', engineTurnActive: true, numTurns: 1 }), events: runningTurn,
  turns: [{ turnId: 'turnC3', kind: 'message', placement: 'queued', content: 'Also add a line about the fix to CHANGELOG.md', createdAt: T(41) }],
});
// What the runner reports for a turn Cursor ended on the account's usage limit (cursorUsageLimitText).
const quotaEvents = [
  ...doneTurn,
  { seq: 7, type: 'user', payload: { text: 'Add a regression test for the midnight case too.' }, turnId: TURN2, ts: T(44) },
  { seq: 8, type: 'error', payload: { message: 'You\'ve hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue."' }, turnId: TURN2, ts: T(44, 2) },
  { seq: 9, type: 'turn_end', payload: {}, turnId: TURN2, ts: T(44, 3) },
];

Object.assign(SCENES, {
  'w5-model-menu': {
    path: SESSION_PATH, height: 900, routes: sessionRoutes(), act: openModelMenu, mouse: [5, 5], clip: menuClip,
    boxes: { title: '.composer-engine-title', auto: '.composer-model-menu .composer-route-note', chip: '.composer-model-chip' },
  },
  'w5-model-variant': {
    path: SESSION_PATH, height: 900, routes: sessionRoutes({ row: cursorSessionRow({ model: 'claude-opus-5-5', effort: 'high' }) }),
    act: async (page) => { await openModelMenu(page); await page.locator('.composer-model-menu [role="menuitem"]:has-text("Effort")').first().hover(); await page.waitForTimeout(600); },
    clip: menuClip,
    boxes: { chip: '.composer-model-chip', effort: '.composer-model-menu [role="menuitem"]:has-text("Effort")' },
  },
  'w5-running': { path: SESSION_PATH, height: 900, routes: running, clip: trayClip, boxes: { note: '.pending-tray-note', input: 'textarea' } },
  'w5-running-pane': { path: SESSION_PATH, height: 900, routes: running, clip: paneClip },
  'w5-context': {
    path: SESSION_PATH, height: 900, routes: sessionRoutes(),
    act: async (page) => { await page.locator('.composer-usage').first().hover(); await page.waitForTimeout(700); },
    mouse: null, clip: contextClip, boxes: { pop: '.cu-pop', ring: '.composer-usage' },
  },
  'w5-quota': {
    path: SESSION_PATH, height: 900,
    routes: sessionRoutes({ row: cursorSessionRow({ numTurns: 2, retryAt: null, retryAttempts: 0 }), events: quotaEvents, runnerList: () => runners({ usage: cursorUsage({ defaultSpent: true }) }) }),
    clip: paneClip, boxes: { card: '.chat-quota' },
  },
});

/* ── 6 · Permission modes (D6 A) and switching the account (D5) ─────────────────── */
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
const openProvider = async (page) => {
  await openModelMenu(page);
  await page.locator('.composer-model-menu [role="menuitem"]:has-text("Provider")').first().hover();
  await page.waitForTimeout(700);
};
Object.assign(SCENES, {
  'w6-modes-a': {
    path: SESSION_PATH, height: 900, routes: sessionRoutes(), act: openModes, clip: modesClip,
    boxes: { def: '[role="option"]:has-text("Default")', plan: '[role="option"]:has-text("Plan")', dont: '[role="option"]:has-text("Don")' },
  },
  'w7-switch-blocked': {
    path: SESSION_PATH, height: 900, routes: sessionRoutes(), act: openProvider, mouse: null, clip: menuClip,
    boxes: { foot: '.composer-provider-foot', team: '.composer-account-row:has-text("Team")' },
  },
  'w7-switch-open': {
    path: SESSION_PATH, height: 900, routes: sessionRoutes({ runnerList: () => runners({ hpcCaps: ['cursor-account-move/v1'] }) }),
    act: openProvider, mouse: null, clip: menuClip, boxes: { team: '.composer-account-row:has-text("Team")' },
  },
  'w7-switch-draft': {
    path: NEW, height: 900, routes: () => ({ ...newSession()(), 'GET /api/workspaces': [ws] }),
    act: async (page) => { await openEngines(page); await page.locator('.np-row', { hasText: 'Cursor CLI' }).first().click(); await page.waitForTimeout(600); await openProvider(page); },
    mouse: null, clip: menuClip, boxes: { team: '.composer-account-row:has-text("Team")' },
  },
});
