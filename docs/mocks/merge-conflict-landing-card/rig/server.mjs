// Fake control plane for rendering the real web console with fixed data (mock screenshots only).
// Data: project 34ZZeq0e3IR65GVm2kAs7 as it stood at 2026-10-06 23:44Z — P3.2's first landing
// stopped at a conflict in AccountSelect.tsx (21:34), the coordinator sent P3.2 back (21:37), and
// round 2 has been merging main since. Times are relative to the server's start, so the console's
// "2h ago" labels match the screenshot moment.
// Scenarios (GET /api/__scenario?name=…): fixing (default) | escalated | relanding | landed
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3997);
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const b62 = (hex) => { let n = BigInt('0x' + hex); let o = ''; while (n > 0n) { o = ALPHABET[Number(n % 62n)] + o; n /= 62n; } return o; };
let n = 0;
const uid = () => b62(`0195c0de00007000800${String(++n).padStart(13, '0')}`);
let T0 = Date.now();
const ago = (min) => new Date(T0 - min * 60_000).toISOString();

const USER = uid();
const R_HPC = uid();
const WS = uid();
const P = uid();
const C = uid();      // coordinator conversation
const R2 = uid();     // P3.2 round 2 (the fix)
const R1 = uid();     // P3.2 round 1 (the delivery that conflicted)
const T32 = uid();
const ITEM = uid();
const PROJECT_TITLE = 'Orbit Web 组件迁移：Base UI + Orbit 自有组件';
const P32 = 'P3.2 迁移任务详情、分享与任务附件试点';

const RUNNERS = [{
  id: R_HPC, name: 'HPC', online: true, maxConcurrent: 6, activeSessions: 2, status: 'ONLINE', version: '0.1.215',
  capabilities: ['session-move/v1'], lastHeartbeatAt: ago(0),
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }, { engine: 'codex', installed: true, auth: 'yes' }],
}];
const WORKSPACES = [{ id: WS, name: 'orbit-develop', runnerId: R_HPC, createdAt: ago(60 * 24 * 30), lastProvider: 'claude', position: 0, enabled: true }];

const member = (role) => ({ projectId: P, projectTitle: PROJECT_TITLE, projectStatus: 'OPEN', role });
const session = (o) => ({
  workspaceId: WS, workspace: { id: WS, name: 'orbit-develop' }, runnerId: R_HPC, assignedRunnerId: R_HPC, provider: 'claude',
  model: 'claude-opus-5-5', status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', lifecycleState: 'OPEN',
  sessionState: 'AWAITING_INPUT', filingState: 'OPEN', pendingApprovals: 0, createdAt: ago(60 * 30), updatedAt: ago(5), pinnedAt: null,
  tags: [], agentId: null, agent: null, ...o,
});
const done = { status: 'COMPLETED', runStatus: 'SUCCEEDED', runState: 'COMPLETED', lifecycleState: 'COMPLETED', sessionState: 'COMPLETED', filingState: 'ARCHIVED', view: 'completed' };
const running = { status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', sessionState: 'RUNNING' };

let scenario = 'now';
const sessions = () => {
  const s = [
    session({ id: C, title: PROJECT_TITLE, projectMembership: member('COORDINATOR'), lastTurnAt: ago(scenario === 'landed' ? 20 : scenario === 'relanding' ? 3 : scenario === 'escalated' ? 95 : 127), createdAt: ago(60 * 7),
      lastAssistantText: scenario === 'landed'
        ? 'P3.2 已落到项目分支。P3.3 可以开始了，我先起 P3.3。'
        : scenario === 'escalated' ? 'P0 漂移登记第 2 批已建任务，等 P2.3 回归修复落地后再跑。'
        : scenario === 'relanding' ? 'P3.2 第 2 版证据核对通过，Orbit 正在第 2 次落地。'
        : 'P3.2 已退回：先合入最新 main、解掉 AccountSelect.tsx 的冲突，再复验受影响的部分。' }),
    session({ id: R1, taskId: T32, title: `执行任务：${P32}`, projectMembership: member('TASK'), lastTurnAt: ago(131), createdAt: ago(60 * 14 + 42), ...done,
      lastAssistantText: 'Evidence submitted: pilot 64/64, 240 screenshots graded, 56 traces identical.' }),
    session({ id: uid(), taskId: uid(), title: '执行任务：P0 基线漂移归因与参考维护（不改 P0.2 原图）', projectMembership: member('TASK'), lastTurnAt: ago(63), ...done,
      lastAssistantText: '漂移已归因：字体 hinting 与 1px 舍入，参考图未改动。' }),
    session({ id: uid(), taskId: uid(), title: '执行任务：P3.1 实现自动增高输入框并验证会话兼容', projectMembership: member('TASK'), lastTurnAt: ago(60 * 14 + 47), ...done,
      lastAssistantText: '自动增高输入框已接入会话，8 环境截图一致。' }),
    session({ id: uid(), taskId: uid(), title: '执行任务：P2 修复：Select 快速连按 ↓↓⏎ 时重选当前值', projectMembership: member('TASK'), lastTurnAt: ago(60 * 15 + 3), ...done,
      lastAssistantText: '快速连按不再重选当前值，加了回归用例。' }),
    session({ id: uid(), taskId: uid(), title: '执行任务：P2.2 实现菜单、浮层与选择控件', projectMembership: member('TASK'), lastTurnAt: ago(60 * 17 + 3), ...done,
      lastAssistantText: 'Menu、Popover、Select 已实现，与 AntD 对照通过。' }),
  ];
  if (scenario !== 'escalated') {
    s.splice(1, 0, session({ id: R2, taskId: T32, title: `执行任务：${P32}`, projectMembership: member('TASK'), createdAt: ago(127),
      ...(scenario === 'fixing' || scenario === 'now' ? { ...running, lastTurnAt: ago(1), lastToolUse: 'Bash',
        lastAssistantText: 'Composer: the motion test repeated 5/5 on main and 5/5 on the delivery. The toasts repeats are now running.' }
        : { ...done, lastTurnAt: ago(scenario === 'landed' ? 21 : 6),
          lastAssistantText: 'Round 2 evidence: merged main (3c1b24f), AccountSelect.tsx keeps main’s Antigravity states; merge check green.' }) }));
  }
  return s;
};

const sidebar = () => [{
  id: P, title: PROJECT_TITLE, status: 'OPEN', createdAt: ago(60 * 24 * 3), startedAt: ago(60 * 24 * 3 - 60), lastActivityAt: ago(1),
  buckets: { running: scenario === 'fixing' || scenario === 'now' ? 1 : 0 },
  taskCounts: { done: scenario === 'landed' ? 14 : 13, failed: 0, total: 29 },
  attention: { ownerItems: scenario === 'escalated' || scenario === 'now' ? [{ kind: 'ESCALATED', count: 1, oldestWaitingSince: ago(130) }] : [], startRequest: null, coordinatorItems: [] },
  coordinatorActivity: null,
  integration: { line: 'PROJECT_BRANCH', ref: 'project/34ZZeq0e3IR65GVm2kAs7', activeJobCount: scenario === 'relanding' ? 1 : 0,
    inFlight: scenario === 'relanding' ? { taskTitle: P32, kind: 'LAND_TASK', phase: 'CHECK', state: 'RUNNING', startedAt: ago(2.2), heartbeatAt: ago(0) } : null },
}];

const integration = () => ({
  line: 'PROJECT_BRANCH', lineAbsentReason: null, ref: 'project/34ZZeq0e3IR65GVm2kAs7', upstreamRef: 'main', source: 'EXPLICIT', locked: true,
  startedAt: ago(60 * 24 * 3), mergeCheckCommand: 'npm run build -w @orbit/web && npm run test -w @orbit/web', mergeCheckCommandAbsentReason: null,
  mergeCheckTimeoutSeconds: null, escalationSeconds: 7200, commitsAheadOfUpstream: 41, commitsAheadOfUpstreamAbsentReason: null,
  lastUpstreamSyncAt: ago(60 * 5), lastUpstreamSyncAbsentReason: null,
  integratingCount: scenario === 'relanding' ? 1 : 0, queuedCount: 0, mergeCheckOnTip: 'PASSED',
  inFlight: scenario === 'relanding'
    ? { jobId: uid(), kind: 'LAND_TASK', taskId: T32, taskTitle: P32, phase: 'CHECK', state: 'RUNNING', generation: '2',
        queuedAt: ago(2.6), startedAt: ago(2.2), heartbeatAt: ago(0), outputAt: ago(0.1), checksRunningForMs: 132000, medianCheckMs: 18 * 60000, budgetMs: 60 * 60000 }
    : null,
  landTasks: [],
});

const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const ITEM_TITLE = `Merge conflict: ${P32}`;
const FILES = ['src/web/src/components/AccountSelect.tsx'];
const TARGET = 'refs/heads/project/34ZZeq0e3IR65GVm2kAs7';
// The agent prose the coordinator was handed (abridged from openItemMessage's shape).
const ITEM_PROSE = `【例外待办 · 合并冲突】任务「${P32}」落到 ${TARGET} 时停在冲突上（阶段 REBASE），目标分支没有移动。\n冲突文件：${FILES[0]}\n平台不会自己重试。可用的门：task_reopen（退回任务并附说明）、task_create（fixesOpenItemId 指向本待办）、task_update 取消任务。`;
const deliveryEvent = () => ({
  seq: 3, type: 'user', turnId: 't-item', ts: ago(130),
  payload: { text: ITEM_PROSE, openItemDelivery: {
    itemId: ITEM, kind: 'INTEGRATION_CONFLICT', title: ITEM_TITLE, task: { id: T32, title: P32, sessionId: R1 }, files: FILES,
    targetRef: TARGET, check: null, errorCode: null, failure: null, actions: ['RETRY', 'CANCEL_TASK'],
    landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: 'project/34ZZeq0e3IR65GVm2kAs7' },
  } },
});
const escalatedRow = () => ({
  itemId: ITEM, kind: 'INTEGRATION_CONFLICT', title: ITEM_TITLE, detailLine: '', assignee: 'OWNER', assigneeReason: 'ESCALATED',
  waitingSince: ago(130), escalateAt: null, escalatedAt: ago(2), taskId: T32, sessionId: R1, promotionId: null, fuseEpisodeId: null,
  delivery: { state: 'DELIVERED', sessionId: C, at: ago(130) },
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  requiredAction: 'This task cannot reach the project branch until its merge conflict is repaired — fix the task branch or ask the coordinator to do it.',
  primaryAction: 'ASK_COORDINATOR_AGAIN', question: null,
  facts: { task: { id: T32, title: P32 }, targetRef: TARGET, targetSha: 'da13423d3f7c', files: FILES, nothingLanded: true, check: null,
    branchUnchanged: false, errorCode: null, failure: null, review: null },
  handling: null, outcome: null, handoverNote: null, chat: { sessionId: C, stage: 'WITH_OWNER', refusal: null },
});
const SEND_BACK = { seq: 4, type: 'assistant', payload: { text: '第 1 代落地卡在冲突上：已交付分支 orbit/p3-2-2b837b 和 main（f33589b4c）在 src/web/src/components/AccountSelect.tsx 冲突——main 的 712d324a8 给 AccountSelect 加了 Antigravity 多账号。项目分支本身和 main 不冲突。\n\n已退回 P3.2：这一轮只合入最新 main、解掉冲突、复验受影响的部分；已交付的试点不用重做。' }, turnId: 't2', ts: ago(127) };
const EVENTS = () => {
  const head = [
    { seq: 1, type: 'user', payload: { text: 'P3.2 的证据看完了吗？没问题就让它先落到项目分支。' }, turnId: 't1', ts: ago(140) },
    { seq: 2, type: 'assistant', payload: { text: 'P3.2 的第 1 版证据核对通过：试点 64/64、240 张截图分级、56 条 trace 请求逐步相同。已判定 DONE，Orbit 正在把它落到项目分支。' }, turnId: 't1', ts: ago(131) },
  ];
  if (scenario === 'now') return [...head, deliveryEvent(), SEND_BACK];
  if (scenario === 'escalated') return [...head,
    { seq: 5, type: 'assistant', payload: { text: 'P0 漂移登记第 2 批已建任务（profile、wiki 场景与 959 断点），等 P2.3 回归修复落地后再跑。' }, turnId: 't3', ts: ago(95) }];
  if (scenario === 'relanding') return [...head, SEND_BACK,
    { seq: 6, type: 'assistant', payload: { text: 'P3.2 第 2 版证据核对通过：合入 main（3c1b24f）后 AccountSelect.tsx 保留了 main 的 Antigravity 状态和额度文案，合并检查通过。已判定 DONE，Orbit 正在第 2 次落地。' }, turnId: 't4', ts: ago(3) }];
  if (scenario === 'landed') return [...head, SEND_BACK,
    { seq: 6, type: 'assistant', payload: { text: 'P3.2 第 2 版证据核对通过：合入 main（3c1b24f）后 AccountSelect.tsx 保留了 main 的 Antigravity 状态和额度文案，合并检查通过。已判定 DONE，Orbit 正在第 2 次落地。' }, turnId: 't4', ts: ago(25) },
    { seq: 7, type: 'assistant', payload: { text: 'P3.2 已落到项目分支。P3.3 和「登记 P3.2 已接受的 P0 迁移差异」可以开始了，我先起 P3.3。' }, turnId: 't5', ts: ago(20) }];
  return [...head, SEND_BACK];
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.replace(/^\/api/, '');
  if (p === '/events' || /\/events$/.test(p) || p.endsWith('/stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    const t = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(t));
    return;
  }
  if (p === '/__scenario') { scenario = url.searchParams.get('name') ?? 'now'; T0 = Date.now(); return json(res, { scenario }); }
  if (p === '/__ids') return json(res, { P, C, R1, R2, T32, ITEM, WS });
  console.log(req.method, url.pathname + url.search);
  if (p === '/auth/setup-status') return json(res, { needsSetup: false });
  if (p === '/users/me') return json(res, { id: USER, email: 'owner@example.com', name: 'Owner', createdAt: ago(60 * 24 * 90), preferences: {}, isAdmin: true, role: 'ADMIN' });
  if (p === '/runners') return json(res, RUNNERS);
  if (p === '/workspaces') return json(res, WORKSPACES);
  if (p === '/providers' || p === '/session-tags' || p === '/session-folders') return json(res, []);
  if (p === '/sessions/counts') return json(res, [{ workspaceId: WS, active: 1, running: scenario === 'fixing' || scenario === 'now' ? 1 : 0, jobs: 0, approvals: 0, open: 3 }]);
  if (p === '/projects/sidebar') return json(res, sidebar());
  if (p === '/projects') return json(res, sidebar());
  const pm = p.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (pm && pm[1] === P) {
    const rest = pm[2] ?? '';
    if (rest === '') return json(res, { id: P, title: PROJECT_TITLE, status: 'OPEN', tasksByStatus: { DONE: scenario === 'landed' ? 14 : 13, OPEN: scenario === 'landed' ? 15 : 16, CANCELLED: 1 },
      coordinatorSessionId: C, coordinatorWorkspaceId: WS, startedAt: ago(60 * 24 * 3 - 60), acceptanceCriteriaItems: [] });
    if (rest === '/integration') return json(res, integration());
    if (rest === '/promotions/current') return json(res, null);
    if (rest === '/promotions/merged') return json(res, []);
    if (rest === '/open-items') return json(res, { needsYou: scenario === 'now' ? [escalatedRow()] : [], withCoordinator: [], settled: [], startRequest: null, doneRequest: null });
    if (rest === '/acceptance/criteria-decisions/pending') return json(res, { projectId: P, readAt: new Date().toISOString(), count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] });
    if (rest === '/coordinator/status') return json(res, { message: 'not stubbed' }, 404);
    if (rest.startsWith('/tasks')) return json(res, { items: [], nextCursor: null });
    return json(res, []);
  }
  const m = p.match(/^\/sessions\/([^/]+)(\/.*)?$/);
  if (m && m[1] !== 'search' && m[1] !== 'counts') {
    const s = sessions().find((x) => x.id === m[1]);
    const rest = m[2] ?? '';
    if (rest.includes('/events/page')) return json(res, { events: s?.id === C ? EVENTS() : [], hasMore: false });
    if (rest.includes('/diff')) return json(res, { files: [] });
    if (rest.includes('/created-tasks')) return json(res, { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
    if (rest) return json(res, []);
    return s ? json(res, s.id === C ? { ...s, projectId: P, projectTitle: PROJECT_TITLE, projectIntegrationRef: 'project/34ZZeq0e3IR65GVm2kAs7' } : s) : json(res, { message: 'not found' }, 404);
  }
  if (p === '/sessions/search') return json(res, { q: '', contentSearched: false, total: 0, hits: [] });
  if (p === '/watches') return json(res, []);
  if (p === '/wiki/spaces') return json(res, []);
  if (p === '/providers/pools' || p === '/providers/shared-pools' || p === '/providers/mine') return json(res, []);
  if (p === '/sessions') {
    const view = url.searchParams.get('view') ?? 'open';
    const projectId = url.searchParams.get('projectId');
    const rows = sessions().filter((s) => (!projectId || projectId === P) && (s.view ?? 'open') === (view === 'archived' ? 'trash' : view));
    return json(res, rows);
  }
  if (p.startsWith('/tasks/evidence-decisions/pending')) return json(res, { decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
  if (p.startsWith('/tasks/page')) return json(res, { items: [], nextCursor: null });
  if (p.startsWith('/tasks')) return json(res, { items: [], total: 0, counts: {} });
  return json(res, []);
});
server.listen(PORT, '127.0.0.1', () => console.log('fake api on', PORT));
