// Sample account for docs/mocks/needs-you-jump (2026-11-26): one workspace, one open project whose
// candidate waits on "Approve merge to main", its coordinator in the list's Needs you section, and a
// few other sessions. Made-up names and text; the shapes are what GET /sessions, /projects/... answer.
export const NOW = Date.parse('2026-11-26T02:40:00.000Z'); // 10:40 in Asia/Shanghai
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const ago = (ms) => new Date(NOW - ms).toISOString();

export function makeData(uuidToBase62) {
  const sid = (n) => uuidToBase62(`0196e000-0000-7000-8000-${String(n).padStart(12, '0')}`);
  const R = {
    hpc: { id: sid(31), name: 'HPC', online: true, maxConcurrent: 4, activeSessions: 1,
      engines: [{ engine: 'claude', installed: true, auth: 'yes' }], commands: [], skills: [] },
  };
  const W = {
    test: { id: sid(21), name: 'landing-test', runnerId: R.hpc.id, runner: R.hpc, createdAt: ago(30 * DAY),
      lastProvider: 'claude', provider: 'claude', model: null, effort: null },
  };
  const P = {
    landing: { id: sid(201), title: 'Protected-branch landing drills', status: 'OPEN',
      counts: { done: 3, failed: 0, total: 6 }, running: 1 },
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

  const D = {};
  // The coordinator, waiting on the owner: one merge approval (the row reads "Approve merge to main").
  D.coord = add(910, W.test, `TEST: ${P.landing.title}`, { project: P.landing, role: 'COORDINATOR', at: ago(60 * MIN),
    createdAt: ago(1 * DAY),
    reply: 'Run 2a passed its required check on the second push. The candidate for main is ready and waits for your confirmation.',
    extra: { pendingApprovals: 1, waitingKind: 'OWNER_ITEM',
      ownerItems: [{ kind: 'PROMOTION_APPROVAL', mainBranch: 'main', since: ago(55 * MIN) }] } });
  D.r2a = add(911, W.test, 'Run 2a: failing required check, then fixed through the same pull request',
    { project: P.landing, at: ago(58 * MIN), reply: 'Deleted FAIL_CI and pushed again; the required check passed.' });
  D.r2b = add(912, W.test, 'Run 2b: conflict on the protected branch', { project: P.landing, running: true, tool: 'Bash', at: ago(2 * MIN) });
  [['Run 1a: clean landing through a pull request', 0.4], ['Run 1b: merge check timeout', 0.3], ['Run 1c: review required', 0.2]]
    .forEach(([title, days], i) => add(913 + i, W.test, title, { project: P.landing, completed: true, at: ago(days * DAY),
      reply: 'Delivered; the coordinator accepted it.' }));
  D.notes = add(930, W.test, 'Write up the branch-protection findings', { at: ago(3 * HOUR), reply: 'Draft is in docs/notes.md.' });
  D.ci = add(931, W.test, 'Check the CI cache size', { at: ago(26 * HOUR), reply: 'The cache is 3.1 GB; nothing to prune.' });

  const promotion = {
    promotionId: sid(501), state: 'READY', sourceKind: 'PROJECT_BRANCH', sourceRef: 'project/landing-drills',
    sourceSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', upstreamRef: 'main', commitsAhead: 4, filesChanged: 7,
    tasks: [{ taskId: sid(601), title: 'Run 1a: clean landing through a pull request' },
      { taskId: sid(602), title: 'Run 2a: failing required check, then fixed through the same pull request' }],
    taskIds: [sid(601), sid(602)],
    checks: [], conflicts: [], blockedReason: null,
    upstreamShaChecked: 'ffeeddccbbaa99887766554433221100ffeeddcc', landsTreeSha: '0011223344556677889900aabbccddeeff001122',
    landsAs: 'MERGE_COMMIT', askedAt: ago(55 * MIN), upstream: { syncedAt: ago(70 * MIN), conflicts: false },
    recheckedAt: null, recheck: null, landingSessionId: null, onPass: null, execution: null,
  };

  const sidebarDoc = (p) => ({
    id: p.id, title: p.title, status: p.status, createdAt: ago(DAY), lastActivityAt: ago(MIN), mainBranch: 'main',
    buckets: { running: p.running, ready: 2, blocked: 0, awaitingVerification: 0, done: p.counts.done, failed: 0, cancelled: 0 },
    taskCounts: p.counts,
    attention: { userBlockers: 0, coordinatorBlockers: 0, systemBlockers: 0, maxSeverity: null,
      ownerItems: [{ kind: 'PROMOTION_APPROVAL', mainBranch: 'main', since: ago(55 * MIN) }],
      coordinatorItems: null, startRequest: null },
    coordinatorActivity: { working: false, lastTurnAt: ago(60 * MIN) }, startedAt: ago(DAY),
  });
  const coordinatorOf = (p) => rows.find((r) => r.projectMembership?.projectId === p.id && r.projectMembership.role === 'COORDINATOR');
  return { sid, R, W, P, D, rows, promotion, sidebarDoc, coordinatorOf };
}
