// The board's capture kit (docs/mocks/project-main-branch: lib.mjs), pointed at the session's own
// tree: the real session page and project page on vite (:5662), fed by the repo's ui-migration
// fixtures plus the board's payments project whose repository's main branch is `master`. The data is
// the board's, with what the shipped server serves beside it: the project's `repository`, and the
// memory fields (`lastMainBranch`, `upstreamChosenAt`) on every integration view.
import { chromium } from '/root/.orbit/worktrees/afe31010-6ea1-5a82-a79c-06e2e13cda3c/node_modules/playwright/index.mjs';
import { installFixtures, installFixedDate, FIXED_NOW, FIXTURE_IDS, PATHS } from '/root/.orbit/worktrees/afe31010-6ea1-5a82-a79c-06e2e13cda3c/src/web/ui-migration/fixtures.mjs';
import { SESSION, SESSION_PATH, WORKSPACE } from '/root/.orbit/worktrees/afe31010-6ea1-5a82-a79c-06e2e13cda3c/src/web/ui-migration/session-fixtures.mjs';

export const BASES = { real: 'http://127.0.0.1:5662' };
export { SESSION_PATH, PATHS, FIXTURE_IDS };

const ago = (ms) => new Date(Date.parse(FIXED_NOW) - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ── The project the coordinator asks to start ───────────────────────────────────────────────────

export const PROJECT = '34cfQ7mPaYmN2Wd8Rk3Jt';
const SEAL = `5d1a09c3be42${'4'.repeat(52)}`;
const WORKSPACE_NAME = 'payments-api';
export const BRANCHES = { names: ['develop', 'master', 'release/2.4'], workspaceName: WORKSPACE_NAME, reportedAt: ago(2 * MIN) };

export const WHY =
  '计划已写好：4 个任务覆盖 3 条验收标准。G2、G3 都依赖 G1 的网关客户端，所以走项目分支，同时最多 2 个；合并检查用 make test；Automatic 开着。这个仓库的主分支是 master（origin/HEAD），项目最后合进 master。';

const CRITERIA = [
  '下单、退款、对账三条链路全部走新网关，旧网关的调用点清零。',
  '签名、重试和幂等键与网关文档一致，联调环境的用例全部通过。',
  '灰度开关可按商户切换，回滚只需改一个配置。',
].map((text, at) => ({ id: `c${at + 1}`, ordinal: at + 1, text }));

const TASKS = [
  ['g1', 'G1 · 网关客户端：签名、重试、幂等键'],
  ['g2', 'G2 · 下单与退款切到新网关'],
  ['g3', 'G3 · 对账任务改读新网关流水'],
  ['g4', 'G4 · 按商户灰度，演练一次回滚', 'OWNER_CONFIRMED'],
];
const EDGES = [['g1', 'g2'], ['g1', 'g3'], ['g2', 'g4'], ['g3', 'g4']];
function graphOf(tasks, edges) {
  const first = tasks[0][0];
  return {
    marks: tasks.map(([id, title, completionCriterion = 'EVIDENCE_JUDGMENT']) => ({
      kind: 'TASK', id, taskId: id, title, status: 'OPEN', parentTaskId: null, completionCriterion, autoRunWhenReady: true,
      workState: id === first ? 'READY' : 'BLOCKED',
      dependencyState: id === first ? 'NONE' : 'BLOCKED',
      running: false,
      queued: false,
      prerequisiteCount: edges.filter(([, to]) => to === id).length,
      dependentCount: edges.filter(([from]) => from === id).length,
    })),
    edges: edges.map(([sourceMarkId, targetMarkId]) => ({ sourceMarkId, targetMarkId })),
    taskCount: tasks.length,
    folded: false,
    truncated: false,
    limits: { maxTasks: 500, maxMarks: 500 },
  };
}
const GRAPH = graphOf(TASKS, EDGES);

const standing = {
  state: 'UNCONFIRMED',
  confirmed: false,
  currentVersion: { digest: SEAL, material: CRITERIA.map((c) => ({ definitionId: c.id, revision: 1, contentHash: `h${c.ordinal}` })) },
  confirmation: null,
  changesSinceConfirmed: null,
  changesSinceConfirmedAbsentReason: 'NEVER_CONFIRMED',
};

const startDocument = {
  id: PROJECT,
  title: '订单服务接入新支付网关',
  status: 'OPEN',
  coordinatorEnabled: false,
  coordinatorSessionId: SESSION.id,
  exceptionEscalationSeconds: 7_200,
  maxConcurrentTasks: 2,
  startedAt: null,
  _count: { tasks: TASKS.length },
  acceptanceCriteriaItems: CRITERIA,
};

/** The coordinator's start request. `suggestMain` false: a coordinator that names no main branch
 *  (today's tool cannot) — the card then shows the project's own, main. */
function startRow({ suggestMain, project = PROJECT, why = WHY, seal = SEAL, maxConcurrentTasks = 2 }) {
  return {
    itemId: 'item-start-1',
    kind: 'START_REQUEST',
    title: 'Start this project?',
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    waitingSince: ago(35_000),
    escalateAt: null,
    escalatedAt: null,
    taskId: null,
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    question: null,
    facts: null,
    startRequest: {
      settings: {
        line: 'PROJECT_BRANCH',
        projectBranchName: `refs/heads/project/${project}`,
        ...(suggestMain ? { upstreamRef: 'refs/heads/master' } : {}),
        automatic: true,
        maxConcurrentTasks,
        mergeCheckCommand: 'make test',
      },
      why,
      criteriaDigest: seal,
      planDigest: 'p'.repeat(64),
      repository: 'https://git.example.com/acme/payments-api.git',
      warnings: [],
    },
  };
}

/** What the owner chose for the first project in acme/payments-api, two days ago: master. */
export const REMEMBERED = { branch: 'master', repository: 'acme/payments-api', chosenAt: ago(2 * DAY) };

/** A second project in the same repository, which starts after that choice. Its coordinator names
 *  no main branch — the card starts from the one remembered for the repository. */
const SECOND = {
  id: '34cgX2kLmQ9vRb4TnW7Ha',
  title: '退款对账报表上线',
  why: '计划已写好：3 个任务覆盖 2 条验收标准，一个接一个做，走项目分支，同时最多 1 个；合并检查用 make test。',
  criteria: [
    '财务每天 9 点前收到前一天的退款对账报表，金额与网关流水逐笔对得上。',
    '对不上的退款单单独列出，带订单号和网关流水号。',
  ].map((text, at) => ({ id: `d${at + 1}`, ordinal: at + 1, text })),
  tasks: [
    ['r1', 'R1 · 报表数据：按天汇总退款与网关流水'],
    ['r2', 'R2 · 对不上的单子单独列出'],
    ['r3', 'R3 · 定时发送与权限'],
  ],
  edges: [['r1', 'r2'], ['r2', 'r3']],
};

/** The line of a project nobody has started: undecided, bound to nothing yet. */
const unstartedIntegration = {
  line: null, lineAbsentReason: 'NOT_DECIDED', ref: null, upstreamRef: null, source: null,
  locked: false, startedAt: null, mergeCheckCommand: null, mergeCheckCommandAbsentReason: 'NOT_CONFIGURED',
  mergeCheckTimeoutSeconds: null, escalationSeconds: 7200, commitsAheadOfUpstream: null,
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED', integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN',
  inFlight: null, branches: BRANCHES, repository: 'acme/payments-api', upstreamChosenAt: null, lastMainBranch: null,
};

const TURN = 'turnCoordinator';
const EVENTS = [
  { seq: 1, type: 'user', payload: { text: '按这个拆，开始吧。' }, turnId: TURN, ts: FIXED_NOW },
  { seq: 2, type: 'assistant', payload: { text: '计划已写好，已经请求开始：\n\n- 4 个任务 G1–G4，覆盖 3 条验收标准\n- 走项目分支，同时最多 2 个；合并检查 `make test`\n- 这个仓库的主分支是 `master`\n\n请在下面的卡片上确认开始。' }, turnId: TURN, ts: FIXED_NOW },
  { seq: 3, type: 'turn_end', payload: { subtype: 'success', numTurns: 1 }, turnId: TURN, ts: FIXED_NOW },
];

const session = {
  ...SESSION,
  title: '支付网关迁移 · 协调',
  workspace: { ...WORKSPACE, name: WORKSPACE_NAME },
  projectId: PROJECT,
  pendingApprovals: 0,
  engineTurnActive: false,
};

// ── The started project, on its own page (the fixtures' project, renamed) ───────────────────────

const earlier = '2026-09-27T10:00:00.000Z';
const P2 = FIXTURE_IDS.project;
const pageProject = {
  id: P2, title: '订单服务接入新支付网关', status: 'OPEN',
  goal: '订单服务的下单、退款和对账全部切到新支付网关，可按商户灰度、可回滚。',
  instructions: null,
  acceptanceCriteriaItems: CRITERIA.map((c) => ({ ...c, key: c.id, revision: 1, landing: 'UNKNOWN', satisfied: false })),
  createdAt: earlier, updatedAt: earlier, lastActivityAt: FIXED_NOW, _count: { tasks: 4 },
  tasksByStatus: { OPEN: 3, DONE: 1 },
  buckets: { running: 0, ready: 1, blocked: 2, awaitingVerification: 0, done: 1, failed: 0, cancelled: 0 },
  attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, attentionSinceAt: null, nextCheckAt: null, ownerItems: [], coordinatorItems: null, startRequest: null },
  coordinatorEnabled: true, coordinatorSessionId: null,
  maxConcurrentTasks: 2, configRevision: '4', startedAt: earlier, pausedAt: null,
  exceptionEscalationSeconds: 7200,
  blockers: { open: [], resolved: [], resolvedCount: 0 },
};

/** Started on a project branch, main branch `master` (set at a terminal today, on the card tomorrow). */
const pageIntegration = {
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: `project/${P2}`, upstreamRef: 'master', source: 'EXPLICIT',
  locked: false, startedAt: null, mergeCheckCommand: 'make test', mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: null, escalationSeconds: 7200, commitsAheadOfUpstream: null,
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET', lastUpstreamSyncAt: null,
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED', integratingCount: 0, queuedCount: 0, mergeCheckOnTip: 'UNKNOWN',
  inFlight: null, inFlightJobs: [], landTasks: [], branches: BRANCHES, repository: 'acme/payments-api',
  lastMainBranch: REMEMBERED, upstreamChosenAt: ago(2 * DAY),
};
/** …and three days into integrating: the line and its main branch locked. */
const lockedIntegration = {
  ...pageIntegration,
  locked: true, startedAt: ago(3 * DAY), commitsAheadOfUpstream: 3, commitsAheadOfUpstreamAbsentReason: null,
  lastUpstreamSyncAt: ago(2 * HOUR), lastUpstreamSyncAbsentReason: null, mergeCheckOnTip: 'PASSING',
};

// ── Pages ───────────────────────────────────────────────────────────────────────────────────────

export async function launch() {
  return chromium.launch({ env: { ...process.env, FONTCONFIG_FILE: '/var/tmp/upstream-branch-mock/fonts.conf' } });
}

async function context(browser, { width, height }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  await installFixedDate(page);
  const api = await installFixtures(page, { theme: 'light' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, api, errors };
}

async function settle(page, css) {
  if (css) await page.addStyleTag({ content: css });
  // The boot splash fades out over the first frames; a shot taken under it carries its ghost.
  await page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** The coordinator conversation, with "Start this project?" standing. */
/** Everything the start card reads, for the first project or — `second` — the next one in the repo. */
function startData({ second, suggestMain }) {
  if (!second) {
    return { id: PROJECT, document: startDocument, standing, graph: GRAPH, integration: unstartedIntegration,
      row: startRow({ suggestMain }), session };
  }
  const seal = `7b2e44d0a913${'6'.repeat(52)}`;
  return {
    id: SECOND.id,
    document: { ...startDocument, id: SECOND.id, title: SECOND.title, maxConcurrentTasks: 1,
      _count: { tasks: SECOND.tasks.length }, acceptanceCriteriaItems: SECOND.criteria },
    standing: { ...standing, currentVersion: { digest: seal, material: SECOND.criteria.map((c) => ({ definitionId: c.id, revision: 1, contentHash: `h${c.ordinal}` })) } },
    graph: graphOf(SECOND.tasks, SECOND.edges),
    integration: { ...unstartedIntegration, lastMainBranch: REMEMBERED },
    row: startRow({ suggestMain: false, project: SECOND.id, why: SECOND.why, seal, maxConcurrentTasks: 1 }),
    session: { ...session, title: '退款对账 · 协调', projectId: SECOND.id },
  };
}

export async function openStartCard(browser, { base, width = 1440, height = 1300, suggestMain = true, second = false, css, integration = {} }) {
  const D = startData({ second, suggestMain });
  D.integration = { ...D.integration, ...integration };
  const { ctx, page, api, errors } = await context(browser, { width, height });
  const extra = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (req.method() !== 'GET') return route.fallback();
    if (path === `/api${SESSION_PATH}/events/page`) return json({ events: EVENTS, hasMore: false });
    if (path === `/api${SESSION_PATH}`) return json(D.session);
    if (path === '/api/sessions') return json([D.session]);
    if (path === '/api/workspaces') return json([{ ...WORKSPACE, name: WORKSPACE_NAME }]);
    const P = `/api/projects/${D.id}`;
    if (path === P) return json(D.document);
    if (path === `${P}/acceptance/criteria-decisions/pending`) {
      return json({ readAt: FIXED_NOW, projectId: D.id, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [] });
    }
    if (path === `${P}/promotions/current`) return json(null);
    if (path === `${P}/promotions/merged`) return json([]);
    if (path === `${P}/acceptance/confirmation`) return json(D.standing);
    if (path === `${P}/open-items`) return json({ needsYou: [], withCoordinator: [], startRequest: D.row });
    if (path === `${P}/dependency-graph`) return json(D.graph);
    if (path === `${P}/integration`) return json(D.integration);
    if (path.startsWith(P)) {
      extra.push(path);
      return route.fulfill({ status: 404, json: { message: 'not in this mock' } });
    }
    return route.fallback();
  });
  await page.goto(base + SESSION_PATH);
  await page.locator('.start-card').waitFor();
  await page.locator('.start-card-level, .start-card .react-flow__node').first().waitFor();
  await settle(page, css);
  return { ctx, page, api, errors, extra };
}

/** The project's own page, started; `locked` three days into integrating. */
export async function openProjectPage(browser, { base, width = 1280, height = 2200, locked = false, css, integration = {} }) {
  const { ctx, page, api, errors } = await context(browser, { width, height });
  const extra = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, json: body });
    if (req.method() !== 'GET') return route.fallback();
    const P = `/api/projects/${P2}`;
    if (path === P) return json(pageProject);
    if (path === `${P}/integration`) return json({ ...(locked ? lockedIntegration : pageIntegration), ...integration });
    if (path === '/api/projects/sidebar') return json([{ ...pageProject }]);
    return route.fallback();
  });
  await page.goto(base + PATHS.project);
  await page.locator('.project-run-settings .project-run-settings-grid').waitFor();
  await page.locator('.project-integration').first().waitFor();
  await settle(page, css);
  return { ctx, page, api, errors, extra };
}

export async function rect(page, selector) {
  return page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().toJSON());
}
