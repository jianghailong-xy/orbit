// Real-build shots of conditions on the web (docs/condition-triggers-design.md §9), one per frame 2 to 6 of
// docs/mocks/condition-triggers/01-board.png, each also set beside the board's frame.
//
// Not a test: run by hand against `npm run preview` of a fresh `npm run build`, with the UI-migration fixtures
// answering every API call and the condition routes answered from condition-fixtures.mjs:
//   node src/web/ui-migration/condition-triggers.capture.mjs [baseURL]
// Writes into docs/evidence/condition-triggers/web/.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXTURE_TASK, PATHS, installFixtures } from './fixtures.mjs';
import { SESSION, SESSION_PATH, WORKSPACE } from './session-fixtures.mjs';
import {
  COMMAND_WIDEN_CARD,
  CONDITIONS,
  CONDITION_NOW,
  CEPH_RUN,
  IDS,
  OSD_TASK_START_WHEN,
  TASK_CREATE_APPROVAL,
  WAITING_ITEMS,
  WHEN_CREATE_CARD,
  WHEN_CREATE_CARD_REPEAT,
  conditionListAnswer,
  conditionScheduleDetail,
} from './condition-fixtures.mjs';

const baseURL = process.argv[2] ?? 'http://127.0.0.1:4173';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const board = `${repo}docs/mocks/condition-triggers/01-board.png`;
const out = `${repo}docs/evidence/condition-triggers/web/`;
mkdirSync(out, { recursive: true });

const ago = (minutes) => new Date(Date.parse(CONDITION_NOW) - minutes * 60_000).toISOString();

/** The board's frames, in its 3000 px wide pixels: x, y, width, height. */
const FRAMES = {
  2: [1012, 318, 880, 1730],
  3: [1950, 318, 880, 1680],
  4: [70, 2080, 880, 1790],
  5: [1012, 2080, 880, 1655],
  6: [1950, 2080, 880, 1860],
};

async function freezeClock(page) {
  await page.addInitScript((timestamp) => {
    window.Date = new Proxy(Date, {
      construct: (OriginalDate, args) => Reflect.construct(OriginalDate, args.length ? args : [timestamp]),
      apply: (OriginalDate) => new OriginalDate(timestamp).toString(),
      get: (OriginalDate, key) => (key === 'now' ? () => timestamp : Reflect.get(OriginalDate, key)),
    });
  }, Date.parse(CONDITION_NOW));
}

/**
 * One page with the conditions served: the schedule list and details, the conditions, and per scene the session's
 * title, events, approvals and schedule cards, and Waiting on you.
 */
async function scene(browser, { title = SESSION.title, session = {}, events = [], approvals = [], scheduleCards = null, requests = [], task = null, height = 860 } = {}) {
  const shown = { ...SESSION, title, workspace: { ...WORKSPACE, name: 'HPC' }, ...session };
  const page = await browser.newPage({ viewport: { width: 1360, height }, baseURL, locale: 'en-US', timezoneId: 'UTC' });
  await freezeClock(page);
  await installFixtures(page, { theme: 'light' });
  // Registered after installFixtures, so these answer first.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (request.method() !== 'GET') return route.fallback();
    if (path === '/api/schedules') return json(conditionListAnswer());
    if (path === '/api/schedules/drafts') return json({ drafts: [] });
    const detail = /^\/api\/schedules\/([^/]+)$/.exec(path);
    if (detail) return json(conditionScheduleDetail(decodeURIComponent(detail[1])));
    const condition = /^\/api\/conditions\/([^/]+)$/.exec(path);
    if (condition) return json(CONDITIONS.find((c) => c.id === decodeURIComponent(condition[1])));
    const scheduleRequest = /^\/api\/schedule-requests\/([^/]+)$/.exec(path);
    if (scheduleRequest) return json(COMMAND_WIDEN_CARD);
    if (path === '/api/owner-requests') return json({ requests });
    if (path === '/api/workspaces') return json([{ ...WORKSPACE, name: 'HPC' }]);
    if (path === '/api/sessions') return json([shown]);
    if (path === `/api${SESSION_PATH}`) return json(shown);
    if (path === `/api${SESSION_PATH}/events/page`) return json({ events, hasMore: false });
    if (path === `/api${SESSION_PATH}/approvals`) return json(approvals);
    if (path === `/api${SESSION_PATH}/schedule-cards`) return json(scheduleCards ?? { run: null, cards: [], records: [] });
    if (task && path === `/api/tasks/${task.id}`) return json(task);
    return route.fallback();
  });
  return page;
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function ready(page, selector) {
  await page.locator('#boot').waitFor({ state: 'detached' }).catch(() => page.locator('#boot').waitFor({ state: 'hidden' }));
  await page.locator(selector).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await settle(page);
}

const turn = (seq, type, text, minutes) => ({ seq, type, payload: { text }, turnId: `turn-${Math.ceil(seq / 3)}`, ts: ago(minutes) });

/** The real-build shot beside the board's frame, as one image. */
async function beside(browser, frame, shot, caption) {
  const [x, y, w, h] = FRAMES[frame];
  const scale = 0.62;
  const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
  const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  await page.setContent(`<!doctype html><body style="margin:0;font:14px system-ui;background:#fff">
    <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
      <figure style="margin:0;flex:none"><figcaption style="margin-bottom:8px;color:#555">Board, frame ${frame} (iOS, design)</figcaption>
        <div style="width:${w * scale}px;height:${h * scale}px;border:1px solid #ddd;background:url(${img(board)}) no-repeat;
          background-size:${3000 * scale}px auto;background-position:-${x * scale}px -${y * scale}px"></div></figure>
      <figure style="margin:0;flex:1"><figcaption style="margin-bottom:8px;color:#555">Real web build: ${caption}</figcaption>
        <img src="${img(`${out}${shot}`)}" style="width:100%;border:1px solid #ddd"></figure>
    </div></body>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}${shot.replace('.png', '-beside-board.png')}`, fullPage: true });
  await page.close();
}

const browser = await chromium.launch();

// Frame 2: the task create card, Starts when, Today and If never.
{
  const page = await scene(browser, {
    title: 'Ceph pool query',
    events: [
      turn(1, 'user', 'Set the kubernetes pool to 3 copies.', 6),
      turn(2, 'assistant', "Holding, no changes made. I can pick this up by itself when the third OSD is in; closing this chat won't stop it.", 5),
    ],
    // The turn is waiting on the card, so it can be answered.
    session: { status: 'RUNNING', runState: 'AWAITING_APPROVAL' },
    approvals: [TASK_CREATE_APPROVAL],
  });
  await page.goto(SESSION_PATH);
  await ready(page, '[data-start-when-facts]');
  await page.screenshot({ path: `${out}2-task-create-card.png` });
  await page.close();
}

// Frame 3: the schedule create card, When lines and the command; and the same card with a repeat on Orbit Cloud.
for (const [card, shot] of [[WHEN_CREATE_CARD, '3-schedule-create-card.png'], [WHEN_CREATE_CARD_REPEAT, '3b-schedule-create-card-repeat-cloud.png']]) {
  const page = await scene(browser, {
    title: card.title === 'Ceph capacity guard' ? 'Ceph capacity' : 'Gateway errors',
    events: [
      turn(1, 'user', card.intent, 6),
      turn(2, 'assistant', card === WHEN_CREATE_CARD
        ? "I checked just now: raw used is **6.9%** (2.0 of 29.1 TiB), so there is nothing to do today. I can keep an eye on it; closing this chat won't stop it."
        : 'The 5xx rate is 0.4% right now. I can watch it and look each time it crosses 2%.', 5),
      turn(3, 'turn_end', '', 5),
    ],
    scheduleCards: { run: null, cards: [card], records: [] },
  });
  await page.goto(SESSION_PATH);
  await ready(page, '[data-schedule-card="create"]');
  await page.locator('[data-schedule-card="create"]').scrollIntoViewIfNeeded();
  await settle(page);
  await page.screenshot({ path: `${out}${shot}` });
  await page.close();
}

// Frame 4: the Scheduled page, the group with readings and Can't read under Needs you.
{
  const page = await scene(browser);
  await page.goto('/scheduled');
  await ready(page, '.sched-group[data-group="CONDITION"]');
  await page.screenshot({ path: `${out}4-scheduled-page.png` });
  await page.close();
}

// Frame 5: a run its condition started: the header names the firing.
{
  const page = await scene(browser, {
    title: 'Ceph capacity guard · run of Nov 21',
    events: [
      turn(1, 'assistant', 'Raw use went from 84% to 90.4% since Nov 19. Almost all of the growth is in `kubernetes`: 14 RBD snapshots older than 7 days hold 1.1 TiB. Deleting them brings raw use to about 83%.', 60 * 33),
      turn(2, 'turn_end', '', 60 * 33),
    ],
    session: { runSource: 'SCHEDULE', status: 'COMPLETED', runState: 'IDLE' },
    scheduleCards: { run: CEPH_RUN, cards: [], records: [] },
  });
  await page.goto(`${SESSION_PATH}?schedule=${IDS.ceph}&run=${CEPH_RUN.id}`);
  await ready(page, '[data-schedule-strip="condition"]');
  await page.screenshot({ path: `${out}5-run-session-fired.png` });
  await page.close();
}

// Frame 6: the can't-read card and the 30-day question in Waiting on you; the inspector's Condition and How it
// checks blocks with Fired and Ready again in the history.
{
  const page = await scene(browser, { requests: WAITING_ITEMS });
  await page.goto('/waiting');
  await ready(page, '[data-kind="CONDITION_UNKNOWN"]');
  await page.screenshot({ path: `${out}6-waiting-on-you.png` });
  await page.close();
}
{
  const page = await scene(browser, { height: 1240 });
  await page.goto(`/scheduled?id=${IDS.ceph}`);
  await ready(page, '[data-inspector-block="checks"]');
  await page.locator('[data-inspector-block="history"]').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}6-inspector-condition.png` });
  await page.close();
}
{
  const page = await scene(browser, { height: 1240 });
  await page.goto(`/scheduled?id=${IDS.gateway}`);
  await ready(page, '[data-condition-repeat]');
  await page.screenshot({ path: `${out}6b-inspector-repeat-cloud.png` });
  await page.close();
}

// Beyond the board's frames: the widen card for a changed command, and the waiting line on the task.
{
  const page = await scene(browser, {
    title: 'Ceph capacity guard · run of Nov 21',
    events: [turn(1, 'assistant', 'The ratio is a fraction; I would like to read it as a percentage.', 3), turn(2, 'turn_end', '', 3)],
    scheduleCards: { run: null, cards: [COMMAND_WIDEN_CARD], records: [] },
  });
  await page.goto(SESSION_PATH);
  await ready(page, '[data-schedule-card="envelope"]');
  await page.screenshot({ path: `${out}extra-widen-command-card.png` });
  await page.close();
}

{
  const page = await scene(browser, {
    task: { ...FIXTURE_TASK, title: 'Set kubernetes pool to 3 copies', autoRunWhenReady: true, startWhen: OSD_TASK_START_WHEN },
  });
  await page.goto(PATHS.task);
  await ready(page, '[data-start-when]');
  await page.screenshot({ path: `${out}extra-task-waiting-line.png` });
  await page.close();
}

await beside(browser, 2, '2-task-create-card.png', 'conversation, the task create card');
await beside(browser, 3, '3-schedule-create-card.png', 'conversation, the schedule create card');
await beside(browser, 4, '4-scheduled-page.png', 'Scheduled page');
await beside(browser, 5, '5-run-session-fired.png', "a run's session, started by its condition");
await beside(browser, 6, '6-waiting-on-you.png', 'Waiting on you');
await beside(browser, 6, '6-inspector-condition.png', 'Scheduled page, the inspector');
await browser.close();
