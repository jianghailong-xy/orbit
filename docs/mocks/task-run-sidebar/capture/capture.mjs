// Real-page shots of the task run sidebar in its four states (docs/mocks/task-run-sidebar/02-real.png).
// The shipped web build (vite build of the worktree) on the ui-migration fixture API, with a task run
// conversation whose task is Failed, Running, Needs you or Done. The column opens by itself (D2 = B).
// Usage: node capture.mjs <worktree> <dist> <outDir> [width]
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [W, DIST, OUT, WIDTH = '1720'] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const { chromium } = await import(`${W}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate, FIXTURE_IDS, FIXED_NOW } = await import(`${W}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH } = await import(`${W}/src/web/ui-migration/session-fixtures.mjs`);
const { uuidToBase62 } = await import(`${W}/src/shared/dist/index.js`).catch(() => import(`${W}/node_modules/@orbit/shared/dist/index.js`));

const T = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let f = path.join(DIST, decodeURIComponent(new URL(q.url, 'http://x').pathname));
  if (!existsSync(f) || statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  r.writeHead(200, { 'content-type': T[path.extname(f)] ?? 'application/octet-stream' }); r.end(readFileSync(f));
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;

const at = (minutesBefore) => new Date(Date.parse(FIXED_NOW) - minutesBefore * 60_000).toISOString();
const id = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
const TASK = FIXTURE_IDS.task;
const ROUND_TURN = id(9001);
const EARLIER_RUN = id(9002);

const failedTitle = 'Fix the date-dependent failures in the web test suite and the duplicate heading in the config guide';
const uploadTitle = 'Add retry to the upload step';
const run = (over = {}) => ({
  id: SESSION.id, title: 'Task', status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', lifecycleState: 'OPEN',
  phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null, endReason: null, workFinished: false,
  createdAt: at(30), costUsd: 1.32, model: 'claude-sonnet-5-5', effort: 'medium', workspace: { name: 'orbit-ws01' },
  error: null, acceptanceRounds: [], route: null, ...over,
});
const baseTask = (over = {}) => ({
  id: TASK, title: failedTitle, status: 'FAILED', outcome: 'FAILED', createdAt: at(40), updatedAt: at(5),
  completionCriterion: 'EXECUTABLE', completionPolicy: 'MANUAL',
  acceptanceCommand: 'npm run docs:check && cd src/web && npx vitest run', acceptanceExpectedExitCode: 0,
  acceptanceCriteria: '- `npm run docs:check` passes\n- Full web suite, 0 failed\n- Fix the clock dependence, don\'t weaken tests',
  description: 'main is red in two places, found while landing an unrelated header change. Both also fail on main\'s own code.',
  assignee: { id: FIXTURE_IDS.workspace, name: 'orbit-ws01' }, assigneeId: FIXTURE_IDS.workspace,
  model: null, modelHint: null, provider: null, engine: null, project: null, projectId: null, listId: null, labels: [],
  autoRunWhenReady: true, dependencyState: 'READY', blocked: false, dependsOn: [], dependedOnBy: [], attachments: [],
  creatorSession: { id: id(9003), title: 'Polish the header share button', status: 'AWAITING_INPUT' },
  sessions: [run()], comments: [], integration: { state: 'NOT_APPLICABLE', mainBranch: 'main', landTask: null },
  progress: { revision: 0 }, runsWith: { engine: 'claude', provider: 'claude', providerBuiltin: true }, ...over,
});
const round = { id: id(9004), turnId: ROUND_TURN, exitCode: 1, expectedExitCode: 0, branchSha: '432e94c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7', finishedAt: at(7), outputTail: ' FAIL  src/components/ScheduleCards.test.tsx > next run line\n Tests  1 failed | 9788 passed (9789)' };

const STATES = {
  failed: {
    sessionTitle: failedTitle,
    branchCommits: [{ sha: '16f4a7e2b9c0', subject: 'docs: rename the second "Drive" heading', committedAt: at(12), files: [] }],
    task: baseTask({
      sessions: [run({ acceptanceRounds: [round], error: 'acceptance command exited 1; expected 0', lastTurnOutcome: 'FAILED' }),
        run({ id: EARLIER_RUN, createdAt: at(60 * 20), costUsd: 0.61, acceptanceRounds: [] })],
      comments: [{ id: id(9005), authorName: 'orbit-ws01', createdAt: at(4), body: 'Machine load, not the code. The run\'s own check exited 0 at 06:48; Orbit\'s acceptance ran the same command at 06:50 and exited 1.', deliveries: [], mentions: [] }],
    }),
    events: [
      ['user', { text: 'Fix the date-dependent failures in the web test suite.' }],
      ['assistant', { text: 'Main already carries the same hidden-tab fix (`ca1e0d`), using the file\'s hidden-tab driver.\n\nThe rebase is done. Since main fixed several of the same failures, I\'m checking my remaining commits.\n\nOnly one commit is left: `16f4a7`, which renames the second "Drive" heading. The suite passes all 9789 tests in 718 files.' }],
      ['user', { text: 'npm run docs:check && cd src/web && npx vitest run', shell: true }, ROUND_TURN],
      ['assistant', { text: '**The task still shows FAILED.** The records I read don\'t say why.' }],
    ],
  },
  running: {
    sessionTitle: uploadTitle,
    branchCommits: [1, 2, 3].map((n) => ({ sha: `a${n}b2c3d4e5f6`, subject: ['feat(upload): retry 5xx with backoff', 'test(upload): three retries then give up', 'refactor(upload): one request helper'][n - 1], committedAt: at(n), files: [] })),
    task: baseTask({
      title: uploadTitle, status: 'IN_PROGRESS', outcome: 'OPEN', completionCriterion: 'EXECUTABLE', acceptanceCommand: 'npm test',
      acceptanceCriteria: '- Upload retries 3× on 5xx', description: 'Retry the upload step on 5xx with backoff.',
      sessions: [run({ status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', phase: 'RUNNING', activity: 'TURN', released: false, createdAt: at(7), costUsd: 0.84, lastTurnOutcome: null, model: 'claude-opus-5-5', effort: 'high' })],
      progress: { revision: 3, phase: 'Retry with backoff in upload.ts', current: 3, total: 5, message: 'Read the design; specs and evidence next.', lastProgressAt: at(1) },
    }),
    events: [
      ['user', { text: 'Add retry to the upload step.' }],
      ['assistant', { text: 'Reading the design first, then the upload step.' }],
    ],
  },
  needsYou: {
    sessionTitle: uploadTitle,
    branchCommits: [1, 2, 3, 4].map((n) => ({ sha: `b${n}c2d3e4f5a6`, subject: `upload: step ${n}`, committedAt: at(10 + n), files: [] })),
    task: baseTask({
      title: uploadTitle, status: 'IN_PROGRESS', outcome: 'OPEN', completionCriterion: 'OWNER_CONFIRMED', acceptanceCommand: null,
      acceptanceCriteria: '- Upload retries 3× on 5xx\n- `npm test` exits 0', description: 'Retry the upload step on 5xx with backoff.',
      sessions: [run({ status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', phase: 'IDLE', released: false, waitingOn: 'PERSON', createdAt: at(46), costUsd: 3.12 })],
    }),
    ownerConfirmation: { taskId: TASK, title: uploadTitle, status: 'IN_PROGRESS', projectId: null, completionCriterion: 'OWNER_CONFIRMED', acceptanceCriteria: null,
      waiting: { requestId: id(9006), sessionId: SESSION.id, requestedAt: at(2), report: null, review: null }, decisions: [], ifConfirmed: null, reviewerReturns: [] },
    evidence: [{ revision: '1', submittedAt: at(2), evidence: { claim: 'Uploads retry three times on a 5xx, with backoff.', gaps: [],
      checks: [{ kind: 'COMMIT', ref: 'b4c2d3e4f5a6', succeeded: true }, { kind: 'TOOL_CALL', ref: 'bgj_1', command: 'npm test · 214 passed', succeeded: true }] }, decision: null }],
    events: [
      ['user', { text: 'Add retry to the upload step.' }],
      ['assistant', { text: 'Done: uploads retry three times on a 5xx. I\'ve asked you to confirm.' }],
    ],
  },
  done: {
    sessionTitle: uploadTitle,
    branchCommits: [],
    branchMerged: true,
    task: baseTask({
      title: uploadTitle, status: 'DONE', outcome: 'DONE', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCommand: null,
      acceptanceCriteria: '- Upload retries 3× on 5xx\n- `npm test` exits 0', description: 'Retry the upload step on 5xx with backoff.',
      integration: { state: 'ON_UPSTREAM', mainBranch: 'main', landTask: null },
      sessions: [run({ status: 'SUCCEEDED', runStatus: 'SUCCEEDED', runState: 'SUCCEEDED', phase: 'IDLE', workFinished: true, endReason: 'task_done', createdAt: at(52), costUsd: 3.12 })],
    }),
    evidence: [{ revision: '1', submittedAt: at(12), evidence: { claim: 'Uploads retry three times on a 5xx.' }, decision: { decision: 'CONFIRM', decidedAt: at(9), decidedByType: 'USER' } }],
    events: [
      ['user', { text: 'Add retry to the upload step.' }],
      ['assistant', { text: 'Landed on main.' }],
    ],
  },
};

const browser = await chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/nwf-cap/fonts.conf' } });
const boxes = {};
// The four states at a window wide enough to dock, then Failed once more below 1640 px: the overlay.
const SCENES = [...Object.entries(STATES), ['narrow', STATES.failed, 1500]];
for (const [name, s, sceneWidth] of SCENES) {
  const narrow = sceneWidth != null;
  const ctx = await browser.newContext({ viewport: { width: sceneWidth ?? Number(WIDTH), height: 1000 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'UTC', baseURL: base });
  const page = await ctx.newPage();
  await installFixedDate(page);
  await installFixtures(page, { theme: 'light' });
  const row = { ...SESSION, title: `Task: ${s.sessionTitle}`, taskId: TASK, taskTitle: s.sessionTitle, branch: name === 'failed' ? 'orbit/task-fix-date-dependent-failures' : 'orbit/task-add-retry-to-the-upload-step',
    isolationStatus: 'worktree', branchCommits: s.branchCommits, branchMerged: s.branchMerged ?? false, changedFiles: [], worktreeDirty: false,
    status: name === 'running' ? 'RUNNING' : 'AWAITING_INPUT', runState: name === 'running' ? 'RUNNING' : 'AWAITING_INPUT' };
  const json = (r, body) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  const events = s.events.map(([type, payload, turnId], i) => ({ seq: i + 1, type, payload, turnId: turnId ?? id(9100 + Math.floor(i / 2)), ts: at(20 - i) }));
  await page.route('**/api/**', async (r) => {
    const req = r.request();
    const p = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return r.fallback();
    if (p === `/api${SESSION_PATH}`) return json(r, row);
    if (p === '/api/sessions') return json(r, [row]);
    if (p === `/api${SESSION_PATH}/events/page`) return json(r, { events, hasMore: false });
    if (p === `/api/tasks/${TASK}`) return json(r, s.task);
    if (p === `/api/tasks/${TASK}/evidence`) return json(r, s.evidence ?? []);
    if (p === `/api/tasks/${TASK}/owner-confirmation`) return json(r, s.ownerConfirmation ?? { taskId: TASK, waiting: null, decisions: [] });
    return r.fallback();
  });
  await page.goto(SESSION_PATH);
  if (narrow) {
    // Below the docking width nothing opens by itself; the Task badge opens today's overlay.
    await page.locator('.coordinator-badge-link').waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    const before = await page.locator('.task-detail-panel').count();
    await page.click('.coordinator-badge-link');
    await page.locator('.task-detail-panel').waitFor({ timeout: 20000 });
    console.log('narrow: panels before the press', before);
  } else {
    // Nothing is pressed: the task's own run conversation opens it beside itself.
    await page.locator('.task-detail-panel.is-compact').waitFor({ timeout: 20000 });
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.fonts.ready);
  const box = await page.evaluate(() => {
    const b = (sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { panel: b('.task-detail-panel'), main: b('.app-main'), url: location.pathname + location.search,
      panelClass: document.querySelector('.task-detail-panel')?.className,
      blocks: [...document.querySelectorAll('.task-detail-panel [data-block]')].map((n) => n.getAttribute('data-block')),
      pill: document.querySelector('[data-status-pill]')?.textContent };
  });
  boxes[name] = box;
  await page.screenshot({ path: `${OUT}/${name}-window.png` });
  if (!narrow) await page.locator('.task-detail-panel').screenshot({ path: `${OUT}/${name}-column.png` });
  if (name === 'failed') {
    const x = box.main.x, y = 0, w = box.panel.x + box.panel.width - x + 8;
    await page.screenshot({ path: `${OUT}/${name}-dock.png`, clip: { x, y, width: w, height: 1000 } });
  }
  console.log(name, JSON.stringify(box));
  await ctx.close();
}
writeFileSync(`${OUT}/boxes.json`, JSON.stringify(boxes, null, 2));
await browser.close(); srv.close();
