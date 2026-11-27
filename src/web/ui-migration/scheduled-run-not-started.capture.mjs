// Real-build shots of a scheduled run's session where the run did not get under way (board
// docs/mocks/scheduled-run-not-started, frames 2 to 4, the owner's B1): Didn't run, Queued · runner full and
// Started on try N, each in light and dark, at phone and desktop width, and each phone shot beside the board's frame.
//
// Not a test: run by hand against a dev server or `npm run preview`, with the UI-migration fixtures answering every
// API call and the run's routes answered from src/test/scheduleFixtures.ts:
//   node src/web/ui-migration/scheduled-run-not-started.capture.mjs <outDir> [baseURL] [board.png]
// The board is the task's attachment, not in git; without it the side-by-side images are skipped.
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { installFixtures } from './fixtures.mjs';
import { RUNNER, SESSION, SESSION_PATH, WORKSPACE } from './session-fixtures.mjs';
import {
  BUMP_MISSED_RUN,
  BUMP_QUEUED_RUN,
  BUMP_STARTED_RUN,
  SCHEDULE_NOW,
  bumpMissedStatus,
  bumpQueuedStatus,
  bumpStartedStatus,
  scheduleDetail,
} from '../src/test/scheduleFixtures.ts';

const out = `${process.argv[2] ?? '.'}/`;
const baseURL = process.argv[3] ?? 'http://127.0.0.1:5199';
const board = process.argv[4] ?? null;
mkdirSync(out, { recursive: true });

/** The board's phone frames, in its 3680 px wide pixels: x, y, width, height. */
const FRAMES = { 2: [925, 375, 790, 1610], 3: [1771, 375, 790, 1610], 4: [2617, 375, 790, 1610] };
const VIEWPORTS = { phone: { width: 390, height: 844 }, desktop: { width: 1360, height: 860 } };

/** This page's session as the try its run status names. */
function asThisTry(status) {
  const i = (status.thisTry ?? 1) - 1;
  return { ...status, tries: status.tries.map((t, n) => (n === i ? { ...t, sessionId: SESSION.id } : t)) };
}

const SCENES = {
  2: {
    name: 'didnt-run', card: 'DIDNT_RUN',
    session: { status: 'CANCELLED', runState: 'ENDED', finishedAt: '2025-11-13T21:44:00.000Z', startedAt: null, numTurns: 0,
      capabilities: { canSend: false, canResume: false, resumeBlockedReason: 'NOT_STARTED', canComplete: true, canRestore: false } },
    run: { ...BUMP_MISSED_RUN, sessionId: SESSION.id }, status: asThisTry(bumpMissedStatus()),
  },
  3: {
    name: 'queued-runner-full', card: 'QUEUED_FULL',
    session: { status: 'PENDING', runState: 'QUEUED', startedAt: null, numTurns: 0, queuedReason: 'runner_at_capacity',
      queuedActive: 20, queuedLimit: 20, queuedHeldByJobs: 0,
      capabilities: { canSend: true, canResume: false, resumeBlockedReason: 'NOT_TERMINAL', canComplete: true, canRestore: false } },
    run: { ...BUMP_QUEUED_RUN, sessionId: SESSION.id }, status: asThisTry(bumpQueuedStatus()),
  },
  4: {
    name: 'started-on-try-3', card: 'STARTED_ON',
    session: { status: 'CANCELLED', runState: 'ENDED', finishedAt: '2025-11-13T19:50:00.000Z', startedAt: '2025-11-13T19:43:30.000Z', numTurns: 0,
      error: 'Claude Code exited before the first turn.',
      capabilities: { canSend: false, canResume: false, resumeBlockedReason: 'NOT_STARTED', canComplete: true, canRestore: false } },
    run: BUMP_STARTED_RUN, status: asThisTry(bumpStartedStatus(2)),
  },
};

async function freezeClock(page) {
  await page.addInitScript((timestamp) => {
    window.Date = new Proxy(Date, {
      construct: (OriginalDate, args) => Reflect.construct(OriginalDate, args.length ? args : [timestamp]),
      apply: (OriginalDate) => new OriginalDate(timestamp).toString(),
      get: (OriginalDate, key) => (key === 'now' ? () => timestamp : Reflect.get(OriginalDate, key)),
    });
  }, Date.parse(SCHEDULE_NOW));
}

async function scene(browser, frame, theme, viewport) {
  const s = SCENES[frame];
  const runner = { ...RUNNER, name: 'HPC', maxConcurrent: 20, activeSessions: 20 };
  const workspace = { ...WORKSPACE, name: 'apiserver', runnerId: runner.id };
  const shown = { ...SESSION, title: 'Engine version bump · run of Nov 14', workspace, runSource: 'SCHEDULE', ...s.session };
  const page = await browser.newPage({ viewport, baseURL, locale: 'en-US', timezoneId: 'Asia/Shanghai', colorScheme: theme });
  await freezeClock(page);
  await installFixtures(page, { theme });
  // Registered after installFixtures, so these answer first.
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (request.method() !== 'GET') return route.fallback();
    if (path === '/api/runners') return json([runner]);
    if (path === '/api/workspaces') return json([workspace]);
    // C1: a try that never reached its engine is in no list; it is opened by id from the run's history.
    if (path === '/api/sessions') return json([]);
    if (path === `/api${SESSION_PATH}`) return json(shown);
    if (path === `/api${SESSION_PATH}/events/page`) return json({ events: [], hasMore: false });
    if (path === `/api${SESSION_PATH}/approvals`) return json([]);
    if (path === `/api${SESSION_PATH}/schedule-cards`) return json({ run: s.run, runStatus: s.status, cards: [], records: [] });
    if (path === '/api/schedules/sch-bump') return json(scheduleDetail('sch-bump'));
    return route.fallback();
  });
  return page;
}

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function shoot(browser, frame, theme, size, retried = false) {
  const s = SCENES[frame];
  const page = await scene(browser, frame, theme, VIEWPORTS[size]);
  await page.goto(`${SESSION_PATH}?folder=scheduled`);
  try {
    await page.locator(`[data-schedule-run-card="${s.card}"]`).waitFor({ timeout: 90_000 });
  } catch (error) {
    // A loaded dev server can miss a first load; one more, then the failure is real.
    await page.close();
    if (retried) throw error;
    return shoot(browser, frame, theme, size, true);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await settle(page);
  const file = `${frame}-${s.name}-${theme}-${size}.png`;
  await page.screenshot({ path: `${out}${file}` });
  const composer = await page.locator('.workspace-composer').count();
  await page.close();
  console.log(`${file}: composer ${composer === 0 ? 'absent' : 'PRESENT'}`);
  return file;
}

/** The real-build shot beside the board's frame, as one image. */
async function beside(browser, frame, shot) {
  if (!board || !existsSync(board)) return;
  const [x, y, w, h] = FRAMES[frame];
  const scale = 0.5;
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const img = (file) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  await page.setContent(`<!doctype html><body style="margin:0;font:14px system-ui;background:#fff">
    <div style="display:flex;gap:24px;padding:24px;align-items:flex-start">
      <figure style="margin:0;flex:none"><figcaption style="margin-bottom:8px;color:#555">Board, frame ${frame} (iOS, design)</figcaption>
        <div style="width:${w * scale}px;height:${h * scale}px;border:1px solid #ddd;background:url(${img(board)}) no-repeat;
          background-size:${3680 * scale}px auto;background-position:-${x * scale}px -${y * scale}px"></div></figure>
      <figure style="margin:0;flex:none"><figcaption style="margin-bottom:8px;color:#555">Real web build, phone width</figcaption>
        <img src="${img(`${out}${shot}`)}" style="width:390px;border:1px solid #ddd"></figure>
    </div></body>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}${shot.replace('.png', '-beside-board.png')}`, fullPage: true });
  await page.close();
}

const browser = await chromium.launch();
for (const frame of [2, 3, 4]) {
  for (const theme of ['light', 'dark']) {
    for (const size of ['phone', 'desktop']) {
      const file = await shoot(browser, frame, theme, size);
      if (theme === 'light' && size === 'phone') await beside(browser, frame, file);
    }
  }
}
await browser.close();
