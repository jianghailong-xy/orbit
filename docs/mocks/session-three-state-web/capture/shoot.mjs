// Real-page captures for docs/mocks/session-three-state-web: the session list and each session's header in the
// console of the tree run.sh serves. Every session carries the legacy fields a current server sends AND the four
// new ones (contracts/session-state.contract.json); the code before the change ignores the new ones, so its shots
// are also what any older server shows.
import fs from 'node:fs';
import { chromium } from '/root/.orbit/worktrees/d672e756-e8ec-5391-a44c-bfc54dcb732c/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate } from '/root/.orbit/worktrees/d672e756-e8ec-5391-a44c-bfc54dcb732c/src/web/ui-migration/fixtures.mjs';
import { WORKSPACE, RUNNER } from '/root/.orbit/worktrees/d672e756-e8ec-5391-a44c-bfc54dcb732c/src/web/ui-migration/session-fixtures.mjs';
import { uuidToBase62 } from '@orbit/shared';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5798';
const OUT = process.env.OUT;
const NOW = '2026-09-28T12:00:00.000Z';
const ago = (m) => new Date(Date.parse(NOW) - m * 60_000).toISOString();
const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-0000000009${String(n).padStart(2, '0')}`);

const base = (n, over) => ({
  id: sid(n), workspaceId: WORKSPACE.id, workspace: WORKSPACE, runnerId: RUNNER.id, assignedRunnerId: RUNNER.id,
  provider: 'claude', engine: 'claude', lifecycleState: 'OPEN', createdAt: ago(300), startedAt: ago(300),
  engineStartedAt: ago(300), numTurns: 3, runtimeSessionId: 'rt-' + n, shareToken: null, pendingApprovals: 0,
  capabilities: { canSend: true, canResume: false, resumeBlockedReason: 'NOT_TERMINAL', canComplete: true, canRestore: false },
  ...over,
});
const releasedCaps = { canSend: true, canResume: true, resumeBlockedReason: null, canComplete: true, canRestore: false };

export const STATES = [
  ['held-idle', 'Held idle', base(1, {
    title: 'Tidy the settings page', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    lastTurnAt: ago(4), updatedAt: ago(4), lastAssistantText: 'Done: the three toggles now share one row style.',
    phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null })],
  ['failed-turn', 'Released by a failed turn', base(2, {
    title: 'Upgrade the date library', status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', finishedAt: ago(9),
    error: 'API Error: 529 overloaded', lastTurnAt: ago(9), updatedAt: ago(9), lastUserText: 'Upgrade it and run the tests.',
    capabilities: releasedCaps, phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null })],
  ['ended', 'Released by End', base(3, {
    title: 'Draft the release notes', status: 'CANCELLED', runStatus: 'CANCELLED', runState: 'ENDED', endReason: 'ended',
    finishedAt: ago(20), lastTurnAt: ago(22), updatedAt: ago(20), lastAssistantText: 'The notes are in docs/releases/0.1.261.md.',
    capabilities: releasedCaps, phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null })],
  ['task-finished', 'A task run that finished', base(4, {
    title: 'Task: Add the export button', taskId: uuidToBase62('0196e000-0000-7000-8000-000000000101'),
    status: 'SUCCEEDED', runStatus: 'SUCCEEDED', runState: 'SUCCEEDED', endReason: 'task_done', finishedAt: ago(35),
    lastTurnAt: ago(36), updatedAt: ago(35), lastAssistantText: 'The export button is in, with its test.',
    capabilities: releasedCaps, phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null })],
  ['job-no-turn', 'Running a job with no turn', base(5, {
    title: 'Run the full test suite', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    activity: 'BACKGROUND_JOB', runningBgCount: 1, runningBgJobCount: 1, lastTurnAt: ago(6), updatedAt: ago(6),
    lastAssistantText: 'The suite is running in the background; I will read it when it ends.',
    phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: null })],
  ['approval', 'Waiting on an approval', base(6, {
    title: 'Clean up old branches', status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', pendingApprovals: 1,
    lastToolUse: 'Bash', lastTurnAt: ago(2), updatedAt: ago(2), lastUserText: 'Delete the merged branches.',
    phase: 'RUNNING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'PERSON' })],
  ['on-hold', 'On hold', base(7, {
    title: 'Translate the help pages', status: 'PENDING', runStatus: 'PENDING', runState: 'QUEUED', queuedReason: null,
    engineStartedAt: null, error: 'Account paused until 2026-09-29T00:00:00.000Z', lastTurnAt: ago(15), updatedAt: ago(1),
    lastUserText: 'Translate the remaining three pages.',
    phase: 'PENDING', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'HOLD' })],
  ['will-wake', 'Will wake', base(8, {
    title: 'Watch the nightly build', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
    activity: 'WAITING', lastTurnAt: ago(30), updatedAt: ago(30), lastAssistantText: 'I will look again when the build ends.',
    phase: 'IDLE', released: false, lastTurnOutcome: 'ANSWERED', waitingOn: 'WAKE' })],
  ['end-not-honored', 'Ended, runner never confirmed', base(9, {
    title: 'Profile the slow query', status: 'FAILED', runStatus: 'FAILED', runState: 'FAILED', endReason: 'ended',
    error: 'cancel not honored', finishedAt: ago(40), lastTurnAt: ago(45), updatedAt: ago(40),
    lastAssistantText: 'The slow part is the join on tags.',
    capabilities: releasedCaps, phase: 'IDLE', released: true, lastTurnOutcome: 'FAILED', waitingOn: null })],
  ['plain-succeeded', 'Old plain row stored SUCCEEDED', base(10, {
    title: 'Rename the CLI flags', status: 'SUCCEEDED', runStatus: 'SUCCEEDED', runState: 'SUCCEEDED', endReason: null,
    finishedAt: ago(600), lastTurnAt: ago(601), updatedAt: ago(600), lastAssistantText: 'Renamed, and the old names still work.',
    capabilities: releasedCaps, phase: 'IDLE', released: true, lastTurnOutcome: 'ANSWERED', waitingOn: null })],
  ['ending-interrupted', 'Being ended after an interrupted turn', base(11, {
    title: 'Sketch the onboarding flow', status: 'INTERRUPTED', runStatus: 'INTERRUPTED', runState: 'ENDED', endReason: 'ended',
    cancelRequestedAt: ago(0.2), lastTurnAt: ago(50), updatedAt: ago(0.2), lastUserText: 'Add a step for the invite.',
    capabilities: { canSend: false, canResume: false, resumeBlockedReason: 'ENDING', canComplete: true, canRestore: false },
    phase: 'IDLE', released: false, lastTurnOutcome: 'INTERRUPTED', waitingOn: null })],
];
const sessions = STATES.map(([, , s]) => s);
const events = (s) => [
  { seq: 1, type: 'user', payload: { text: s.lastUserText ?? 'Go ahead.' }, turnId: 't-' + s.id, ts: s.lastTurnAt },
  ...(s.lastAssistantText ? [{ seq: 2, type: 'assistant', payload: { text: s.lastAssistantText }, turnId: 't-' + s.id, ts: s.lastTurnAt },
    { seq: 3, type: 'turn_end', payload: {}, turnId: 't-' + s.id, ts: s.lastTurnAt }] : []),
];

async function route(page) {
  await page.route('**/api/**', async (r) => {
    const req = r.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');
    if (req.method() !== 'GET') return r.fallback();
    if (path === '/sessions') return r.fulfill({ json: sessions });
    if (path === '/sessions/counts') return r.fulfill({ json: [{ workspaceId: WORKSPACE.id, active: 2, running: 1, jobs: 1, needsYou: 1 }] });
    const m = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
    const s = m && sessions.find((x) => x.id === m[1]);
    if (!s) return r.fallback();
    const sub = m[2] ?? '';
    if (!sub) return r.fulfill({ json: s });
    if (sub === '/events/page') return r.fulfill({ json: { events: events(s), hasMore: false } });
    if (['/turns', '/approvals', '/background'].includes(sub)) return r.fulfill({ json: [] });
    if (sub === '/diff') return r.fulfill({ json: { files: [], patches: [] } });
    if (sub === '/created-tasks') return r.fulfill({ json: { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] } });
    return r.fallback();
  });
}

const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome' });
const marks = {};
try {
  for (const [key, , s] of STATES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light',
      locale: 'en-US', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(180_000);
    await installFixedDate(page);
    await installFixtures(page, { theme: 'light' });
    await route(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('requestfailed', (q) => errors.push('failed: ' + q.url()));
    await page.goto(`${BASE}/sessions/${s.id}`);
    await page.evaluate(() => document.fonts.ready);
    const title = page.getByText(s.title, { exact: true }).filter({ visible: true }).first();
    try {
      await title.waitFor({ timeout: 60_000 }).catch(async () => { await page.reload(); await title.waitFor({ timeout: 90_000 }); });
    } catch (e) {
      await page.screenshot({ path: `${OUT}/_fail-${key}.png` });
      console.log(key, 'NOT RENDERED', errors.slice(0, 5).join(' | '));
      throw e;
    }
    await page.waitForTimeout(1500);
    await page.mouse.move(2, 2);
    await page.screenshot({ path: `${OUT}/${key}-full.png` });
    // The list column (every row), the conversation header, and the line above the composer when there is one.
    if (key === STATES[0][0]) await page.screenshot({ path: `${OUT}/list.png`, clip: { x: 292, y: 180, width: 300, height: 900 - 180 } });
    await page.screenshot({ path: `${OUT}/${key}-head.png`, clip: { x: 612, y: 12, width: 660, height: 84 } });
    const banner = page.getByText(/(resume this session|starts a new session|bring it online to resume)/).first();
    const bb = await banner.boundingBox({ timeout: 1500 }).catch(() => null);
    if (bb) await page.screenshot({ path: `${OUT}/${key}-banner.png`, clip: { x: bb.x - 8, y: bb.y - 8, width: Math.min(530, bb.width + 16), height: bb.height + 16 } });
    const rb = null;
    marks[key] = { row: rb, errors: errors.slice(0, 3) };
    console.log(key, errors.slice(0, 2).join(' | '));
    await context.close();
  }
} finally {
  fs.writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 1));
  await browser.close();
}
