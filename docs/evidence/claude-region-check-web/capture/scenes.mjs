// Real-page scenes for the Claude region check's web task, after board 02's own capture kit
// (docs/mocks/claude-region-check/capture/scenes.mjs) — with the verdict on runner.region and no
// injected DOM: every frame is what the tree under test draws.
import { IDS, infraRoutes, runners as fleet, providers as sampleKeys } from './data.mjs';
import { SESSION, WORKSPACE, SESSION_PATH } from '/root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f/src/web/ui-migration/session-fixtures.mjs';

/** Checked two minutes before the fixtures' frozen clock (2026-09-28T12:00Z): 19:58 in Asia/Shanghai. */
export const REGION = { verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false, checkedAt: '2026-09-28T11:58:00.000Z' };
const ALLOWED = { verdict: 'allowed', country: 'SG', regionCode: null, name: 'Singapore', viaProxy: true, checkedAt: '2026-09-28T11:58:00.000Z' };
const REFUSAL = 'CLAUDE_REGION_UNSUPPORTED: HPC’s connection to Anthropic is in mainland China, where Anthropic doesn’t offer Claude.';

/** The fleet with HPC declaring the check and reading `region` (undefined: an older server's payload). */
const fleetWith = (region) => () => fleet().map((r) => (r.name === 'HPC'
  ? { ...r, capabilities: [...(r.capabilities ?? []), 'claude-region/v1'], ...(region === undefined ? {} : { region }) }
  : r));

const folds = (runnersOpen = [], groupsOpen = []) => ({
  fn: ({ r, g }) => {
    localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify(r));
    localStorage.setItem('orbit:providers-open-accounts', JSON.stringify(g));
  },
  arg: { r: runnersOpen, g: groupsOpen },
});
const card = (name, pad = 14) => async (page) => page.evaluate(({ name, pad }) => {
  const c = [...document.querySelectorAll('.re-runner-card')].find((el) => el.querySelector('.re-runner')?.textContent === name);
  if (!c) throw new Error('no card ' + name);
  const r = c.getBoundingClientRect();
  return { x: Math.max(0, r.left - pad), y: Math.max(0, r.top - pad), width: r.width + 2 * pad, height: r.height + 2 * pad };
}, { name, pad });
const machine = (runnerList, open = []) => ({
  path: '/infrastructure', routes: infraRoutes({ runnerList }), width: 1280, height: 1400, init: folds([IDS.hpc], open), clip: card('HPC'),
});

export const SCENES = {
  // Board 02 A, today: what a runner that reads no region draws — on the base tree and on this one.
  'mm-today': machine(fleetWith(undefined)),
  'mm-null': machine(fleetWith(null)),
  'mm-allowed': machine(fleetWith(ALLOWED)),
  // Board 02 A, final: HPC's Claude connection in mainland China.
  'mm-new': machine(fleetWith(REGION)),
  // The same card with Claude Code's accounts opened under its row.
  'mm-new-open': machine(fleetWith(REGION), [`${IDS.hpc}/claude`]),
};

/* ── the session page: a Claude session on HPC whose next turn the runner refused, held by the server ── */
/** 'absent': a payload with no region field at all, as an older server sends. */
const hpcAsSessionRunner = (region) => {
  const hpc = fleet().find((r) => r.name === 'HPC');
  return { ...hpc, id: WORKSPACE.runnerId, capabilities: [...(hpc.capabilities ?? []), 'claude-region/v1'], ...(region === 'absent' ? {} : { region }) };
};
const T1 = 'turn-0001', T2 = 'turn-0002';
const priorTurn = [
  { seq: 1, type: 'user', payload: { text: 'The login test fails about one run in five. Find out why and fix it.' }, turnId: T1, ts: '2026-09-28T11:20:00.000Z' },
  { seq: 2, type: 'assistant', payload: { text: 'The test waits a fixed **500 ms** for the session cookie, and the token refresh sometimes takes longer under load.\n\nI replaced the sleep with a wait on the cookie itself, and the test passed 50 runs in a row.' }, turnId: T1, ts: '2026-09-28T11:24:00.000Z' },
  { seq: 3, type: 'turn_end', payload: { subtype: 'success' }, turnId: T1, ts: '2026-09-28T11:24:00.000Z' },
];
const nextMessage = (seq) => [
  { seq, type: 'user', payload: { text: 'Now do the same for the sign-up test.' }, turnId: T2, ts: '2026-09-28T11:59:00.000Z' },
  // The runner's own error event for the refusal: the page draws no line for it (the card says it).
  { seq: seq + 1, type: 'error', payload: { message: REFUSAL }, turnId: T2, ts: '2026-09-28T11:59:01.000Z' },
];
const held = (over = {}) => ({
  ...SESSION, workspace: { ...WORKSPACE, name: 'orbit-develop' }, title: 'Fix the flaky login test', status: 'QUEUED', runState: 'QUEUED',
  engineStartedAt: null, numTurns: 1, error: REFUSAL,
  updatedAt: '2026-09-28T11:59:01.000Z', lastTurnAt: '2026-09-28T11:24:00.000Z', ...over,
});
const sessionRoutes = (session, events, region = REGION) => () => ({
  'GET /api/runners': [hpcAsSessionRunner(region)],
  'GET /api/workspaces': [{ ...WORKSPACE, name: 'orbit-develop', runner: { id: WORKSPACE.runnerId, name: 'HPC', displayName: 'HPC' } }],
  'GET /api/sessions': [session],
  'GET /api/providers': sampleKeys(),
  'GET /api/providers/mine': sampleKeys(),
  [`GET /api${SESSION_PATH}`]: session,
  [`GET /api${SESSION_PATH}/events/page`]: { events, hasMore: false },
});
const page = () => ({ x: 0, y: 0, width: 1280, height: 900 });

// Board 02 B: the next message of a conversation that has talked, held.
SCENES['s-B'] = { path: SESSION_PATH, routes: sessionRoutes(held(), [...priorTurn, ...nextMessage(4)]), width: 1280, height: 900, clip: page };
// Board 02 B, right: a new session's first message, held.
SCENES['s-A'] = {
  path: SESSION_PATH, routes: sessionRoutes(held({ title: 'Fix the flaky sign-up test', numTurns: 0 }), nextMessage(1)),
  width: 1280, height: 900, clip: page,
};
// Board 02 C, left: a new session on HPC, where the workspace last ran on Claude Code's own sign-in.
SCENES['hero-new'] = {
  path: SESSION_PATH, routes: sessionRoutes(held(), [...priorTurn, ...nextMessage(4)]), width: 1280, height: 900,
  act: async (p) => { await p.locator('.session-new').first().click(); await p.waitForTimeout(1200); },
  clip: page,
};
// …and its engine list opened: Claude Code stays pickable, on a key Anthropic isn't behind.
SCENES['hero-new-open'] = {
  ...SCENES['hero-new'],
  act: async (p) => { await SCENES['hero-new'].act(p); await p.locator('.np-card').first().click(); await p.waitForTimeout(700); },
};
// Board 02 C, right: the card's Use another provider opens the composer's Provider menu.
SCENES['prov-new'] = {
  path: SESSION_PATH, routes: sessionRoutes(held(), [...priorTurn, ...nextMessage(4)]), width: 1280, height: 900,
  act: async (p) => {
    await p.locator('.chat-authfix button', { hasText: 'Use another provider' }).click();
    await p.waitForTimeout(900);
  },
  keepMouse: true,
  clip: page,
};
// A stopped turn (decision ④): no card; the stopped sentence, without its code, under the turn.
const STOPPED = 'CLAUDE_REGION_UNSUPPORTED: Claude Code stopped on HPC: its connection to Anthropic is now in mainland China, where Anthropic doesn’t offer Claude.';
SCENES['s-stopped'] = {
  path: SESSION_PATH,
  routes: sessionRoutes(held({ status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', error: STOPPED, numTurns: 2, engineStartedAt: '2026-09-28T11:59:02.000Z', lastTurnAt: '2026-09-28T11:59:40.000Z' }), [
    ...priorTurn,
    { seq: 4, type: 'user', payload: { text: 'Now do the same for the sign-up test.' }, turnId: T2, ts: '2026-09-28T11:59:00.000Z' },
    { seq: 5, type: 'assistant', payload: { text: 'Looking at the sign-up test now.' }, turnId: T2, ts: '2026-09-28T11:59:20.000Z' },
    { seq: 6, type: 'error', payload: { message: STOPPED }, turnId: T2, ts: '2026-09-28T11:59:40.000Z' },
    { seq: 7, type: 'turn_end', payload: { subtype: 'region_stopped' }, turnId: T2, ts: '2026-09-28T11:59:40.000Z' },
  ]),
  width: 1280, height: 900, clip: page,
};

/* ── a runner that reads no region (null, or a payload from an older server): every surface as today ── */
const queued = held({ error: null, title: 'Fix the flaky login test' });
const openProviderLevel = async (p) => {
  await p.locator('button.composer-model-chip').click();
  await p.waitForTimeout(600);
  await p.locator('[role="menuitem"]').filter({ hasText: /Provider/ }).first().hover();
  await p.waitForTimeout(700);
};
for (const [suffix, region] of [['today', 'absent'], ['null', null]]) {
  SCENES[`s-queued-${suffix}`] = {
    path: SESSION_PATH, routes: sessionRoutes(queued, [...priorTurn, nextMessage(4)[0]], region), width: 1280, height: 900, clip: page,
  };
  SCENES[`hero-${suffix}`] = {
    path: SESSION_PATH, routes: sessionRoutes(queued, [...priorTurn, nextMessage(4)[0]], region), width: 1280, height: 900,
    act: async (p) => { await p.locator('.session-new').first().click(); await p.waitForTimeout(1200); }, clip: page,
  };
  SCENES[`prov-${suffix}`] = {
    path: SESSION_PATH, routes: sessionRoutes(queued, [...priorTurn, nextMessage(4)[0]], region), width: 1280, height: 900,
    act: openProviderLevel, keepMouse: true, clip: page,
  };
}
