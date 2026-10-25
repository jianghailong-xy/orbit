// T2 evidence: the coordinator conversation on this worktree's real web app (its own vite dev
// server + the repo's ui-migration REST fixtures, a coordinator session and pending read layered
// over them), in three states — queued, opened (after Decide it myself), sent — light and dark.
// usage: unshare -n ./run-ns.sh capture.mjs <outDir> [state-theme ...]
import fs from 'node:fs';

const W = '/root/.orbit/worktrees/57f90b1f-7a0a-5f57-bf91-d3483f1f4637';
const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH } = await import(`${W}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${W}/src/shared/dist/index.js`);

const BASE = 'http://127.0.0.1:5761';
const OUT = process.argv[2];
const ONLY = process.argv.slice(3);
if (!OUT) throw new Error('usage: capture.mjs <outDir> [state-theme ...]');
fs.mkdirSync(OUT, { recursive: true });

// The fixtures freeze the clock at 2026-09-28T12:00Z, 20:00 in Shanghai. The coordinator hit
// Claude's weekly limit at 18:08; a task submitted evidence at 19:41; in the third state the
// coordinator is back and the version was handed to it at 19:58.
const PROJECT_ID = FIXTURE_IDS.project;
const PROJECT_TITLE = 'Orbit UI migration';
const TASK_ID = uuidToBase62('0196e000-0000-7000-8000-000000000113');
const TASK_TITLE = 'Migrate shared controls';
const SUBMITTED_AT = '2026-09-28T11:41:30.000Z';
const DELIVERED_AT = '2026-09-28T11:58:00.000Z';
const WEEKLY = "You've hit your weekly limit · resets Oct 1, 7pm (Asia/Shanghai)";
const RESETS_AT = '2026-10-01T11:00:00.000Z';

const ROW = {
  taskId: TASK_ID,
  title: TASK_TITLE,
  status: 'IN_PROGRESS',
  projectId: PROJECT_ID,
  ownerCard: null,
  criterion: { key: 'visual-baseline', text: 'Representative browser scenes can be reproduced.' },
  evidenceRevision: '1',
  submittedAt: SUBMITTED_AT,
  ageSeconds: Math.round((Date.parse(FIXED_NOW) - Date.parse(SUBMITTED_AT)) / 1000),
  claim: 'Buttons, switches and selects use the owned components now; the light and dark baselines match.',
  gaps: [
    'The phone layout was compared at 390 px only.',
    'Keyboard focus was checked in Chromium, not in WebKit.',
  ],
  citations: [
    { kind: 'TOOL_CALL', ref: 'bgj_5e0c2a9e41d7', resolved: true, reason: null, label: 'Bash · npm run test:ui-controls -w @orbit/web' },
  ],
  decidability: { decidable: true, refusal: null, requiredAction: null },
  independence: { independent: true, disqualification: null, requiredAction: null },
};

const coordinatorRow = {
  ...SESSION,
  title: PROJECT_TITLE,
  projectId: PROJECT_ID,
  projectTitle: PROJECT_TITLE,
  pendingApprovals: 0,
  engineTurnActive: false,
  createdAt: '2026-09-28T02:00:00.000Z',
};
const SESSIONS = {
  paused: {
    ...coordinatorRow,
    status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED',
    error: WEEKLY, retryAt: RESETS_AT, retryAttempts: 1,
    lastTurnAt: '2026-09-28T10:08:46.000Z', updatedAt: '2026-09-28T10:08:46.000Z',
  },
  back: {
    ...coordinatorRow,
    status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    error: null, retryAt: null, retryAttempts: 0,
    lastTurnAt: '2026-09-28T11:58:20.000Z', updatedAt: '2026-09-28T11:58:20.000Z',
  },
};

const delivery = (title, revision, extra = '') =>
  `[Project “${PROJECT_TITLE}” has evidence waiting for your judgment] Task “${title}” submitted `
  + `revision ${revision} of its completion evidence.${extra}`;
const PAUSED_EVENTS = [
  { seq: 1, type: 'user', payload: { text: delivery('Capture browser baselines', 2) }, turnId: 'turn-1', ts: '2026-09-28T10:08:44.000Z' },
  { seq: 2, type: 'assistant', payload: { text: WEEKLY }, turnId: 'turn-1', ts: '2026-09-28T10:08:46.000Z' },
  { seq: 3, type: 'turn_end', payload: { subtype: 'success' }, turnId: 'turn-1', ts: '2026-09-28T10:08:46.000Z' },
];
const BACK_EVENTS = [
  ...PAUSED_EVENTS,
  {
    seq: 4, type: 'user', turnId: 'turn-2', ts: DELIVERED_AT,
    payload: { text: delivery(TASK_TITLE, 1, ` This revision was submitted at ${SUBMITTED_AT} while you were unavailable. It waited for you; nobody has decided it yet.`) },
  },
  { seq: 5, type: 'assistant', payload: { text: 'Reading the evidence for “Migrate shared controls” against visual-baseline now.' }, turnId: 'turn-2', ts: '2026-09-28T11:58:20.000Z' },
  { seq: 6, type: 'turn_end', payload: { subtype: 'success' }, turnId: 'turn-2', ts: '2026-09-28T11:58:20.000Z' },
];

const queue = (over) => ({
  decidingSessionId: SESSION.id, count: 0, oldestAgeSeconds: null,
  pending: [], waitingOnYou: [], decided: [], waitingOnCoordinator: [], sentToCoordinator: [], ...over,
});
const STATES = {
  queued: { session: SESSIONS.paused, events: PAUSED_EVENTS, read: queue({ waitingOnCoordinator: [ROW] }) },
  opened: { session: SESSIONS.paused, events: PAUSED_EVENTS, read: queue({ waitingOnCoordinator: [ROW] }) },
  sent: {
    session: SESSIONS.back,
    events: BACK_EVENTS,
    read: queue({
      sentToCoordinator: [{ taskId: TASK_ID, title: TASK_TITLE, projectId: PROJECT_ID, evidenceRevision: '1', deliveredAt: DELIVERED_AT }],
    }),
  },
};

async function shoot(browser, state, theme) {
  const scene = STATES[state];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1120 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(180_000);
  page.setDefaultTimeout(90_000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await installFixedDate(page);
  const api = await installFixtures(page, { theme });
  // Registered after the fixtures, so these answer first; anything else falls through to them.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') return route.fallback();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (path === `/api${SESSION_PATH}`) return json(scene.session);
    if (path === '/api/sessions') return json([scene.session]);
    if (path === `/api${SESSION_PATH}/events/page`) return json({ events: scene.events, hasMore: false });
    if (path === '/api/tasks/evidence-decisions/pending') return json(scene.read);
    if (path === `/api/projects/${PROJECT_ID}/acceptance/criteria-decisions/pending`) {
      return json({ readAt: FIXED_NOW, projectId: PROJECT_ID, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] });
    }
    if (path === `/api/projects/${PROJECT_ID}/promotions/merged`) return json([]);
    if (path === '/api/auth/capabilities') return json({});
    if (path === `/api/projects/${PROJECT_ID}/acceptance/confirmation`) {
      return json({ state: 'CONFIRMED', confirmed: true, currentVersion: { digest: 'seal', material: [] }, confirmation: null });
    }
    return route.fallback();
  });
  await page.goto(BASE + SESSION_PATH);
  const anchor = state === 'sent' ? '[data-sent-row]' : '[data-queued-row]';
  await page.locator(anchor).waitFor();
  if (state === 'opened') {
    await page.locator('[data-queued-row] button.evidence-queued-decide').click();
    await page.locator('.evidence-queued-notice').waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  // The conversation at its end, where the cards are drawn, whatever an expansion did to it.
  await page.locator('.workspace-scroll-wrap .workspace-sessions').first().evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
  await page.waitForTimeout(300);
  const box = await page.locator(state === 'opened' ? '.evidence-decision:has(.evidence-queued-notice)' : anchor).first().boundingBox();
  const composer = await page.locator('.composer-box').first().boundingBox();
  const target = state === 'opened' ? '.evidence-decision:has(.evidence-queued-notice)' : anchor;
  const text = await page.locator(target).first().innerText();
  const file = `${OUT}/${state}-${theme}.png`;
  await page.screenshot({ path: file });
  await context.close();
  const whole = Boolean(box && composer && box.y >= 0 && box.y + box.height <= composer.y);
  return { state, theme, file, whole, text, errors, unhandled: api.unhandled };
}

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/turn-foot-mock/fonts.conf' } });
try {
  for (const state of ['queued', 'opened', 'sent']) {
    for (const theme of ['light', 'dark']) {
      if (ONLY.length && !ONLY.includes(`${state}-${theme}`)) continue;
      console.log(JSON.stringify(await shoot(browser, state, theme), null, 1));
    }
  }
} finally {
  await browser.close();
}
