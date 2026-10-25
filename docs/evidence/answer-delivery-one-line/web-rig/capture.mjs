// answer-delivery-one-line evidence: the coordinator conversation on this worktree's real web app (its own
// vite dev server + the repo's ui-migration REST fixtures, a coordinator session layered over them) with the
// owner's answer handed to the coordinator — drawn as one line under the Answered card, the line opened to
// the words the agent read, and the same line while the turn still waits on the queue.
// usage: unshare -n ./run-ns.sh capture.mjs <outDir> [scene-theme ...]
import fs from 'node:fs';

const W = '/root/.orbit/worktrees/eb1d9354-6df5-55cf-a6cc-28e45786a362';
const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH } = await import(`${W}/src/web/ui-migration/session-fixtures.mjs`);

const BASE = 'http://127.0.0.1:5763';
const OUT = process.argv[2];
const ONLY = process.argv.slice(3);
if (!OUT) throw new Error('usage: capture.mjs <outDir> [scene-theme ...]');
fs.mkdirSync(OUT, { recursive: true });

// The fixtures freeze the clock at 2026-09-28T12:00Z, 20:00 in Shanghai. The coordinator asked at 19:10,
// the owner answered at 19:29:23, and the coordinator was handed the answer half a second later.
const PROJECT_ID = FIXTURE_IDS.project;
const PROJECT_TITLE = 'Wiki server-side runs';
const ASKED_AT = '2026-09-28T11:10:00.000Z';
const ANSWERED_AT = '2026-09-28T11:29:23.122Z';
const DELIVERED_AT = '2026-09-28T11:29:23.508Z';

const QUESTION = {
  question: 'The cleanup after the rollout rollback is done:\n\n'
    + '- After the new version deployed, the maintenance job resumed and its first round finished, rechecking every anchor.\n'
    + '- The conclusions written wrongly during the rollout are cleared, and the failure count is back to zero.\n'
    + '- All three fixes are in production.\n\n'
    + 'Approve reopening the rollout the same way as the first time: the list still holds only your account, and only two services are rebuilt.',
  options: [
    { label: 'Reopen now and accept the cost', description: 'No special timing. At most the part of the current round already run is redone.' },
    { label: 'Switch when a new round starts', description: 'Least waste; may wait up to two hours for the current round.' },
    { label: 'Do not reopen yet', description: 'The executor stays as it is and the rollout stays paused.' },
  ],
  recommendedOption: 0,
  blocksTaskIds: [],
  ifUnanswered: 'The rollout stays paused.',
};
/** apiserver `ownerAnswerMessage`, word for word. */
const TOLD = `From Orbit · owner answer: you asked "${QUESTION.question}". `
  + `The owner answered: ${QUESTION.options[0].label} (${ANSWERED_AT}).`;
const CARD = { itemId: '0196e000-0000-7000-8000-0000000003a1', kind: 'COORDINATOR_QUESTION', sessionId: SESSION.id, deliveredAt: DELIVERED_AT };
const CLOSED = [{
  itemId: CARD.itemId, question: QUESTION, askedAt: ASKED_AT, resolution: 'ANSWERED', resolvedBy: 'USER',
  resolvedAt: ANSWERED_AT, answer: { option: 0, text: null }, delivery: { sessionId: SESSION.id, at: ANSWERED_AT },
  withdrawReason: null,
}];

const coordinator = (over) => ({
  ...SESSION,
  title: PROJECT_TITLE,
  projectId: PROJECT_ID,
  projectTitle: PROJECT_TITLE,
  pendingApprovals: 0,
  engineTurnActive: false,
  createdAt: '2026-09-28T02:00:00.000Z',
  status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lastTurnAt: '2026-09-28T11:29:58.000Z', updatedAt: '2026-09-28T11:29:58.000Z',
  ...over,
});

const ASKED = [
  { seq: 1, type: 'user', turnId: 'turn-1', ts: '2026-09-28T11:02:00.000Z',
    payload: { text: 'Is the cleanup after the rollback done? If so, ask me when to reopen the rollout.' } },
  { seq: 2, type: 'assistant', turnId: 'turn-1', ts: ASKED_AT,
    payload: { text: 'The cleanup is done. I asked you with ask_owner when to reopen the rollout; I will not touch production until you answer.' } },
  { seq: 3, type: 'turn_end', turnId: 'turn-1', ts: ASKED_AT, payload: { subtype: 'success' } },
];
const ANSWERED = [
  ...ASKED,
  { seq: 4, type: 'user', turnId: 'turn-2', ts: DELIVERED_AT, payload: { text: TOLD, ownerAnswer: CARD } },
  { seq: 5, type: 'assistant', turnId: 'turn-2', ts: '2026-09-28T11:29:58.000Z',
    payload: { text: 'Got it: reopening the rollout now. I will switch the traffic first, then watch the first maintenance round finish.' } },
  { seq: 6, type: 'turn_end', turnId: 'turn-2', ts: '2026-09-28T11:29:58.000Z', payload: { subtype: 'success' } },
];
const QUEUED_ROW = {
  turnId: 'turn-queued', kind: 'message', placement: 'queued', content: TOLD, createdAt: DELIVERED_AT,
  attachments: [], ownerAnswer: CARD, authoredByOrbit: true,
};

const SCENES = {
  line: { session: coordinator(), events: ANSWERED, turns: [] },
  opened: { session: coordinator(), events: ANSWERED, turns: [], open: true },
  // Still waiting behind the coordinator's running turn.
  queued: {
    session: coordinator({ status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', engineTurnActive: true }),
    events: ASKED, turns: [QUEUED_ROW],
  },
};

async function shoot(browser, scene, theme) {
  const s = SCENES[scene];
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1120 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    // A 24-hour English locale: the line's clock is the receipts' (`decisionReceiptTime`), the board's 19:29.
    locale: 'en-GB',
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
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== 'GET') return route.fallback();
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (path === `/api${SESSION_PATH}`) return json(s.session);
    if (path === '/api/sessions') return json([s.session]);
    if (path === `/api${SESSION_PATH}/events/page`) return json({ events: s.events, hasMore: false });
    if (path === `/api${SESSION_PATH}/turns`) return json(s.turns);
    if (path === `/api/projects/${PROJECT_ID}/open-items`) {
      return json({ needsYou: [], withCoordinator: [], settled: [], startRequest: null, doneRequest: null, closedQuestions: CLOSED });
    }
    if (path === '/api/tasks/evidence-decisions/pending') {
      return json({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [], decided: [], waitingOnCoordinator: [], sentToCoordinator: [] });
    }
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
  await page.locator('.owner-answer-line').first().waitFor();
  if (s.open) {
    await page.locator('.owner-answer-line').first().click();
    await page.locator('.owner-answer-told pre').first().waitFor({ state: 'visible' });
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  // The conversation at its end, where the line is drawn, whatever opening it did to the height.
  await page.locator('.workspace-scroll-wrap .workspace-sessions').first().evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
  await page.waitForTimeout(400);
  const file = `${OUT}/web-${scene}-${theme}.png`;
  await page.screenshot({ path: file });
  const facts = await page.evaluate(() => ({
    line: document.querySelector('.owner-answer-text')?.textContent ?? null,
    queuedMark: Boolean(document.querySelector('.owner-answer.is-queued')),
    queuedLine: document.querySelector('.owner-answer-queued .chat-queued-meta')?.textContent ?? null,
    open: document.querySelector('details.owner-answer-fold')?.open ?? null,
    told: document.querySelector('.owner-answer-told pre')?.textContent?.slice(0, 60) ?? null,
    bubbles: [...document.querySelectorAll('.chat-user .md')].map((el) => el.textContent?.slice(0, 60)),
    answered: [...document.querySelectorAll('*')].some((el) => el.children.length === 0 && el.textContent === 'Answered'),
  }));
  await context.close();
  return { scene, theme, file, facts, errors, unhandled: api.unhandled };
}

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/turn-foot-mock/fonts.conf' } });
try {
  for (const [scene, theme] of [['line', 'light'], ['opened', 'light'], ['queued', 'light'], ['line', 'dark']]) {
    if (ONLY.length && !ONLY.includes(`${scene}-${theme}`)) continue;
    console.log(JSON.stringify(await shoot(browser, scene, theme), null, 1));
  }
} finally {
  await browser.close();
}
