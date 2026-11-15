// The repair-row board: the real session page (WorkspaceView + SessionOutputs) of this worktree on vite, fed by the
// repo's ui-migration fixtures plus a session shaped like the owner's 2026-11-14 screenshot: a coordinator's branch bar
// with a PREVIEW_CHANGED check that would push 10 commits to origin/main, 7 remote-only, and a repair session running.
const WT = '/root/.orbit/worktrees/01a1d8e5-23c8-761d-ad9c-9170694723ee';
const { chromium } = await import(`${WT}/node_modules/playwright/index.mjs`);
const { installFixtures, installFixedDate } = await import(`${WT}/src/web/ui-migration/fixtures.mjs`);
const { SESSION, SESSION_PATH, WORKSPACE, RUNNER } = await import(`${WT}/src/web/ui-migration/session-fixtures.mjs`);

export const BASE = process.env.BASE ?? 'http://127.0.0.1:5811';
export { SESSION_PATH };

const ws = { ...WORKSPACE, name: 'orbit-develop' };
// Fixtures freeze the clock at 2026-09-28T12:00Z.
const ago = (min) => new Date(Date.parse('2026-09-28T12:00:00Z') - min * 60_000).toISOString();
const MODELS = [{ label: 'Opus 5.5', value: 'claude-opus-5-5', contextWindow: 1_000_000 }];

const T = 'turnA';
export const EVENTS = [
  { type: 'user', payload: { text: 'Land the SubAgent project onto main.' }, turnId: T, ts: ago(70) },
  { type: 'assistant', payload: { text: 'Checking the project line against origin/main before the merge.' }, turnId: T, ts: ago(69) },
  { type: 'tool_use', payload: { id: 'a1', name: 'Bash', input: { command: 'git fetch origin && git log --oneline main..origin/main | wc -l', description: 'Count the commits origin/main has that local main lacks' } }, turnId: T, ts: ago(68) },
  { type: 'tool_result', payload: { toolUseId: 'a1', content: '7' }, turnId: T, ts: ago(68) },
  { type: 'assistant', payload: { text: 'Local main is 7 behind origin/main, and two files conflict with it: `src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts` and `src/web/src/components/Transcript.tsx`. I started a repair session to resolve them in a separate worktree; Orbit checks the branches again when it stops.' }, turnId: T, ts: ago(52) },
  { type: 'turn_end', payload: {}, turnId: T, ts: ago(51) },
].map((e, i) => ({ ...e, seq: i + 1 }));

const SUBJECTS = [
  ['Merge origin/main into main', 'merge'], ['docs(subagent): leave the board\'s PNG renders out of this landing', 'session'],
  ['Merge origin/main into main', 'merge'], ['Merge origin/main into main', 'merge'], ['Merge origin/main into main', 'merge'],
  ['docs(subagent): cross-workspace SubAgents run on the target\'s own HEAD and return text only', 'session'],
  ['docs(subagent): record the owner\'s decisions on cost order, default and background turns', 'session'],
  ['docs: design SubAgent, a routed sub-agent that works in the parent\'s worktree', 'session'],
  ['Merge origin/main into main', 'merge'], ['Merge remote main 773b21a0a into local main c5be62a60', 'merge'],
];
const MINS = [50, 50, 180, 240, 300, 4320, 4320, 4320, 960, 960];
const sha = (i, c) => (c.repeat(8) + String(i)).padEnd(40, '0').slice(0, 40);
const pushCommits = SUBJECTS.map(([subject, kind], i) => ({ sha: sha(i, 'a1b2c3d4'[i % 8]), subject, author: 'coordinator', date: ago(MINS[i]), merge: kind === 'merge' }));
const remoteCommits = Array.from({ length: 7 }, (_, i) => ({ sha: sha(i, 'f'), subject: `feat(web): remote change ${i + 1}`, author: 'owner', date: ago(30 + i * 20) }));

export function recovery(over = {}) {
  return {
    code: 'PREVIEW_CHANGED', targetBranch: 'main', previewId: 'p1', checkedAt: ago(50),
    sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40),
    localCommits: [], remoteCommits, pushCommits, addsMergeCommit: false,
    repairWorktree: '/home/orbit/.orbit/recovery/p1', repairBranch: 'orbit/recovery/p1', ...over,
  };
}
export const REPAIR = { id: 'rep1', title: 'Resolve the merge conflict and restore main', runState: 'RUNNING', status: 'RUNNING', lastTurnAt: ago(1) };

const files = ['docs/subagent-design.md', 'docs/mocks/subagent/01-board.html', 'docs/mocks/subagent/02-flow.html', 'src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts',
  'src/web/src/components/Transcript.tsx', 'docs/subagent-decisions.md', 'docs/subagent-costs.md', 'docs/subagent-cross-workspace.md', 'README.md']
  .map((path, i) => ({ path, additions: [212, 120, 96, 61, 44, 70, 38, 40, 10][i], deletions: 0, status: 'M' }));

const sessionRow = (over) => ({
  ...SESSION, workspace: ws, workspaceId: ws.id, pendingApprovals: 0, engineTurnActive: false,
  status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN', pinnedAt: null, provider: 'claude',
  model: 'claude-opus-5-5', effort: 'max', tags: [], folderId: null, shared: false,
  title: 'SubAgent: routed sub-agents in the parent\'s worktree', lastTurnAt: ago(51), updatedAt: ago(1),
  isolationStatus: 'worktree', branch: 'orbit/task-agent-provider-agent-7a255f', changedFiles: files, worktreeDirty: false,
  mergeTarget: 'main', mergeTargets: ['main'], mergeRecovery: recovery(), mergeRecoverySupported: true, mergeRepairSession: REPAIR,
  mergeStatus: 'idle', ...over,
});

export async function launch() {
  return chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/rpr-mock/fonts.conf' } });
}

/** The session page with `over` merged into the session detail. */
export async function open(browser, { over = {}, theme = 'light', size = 'desktop', width, height, css = '' } = {}) {
  const phone = size === 'phone';
  const context = await browser.newContext({
    viewport: phone ? { width: width ?? 390, height: height ?? 844 } : { width: width ?? 1440, height: height ?? 900 },
    deviceScaleFactor: phone ? 3 : 2, isMobile: phone, hasTouch: phone, colorScheme: theme, locale: 'en-US',
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(240_000);
  page.setDefaultTimeout(120_000);
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
  await installFixedDate(page);
  await installFixtures(page, { theme });
  const row = sessionRow(over);
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') return route.fallback();
    if (path === `/api${SESSION_PATH}/events/page`) return route.fulfill({ status: 200, json: { events: EVENTS, hasMore: false } });
    if (path === `/api${SESSION_PATH}`) return route.fulfill({ status: 200, json: row });
    if (path === `/api${SESSION_PATH}/background`) return route.fulfill({ status: 200, json: [] });
    if (path === `/api${SESSION_PATH}/created-tasks`) return route.fulfill({ status: 200, json: { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] } });
    if (path === '/api/sessions') return route.fulfill({ status: 200, json: [row] });
    if (path === '/api/runners') return route.fulfill({ status: 200, json: [{ ...RUNNER, name: 'HPC', modelCatalog: { claude: MODELS } }] });
    if (path === '/api/workspaces') return route.fulfill({ status: 200, json: [ws] });
    return route.fallback();
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE + SESSION_PATH);
  await page.locator('.chat-user-wrap').first().waitFor();
  await page.waitForFunction(() => !document.getElementById('boot'));
  if (css) await page.addStyleTag({ content: css });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await settle(page);
  return { context, page, errors };
}

export const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
