// The stub the iOS probe app reads through. Evidence only — it serves the three exception items
// the cards are screenshotted from, and an empty answer for everything else the console reads.
//
// Run: node .ios-probe/probe-server.mjs [port]
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.PROBE_PORT || 8931);
const PROJECT = process.env.PROBE_PROJECT || '34ODoUKJGEsfbgcJDGS4q';
const SESSION = process.env.PROBE_SESSION || '34SgoRKPa0zhBhzdzD5PV';

// Relative to the moment the read is ANSWERED, not to when this process started: the cards' own
// time lines are then the mock's ("waiting 2h 6m"), however long the runner took to get here.
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const minutesAhead = (m) => new Date(Date.now() + m * 60_000).toISOString();

/** The three cards, with the browser's own fixtures (ProjectProgressStatus.test.tsx) — one
 *  exception the coordinator is handling, one that became the owner's, and the pause. */
const openItems = () => ({
  needsYou: [
    {
      itemId: 'Pamt8Lq7mr2MGZV41pKTo',
      kind: 'TASK_FAILED',
      title: 'Task failed: 有存活 Monitor 的 warm engine 不回收（带硬上限）',
      detailLine: 'The acceptance command disagreed with what the task declared · exit 1, expected 0'
        + ' · attempt 2 of 3 in this chain',
      assignee: 'OWNER',
      assigneeReason: 'ESCALATED',
      waitingSince: minutesAgo(126),
      escalateAt: minutesAgo(6),
      escalatedAt: minutesAgo(6),
      taskId: '34OEE9DwfWYjo3aRFuBgo',
      sessionId: '6XUcYl0KepT3lwbwsCe40k',
      promotionId: null,
      fuseEpisodeId: null,
      delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
      actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'],
      question: null,
    },
    {
      itemId: '6fWujE4NBkVyzMWkL975oc',
      kind: 'FUSE_PAUSED',
      title: 'The coordinator paused itself',
      detailLine: 'It started 31 turns on its own today — the limit is 30. Spent today: 31 '
        + 'self-started turns · 4 sessions opened · 0 retries on one chain. Tasks keep running and '
        + 'landing; task results, merges and your answers still reach it. 3 things it would have '
        + 'started are on hold, and they go out as soon as you resume.',
      assignee: 'OWNER',
      assigneeReason: 'DEFAULT',
      waitingSince: minutesAgo(4),
      escalateAt: null,
      escalatedAt: null,
      taskId: null,
      sessionId: null,
      promotionId: null,
      fuseEpisodeId: '5Grmtl4G1LatjDDEmX492i',
      delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
      actions: ['RESUME'],
      question: null,
    },
  ],
  withCoordinator: [
    {
      itemId: '4Cni9q41xFEqJovhFRs5a',
      kind: 'INTEGRATION_CONFLICT',
      title: 'Merge conflict — needs a fix on the task branch',
      detailLine: '3 files conflict with project/bg-jobs · nothing landed',
      assignee: 'COORDINATOR',
      assigneeReason: 'DEFAULT',
      waitingSince: minutesAgo(18),
      escalateAt: minutesAhead(102),
      escalatedAt: null,
      taskId: '34OEE9DwfWYjo3aRFuBgo',
      sessionId: '6XUcYl0KepT3lwbwsCe40k',
      promotionId: null,
      fuseEpisodeId: null,
      delivery: { state: 'DELIVERED', sessionId: '34OAa5LxnQ1JXpUOfN21W', at: minutesAgo(17) },
      actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION'],
      question: null,
    },
  ],
});

const SESSION_ROW = {
  id: SESSION,
  title: 'iOS 卡片缺失问题',
  status: 'AWAITING_INPUT',
  projectId: PROJECT,
  projectTitle: '原生端补齐例外待办卡',
  agent: { id: '3CuIHiSJZBQ7nLVUwc7ekz', name: 'orbit' },
  taskId: null,
  pendingApprovals: 0,
  ownerItems: [],
};

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://stub').pathname;
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  console.log(`${req.method} ${path}`);

  if (path === `/api/sessions/${SESSION}`) return json(SESSION_ROW);
  if (path === `/api/projects/${PROJECT}/open-items`) return json(openItems());
  if (path === `/api/projects/${PROJECT}/promotions/current`) return json(null);
  if (path.endsWith('/approvals')) return json([]);
  if (path.endsWith('/turns')) return json([]);
  // Everything else the console reads: an empty answer it can decode and find nothing in. The
  // cards do not depend on any of it.
  if (path.startsWith('/api/')) return json({});
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => console.log(`stub listening on ${PORT}`));
