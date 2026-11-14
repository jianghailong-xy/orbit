// Sample account for the 2026-11-07 board (docs/mocks/project-rows-by-workspace): two workspaces,
// three open projects and three finished ones, every coordinator but one in orbit-develop. Made-up
// names and text; the shapes are what GET /sessions, /projects/sidebar and friends answer.
export const NOW = Date.parse('2026-11-07T02:20:00.000Z'); // 10:20 in Asia/Shanghai
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const ago = (ms) => new Date(NOW - ms).toISOString();

export function makeData(uuidToBase62) {
  const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
  const R = {
    hpc: { id: sid(31), name: 'HPC', online: true, maxConcurrent: 4, activeSessions: 3,
      engines: [{ engine: 'claude', installed: true, auth: 'yes' }], commands: [], skills: [] },
    wikova: { id: sid(32), name: 'wikova', online: true, maxConcurrent: 2, activeSessions: 1,
      engines: [{ engine: 'claude', installed: true, auth: 'yes' }], commands: [], skills: [] },
  };
  const W = {
    dev: { id: sid(21), name: 'orbit-develop', runnerId: R.hpc.id, runner: R.hpc, createdAt: ago(60 * DAY),
      lastProvider: 'claude', provider: 'claude', model: null, effort: null },
    prod: { id: sid(22), name: 'orbit-prod', runnerId: R.wikova.id, runner: R.wikova, createdAt: ago(59 * DAY),
      lastProvider: 'claude', provider: 'claude', model: null, effort: null },
  };
  const P = {
    search: { id: sid(201), title: '搜索服务迁移到新索引', status: 'OPEN', counts: { done: 10, failed: 0, total: 12 }, running: 1 },
    android: { id: sid(202), title: 'Android 客户端：与 iOS 体验对齐', status: 'OPEN', counts: { done: 46, failed: 0, total: 56 }, running: 1 },
    google: { id: sid(203), title: 'Google 账号登录与开放注册', status: 'OPEN', counts: { done: 18, failed: 0, total: 22 }, running: 1 },
    installer: { id: sid(204), title: '旧版安装脚本迁移', status: 'DONE', counts: { done: 13, failed: 0, total: 13 }, running: 0 },
    region: { id: sid(205), title: '区域可用性检查', status: 'DONE', counts: { done: 11, failed: 0, total: 11 }, running: 0 },
    multiuser: { id: sid(206), title: '多用户 Runner 架构', status: 'DONE', counts: { done: 3, failed: 0, total: 3 }, running: 0 },
  };

  const rows = [];
  const add = (n, ws, title, o = {}) => {
    const at = o.at ?? ago(MIN);
    const running = o.running === true;
    const completed = o.completed === true;
    const row = {
      id: sid(n), title, workspaceId: ws.id, workspace: { id: ws.id, name: ws.name },
      runnerId: ws.runnerId, assignedRunnerId: ws.runnerId, provider: 'claude', engine: 'claude',
      status: running ? 'RUNNING' : completed ? 'SUCCEEDED' : 'AWAITING_INPUT',
      runState: running ? 'RUNNING' : completed ? 'SUCCEEDED' : 'AWAITING_INPUT',
      runStatus: running ? 'RUNNING' : completed ? 'SUCCEEDED' : 'AWAITING_INPUT',
      sessionState: running ? 'RUNNING' : completed ? 'SUCCEEDED' : 'AWAITING_INPUT',
      lifecycleState: completed ? 'COMPLETED' : 'OPEN', filingState: completed ? 'ARCHIVED' : 'OPEN',
      completedAt: completed ? at : null, archivedAt: null, deletedAt: null,
      createdAt: o.createdAt ?? new Date(Date.parse(at) - 2 * HOUR).toISOString(), updatedAt: at,
      startedAt: o.createdAt ?? new Date(Date.parse(at) - 2 * HOUR).toISOString(),
      engineStartedAt: o.createdAt ?? new Date(Date.parse(at) - 2 * HOUR).toISOString(),
      lastTurnAt: at, shareToken: null, folderId: null, pinnedAt: null, projectMembership: null,
      lastAssistantText: o.reply ?? null, lastUserText: o.unanswered ?? null, lastToolUse: o.tool ?? null,
      prompt: o.prompt ?? title,
      ...(o.extra ?? {}),
    };
    if (o.project) {
      const p = o.project;
      row.projectMembership = { projectId: p.id, projectTitle: p.title, projectStatus: p.status, role: o.role ?? 'TASK' };
      if (o.role === 'COORDINATOR') { row.projectId = p.id; row.projectTitle = p.title; }
    }
    rows.push(row);
    return row;
  };

  // orbit-develop: this conversation's kind of session, and the coordinators.
  const D = {};
  D.review = add(901, W.dev, '复查会话列表的设计', { at: ago(0.4 * MIN), reply: '两个方案都画进效果图了，等你挑。' });
  D.sidebar = add(902, W.dev, '侧栏工作区排序', { at: ago(2 * HOUR), reply: '收到，做 B。先摸清现有代码和约束。' });
  D.logs = add(903, W.dev, '整理 runner 日志轮转', { at: ago(26 * HOUR), reply: '轮转改成按天，保留 14 天。' });
  D.t7 = add(911, W.dev, 'T7 回放对比', { project: P.search, at: ago(1.5 * MIN),
    reply: 'Replay closed at 412/430; evidence submitted.' });
  D.c1 = add(910, W.dev, P.search.title, { project: P.search, role: 'COORDINATOR', running: true, at: ago(1 * MIN),
    createdAt: ago(5 * DAY), reply: 'T6 已合入项目线；等 T7 的回放结果再定上线时间。',
    unanswered: 'Replay closed at 412/430, evidence submitted (revision 1); the replay report is section 5.',
    extra: { lastUserFrom: { sessionId: sid(911), title: 'T7 回放对比' } } });
  D.t8 = add(912, W.dev, 'T8 新索引的分片策略', { project: P.search, running: true, tool: 'Bash', at: ago(3 * MIN) });
  const done = [['T1 新索引的字段映射', 4], ['T2 双写开关', 3.6], ['T3 回填历史数据', 3.2], ['T4 搜索接口切换读源', 2.4],
    ['T5 旧索引改为只读', 1.8], ['T6 回放工具', 1.1]];
  done.forEach(([title, days], i) => add(913 + i, W.dev, title, { project: P.search, completed: true, at: ago(days * DAY),
    reply: '已交付，协调者验收通过。' }));
  D.c2 = add(920, W.dev, P.android.title, { project: P.android, role: 'COORDINATOR', running: true, tool: 'Bash',
    at: ago(0.2 * MIN), createdAt: ago(9 * DAY) });
  D.e3 = add(921, W.dev, 'E3 Android 推送通道', { project: P.android, running: true, tool: 'Edit', at: ago(2 * MIN) });
  D.c3 = add(930, W.dev, P.google.title, { project: P.google, role: 'COORDINATOR', at: ago(5 * MIN), createdAt: ago(6 * DAY),
    reply: '测试客户端已核验，交给 E1 搭隔离机做验证。' });
  D.e1 = add(931, W.dev, 'E1 隔离机上的注册回归', { project: P.google, running: true, tool: 'Bash', at: ago(4 * MIN) });
  D.c4 = add(940, W.dev, P.installer.title, { project: P.installer, role: 'COORDINATOR', at: ago(5 * DAY + 3 * HOUR),
    createdAt: ago(12 * DAY), reply: '13 个任务都已合入 main（3c1e9a0），项目验收通过。' });
  D.c5 = add(950, W.dev, P.region.title, { project: P.region, role: 'COORDINATOR', at: ago(4 * DAY + 6 * HOUR),
    createdAt: ago(10 * DAY), reply: '11 个任务都完成了，验收通过。' });
  // orbit-prod: the owner's own production sessions, and the search project's two production tasks.
  const S = {};
  S.slow = add(960, W.prod, '排查服务响应缓慢', { running: true, tool: 'Bash', at: ago(0.3 * MIN) });
  S.backup = add(961, W.prod, '检查备份磁盘余量', { at: ago(6 * MIN), reply: '根盘剩 31 GB；今晚的全量备份要 14 GB，够用。' });
  S.cert = add(962, W.prod, '证书轮换脚本', { at: ago(15 * MIN), reply: '脚本已改完，dry-run 通过；等你确认后在生产执行。' });
  S.check = add(963, W.prod, '生产只读核查：新索引', { project: P.search, at: ago(22 * MIN),
    reply: '核查完成：新索引的读流量 100%，错误率 0；等协调者验收。' });
  S.deploy = add(964, W.prod, '生产部署：新索引上线', { project: P.search, at: ago(41 * MIN),
    reply: '已部署到生产，等协调者验收。' });
  S.preview = add(965, W.prod, '清理旧的预览环境', { at: ago(3 * HOUR), reply: '已删 7 个，剩 2 个还有人在用。' });
  S.retro = add(966, W.prod, '复盘周三的发布', { at: ago(27 * HOUR), reply: '时间线整理好了，三条改进项放在最后。' });
  S.c6 = add(970, W.prod, P.multiuser.title, { project: P.multiuser, role: 'COORDINATOR', at: ago(4 * DAY + 2 * HOUR),
    createdAt: ago(11 * DAY), reply: '架构定稿，三个任务都完成了。' });

  const sidebarDoc = (p) => ({
    id: p.id, title: p.title, status: p.status, createdAt: ago(8 * DAY), lastActivityAt: ago(MIN), mainBranch: 'main',
    buckets: { running: p.running, ready: 0, blocked: 0, awaitingVerification: 0, done: p.counts.done, failed: 0, cancelled: 0 },
    taskCounts: p.counts,
    attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null, ownerItems: [],
      coordinatorItems: null, startRequest: null },
    coordinatorActivity: { working: false, lastTurnAt: ago(MIN) }, startedAt: ago(8 * DAY),
  });
  const coordinatorOf = (p) => rows.find((r) => r.projectMembership?.projectId === p.id && r.projectMembership.role === 'COORDINATOR');
  return { sid, R, W, P, D, S, rows, sidebarDoc, coordinatorOf };
}
