import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ControlEvent,
  RunEventType,
  RunStatus,
  SessionEndReason,
  SessionLifecycleState,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeService } from './realtime.service';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Row = {
  id: string;
  taskId: string | null;
  ownerId: string;
  workspaceId: string | null;
  title: string | null;
  status: string;
  endReason?: string | null;
  completedAt?: Date | null;
  archivedAt?: Date | null;
  deletedAt?: Date | null;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  numTurns: number;
  runtimeSessionId: string | null;
  assignedRunnerId: string | null;
  assignedRunner: {
    id: string;
    status: string;
    lastHeartbeatAt: Date | null;
  } | null;
  lastTurnAt: Date | null;
  workspace: { id: string; name: string | null; model: string | null; effort: string | null } | null;
  coordinatorForProject?: { id: string; title: string } | null;
  /** Read by the approval count: whose cards are still being asked depends on whether the
   *  conversation is generating, and — when it is not — on which of these processes are up. */
  engineTurnActive?: boolean | null;
  runningBgShells?: string[];
};

// Fake just the Prisma surface streamForUser touches: session.findUnique (owner + summary —
// the mock ignores `select` and returns the whole row, which satisfies both selects),
// approval.count, project.findMany (no project is coordinated from these conversations) and
// taskOwnerConfirmationRequest.findMany (no OWNER_CONFIRMED run is waiting on its owner in them),
// so the owner-decision half of the count is zero, and the $executeRawUnsafe that publish() fires
// for the cross-replica NOTIFY.
function fakePrisma(
  rows: Record<string, Row>,
  pendingApprovals: number | ((where: Record<string, never>) => number) = 0,
): PrismaService {
  return {
    $executeRawUnsafe: async () => 0,
    session: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = rows[where.id];
        if (!row) return null;
        // `runningBgShells` is NOT NULL DEFAULT '{}' (schema.prisma), so a fixture that does not
        // spell it answers with the empty set — as the row would if it had been inserted without it.
        return { ...row, runningBgShells: row.runningBgShells ?? [] };
      },
    },
    // A number stands in for "the table answers this much"; a function is the table itself, for the
    // one case where the count is a predicate over WHICH rows answer (`backgroundJobId ∈ …`).
    approval: {
      count: async ({ where }: { where: Record<string, never> }) =>
        typeof pendingApprovals === 'function' ? pendingApprovals(where) : pendingApprovals,
    },
    // `pendingApprovals` on the wire is blocked tool calls PLUS the owner decisions the
    // conversation is the surface for (`projects/owner-decision-signal.ts`). These fixtures
    // coordinate no project, so the second half contributes nothing and the numbers below are
    // still statements about the first.
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    // …and the four owner items a project can be waiting on its owner for (§7.6 V13),
    // which these fixtures have none of either.
    projectOpenItem: { findMany: async () => [] },
  } as unknown as PrismaService;
}

const rowA: Row = {
  id: 'sessA',
  taskId: 'taskA',
  ownerId: 'userA',
  workspaceId: 'workspaceA',
  title: 'Fix bug',
  status: RunStatus.RUNNING,
  cancelRequestedAt: null,
  startedAt: new Date('2026-06-26T00:00:00.000Z'),
  numTurns: 1,
  runtimeSessionId: 'runtime-1',
  assignedRunnerId: 'runnerA',
  assignedRunner: {
    id: 'runnerA',
    status: 'ONLINE',
    lastHeartbeatAt: new Date(),
  },
  lastTurnAt: new Date('2026-06-26T00:00:00.000Z'),
  workspace: { id: 'workspaceA', name: 'builder', model: 'opus', effort: 'high' },
  coordinatorForProject: { id: 'projectA', title: 'Fix the project' },
};

// Do NOT call onModuleInit — that would open a real pg LISTEN connection. The constructor only
// sets up the in-memory hub, which is all these tests exercise.
function svcWith(
  rows: Record<string, Row>,
  pending: number | ((where: Record<string, never>) => number) = 0,
): RealtimeService {
  // These tests exercise streamForUser only; a no-op push stub satisfies the new constructor dep.
  const push = { scheduleBadgeSync: () => undefined } as unknown as PushService;
  return new RealtimeService(fakePrisma(rows, pending), push);
}

test('a STATUS event reaches the owner as session.updated with a full summary', async () => {
  const svc = svcWith({ sessA: rowA }, 3);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publish('sessA', {
    seq: 1,
    type: RunEventType.STATUS,
    ts: '2026-06-26T00:00:00.000Z',
    payload: { status: RunStatus.RUNNING },
  });
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  const ev = got[0];
  assert.equal(ev.type, 'session.updated');
  assert.equal(ev.sessionId, 'sessA');
  assert.equal(ev.agentId, 'workspaceA');
  const data = ev.data as Record<string, unknown>;
  assert.equal(data.id, 'sessA');
  assert.equal(data.taskId, 'taskA');
  assert.equal(data.title, 'Fix bug');
  assert.equal(data.status, 'RUNNING');
  assert.equal(data.runStatus, 'RUNNING');
  assert.equal(data.sessionState, 'RUNNING');
  assert.equal(data.runState, 'RUNNING');
  assert.equal(data.lifecycleState, 'OPEN');
  assert.equal(data.filingState, 'OPEN');
  assert.deepEqual(data.capabilities, {
    canSend: true,
    canResume: false,
    resumeBlockedReason: 'NOT_TERMINAL',
    canComplete: true,
    canArchive: true,
    canRestore: false,
  });
  assert.equal(data.pendingApprovals, 3);
  assert.equal(data.lastTurnAt, '2026-06-26T00:00:00.000Z');
  assert.deepEqual(data.agent, {
    id: 'workspaceA',
    name: 'builder',
    model: 'opus',
    effort: 'high',
  });
  assert.equal(data.projectId, 'projectA');
  assert.equal(data.projectTitle, 'Fix the project');
});

test('a parked conversation counts the cards a live runner-hosted job is still reading', async () => {
  // The row this count was blind to: AWAITING_INPUT with the engine gone, a runner-hosted job still
  // up, and one card that job is polling for. The table holds two PENDING cards — the live job's and
  // one whose job has already gone — so an answer of 0 (the old "not generating, so nothing") and an
  // answer of 2 (every pending row) both fail here, and only the rule passes.
  const parked: Row = {
    ...rowA,
    id: 'sessParked',
    ownerId: 'userB',
    status: RunStatus.AWAITING_INPUT,
    engineTurnActive: false,
    runningBgShells: ['bgj_up'],
  };
  const cards = [{ backgroundJobId: 'bgj_up' }, { backgroundJobId: 'bgj_gone' }];
  const whereSeen: Array<{ in: string[] }> = [];
  const svc = svcWith({ sessParked: parked }, (where) => {
    const live = where.backgroundJobId as unknown as { in: string[] };
    whereSeen.push(live);
    return cards.filter((c) => live.in.includes(c.backgroundJobId)).length;
  });
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userB').subscribe((e) => got.push(e));
  svc.publish('sessParked', {
    seq: 1,
    type: RunEventType.STATUS,
    ts: '2026-06-26T00:05:00.000Z',
    payload: { status: RunStatus.AWAITING_INPUT },
  });
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  const data = got[0]!.data as Record<string, unknown>;
  assert.equal(data.status, 'AWAITING_INPUT');
  assert.equal(data.pendingApprovals, 1,
    'a card a live runner-hosted job is reading is not counted on the parked conversation');
  // And the question really was asked of the table as the job-membership rule: the live shell set,
  // on a PENDING card. A count over the whole table would have answered 2 without this.
  assert.deepEqual(whereSeen, [{ in: ['bgj_up'] }]);

  // The paired control: the same conversation with the job gone is not read at all. Nothing can be
  // waiting on a process that is not there, which is the same skip the generating check made.
  let reads = 0;
  const quiet = svcWith({ sessParked: { ...parked, runningBgShells: [] } }, () => {
    reads += 1;
    return 2;
  });
  const quietGot: ControlEvent[] = [];
  const quietSub = quiet.streamForUser('userB').subscribe((e) => quietGot.push(e));
  quiet.publish('sessParked', {
    seq: 1,
    type: RunEventType.STATUS,
    ts: '2026-06-26T00:05:00.000Z',
    payload: { status: RunStatus.AWAITING_INPUT },
  });
  await delay(30);
  quietSub.unsubscribe();
  assert.equal((quietGot[0]!.data as Record<string, unknown>).pendingApprovals, 0);
  assert.equal(reads, 0, 'the approval table was read for a conversation with no live job');
});

test("another user's stream never sees the event", async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publish('sessA', {
    seq: 1,
    type: RunEventType.STATUS,
    ts: 't',
    payload: { status: RunStatus.RUNNING },
  });
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 0);
});

test('an APPROVAL_REQUEST maps to approval.requested with the live pending count', async () => {
  const svc = svcWith({ sessA: rowA }, 2);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publish('sessA', {
    seq: 0,
    type: RunEventType.APPROVAL_REQUEST,
    ts: 't',
    payload: { id: 'ap1', toolName: 'Bash' },
  });
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'approval.requested');
  // The kind rides with the count because clients overwrite the row with both: a blocked tool call
  // is counted here, so this row says "approval", not "Waiting for your confirmation".
  assert.deepEqual(got[0].data, { approvalId: 'ap1', pendingApprovals: 2, waitingKind: null });
});

test('transcript events (text deltas) are dropped, not forwarded', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publish('sessA', {
    seq: 2,
    type: RunEventType.TEXT_DELTA,
    ts: 't',
    payload: { delta: 'hello' },
  });
  await delay(20);
  sub.unsubscribe();

  assert.equal(got.length, 0);
});

test('publishSessionCreated surfaces as session.created with the full summary', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionCreated('sessA');
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'session.created');
  assert.equal((got[0].data as Record<string, unknown>).id, 'sessA');
  assert.equal((got[0].data as Record<string, unknown>).taskId, 'taskA');
  assert.equal((got[0].data as Record<string, unknown>).title, 'Fix bug');
});

test('publishSessionLifecycleChanged preserves run outcome and exposes Completed canonically', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionLifecycleChanged(
    'sessA',
    RunStatus.CANCELLED,
    SessionEndReason.COMPLETED,
    SessionLifecycleState.COMPLETED,
  );
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'session.ended');
  assert.deepEqual(got[0].data, {
    status: 'CANCELLED',
    runStatus: 'CANCELLED',
    sessionState: 'COMPLETED',
    runState: 'ENDED',
    lifecycleState: 'COMPLETED',
    filingState: 'ARCHIVED',
    endReason: 'completed',
  });
});

test('completing an already-ended session preserves its actual runState', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionLifecycleChanged(
    'sessA',
    RunStatus.CANCELLED,
    SessionEndReason.ENDED,
    SessionLifecycleState.COMPLETED,
  );
  await delay(30);
  sub.unsubscribe();

  assert.deepEqual(got[0].data, {
    status: 'CANCELLED',
    runStatus: 'CANCELLED',
    sessionState: 'COMPLETED',
    runState: 'ENDED',
    lifecycleState: 'COMPLETED',
    filingState: 'ARCHIVED',
    endReason: 'ended',
  });
});

test('a Completed successful summary keeps SUCCEEDED execution state', async () => {
  const completed = {
    ...rowA,
    status: RunStatus.SUCCEEDED,
    endReason: SessionEndReason.TASK_DONE,
    completedAt: new Date('2026-06-27T00:00:00.000Z'),
    archivedAt: null,
    deletedAt: null,
  };
  const svc = svcWith({ sessA: completed }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionUpdated('sessA');
  await delay(30);
  sub.unsubscribe();

  const data = got[0].data as Record<string, unknown>;
  assert.equal(data.sessionState, 'COMPLETED');
  assert.equal(data.runState, 'SUCCEEDED');
  assert.equal(data.lifecycleState, 'COMPLETED');
  assert.equal(data.filingState, 'ARCHIVED');
  assert.deepEqual(data.capabilities, {
    canSend: true,
    canResume: true,
    resumeBlockedReason: null,
    canComplete: false,
    canArchive: false,
    canRestore: true,
  });
});

test('publishTaskChanged surfaces as task.changed with the taskId, scoped to the session owner', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publishTaskChanged('sessA', 'task123');
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.equal(mine.length, 1);
  assert.equal(mine[0].type, 'task.changed');
  assert.equal(mine[0].sessionId, 'sessA');
  assert.deepEqual(mine[0].data, {
    taskId: 'task123',
    taskIds: [],
    resync: true,
  });
  // Routed by the creating session's owner — another user never sees it.
  assert.equal(theirs.length, 0);
});

test('publishWorkspaceChanged surfaces task-affecting workspace updates explicitly', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publishWorkspaceChanged('sessA', 'workspaceNew', true);
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.equal(mine.length, 1);
  assert.equal(mine[0].type, 'agent.changed');
  assert.equal(mine[0].sessionId, 'sessA');
  // `data.agentId` is the CREATED workspace; the envelope's stays the calling session's workspace.
  assert.deepEqual(mine[0].data, {
    agentId: 'workspaceNew',
    affectsTaskRows: true,
  });
  assert.equal(mine[0].agentId, 'workspaceA');
  assert.equal(theirs.length, 0);
});

test('publishWorkspaceChanged preserves a false task-row effect flag', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const mine: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((event) => mine.push(event));

  svc.publishWorkspaceChanged('sessA', 'workspaceNew', false);
  await delay(30);
  sub.unsubscribe();

  assert.deepEqual(mine[0].data, {
    agentId: 'workspaceNew',
    affectsTaskRows: false,
  });
});

test('publishForUser reaches only that owner, with no session scope', async () => {
  // No session rows at all: a user-scoped event must route without touching the session table.
  const svc = svcWith({}, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publishForUser('userA', RunEventType.TAG_CHANGED, 'tag1');
  svc.publishForUser('userA', RunEventType.TASK_LIST_CHANGED, 'list1');
  svc.publishForUser('userA', RunEventType.TASK_CHANGED, 'task1');
  svc.publishForUser('userA', RunEventType.PROJECT_CRITERIA_DECISIONS_CHANGED, 'project1');
  // Session events need session-derived payloads and may not ride the owner-key shortcut.
  svc.publishForUser('userA', RunEventType.STATUS, 'not-a-session');
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.deepEqual(
    mine.map((e) => e.type),
    ['tag.changed', 'task.list.changed', 'task.changed', 'project.criteria_decisions.changed'],
  );
  assert.deepEqual(mine[3].data, { id: 'project1' });
  // The library belongs to the owner, not a session — the envelope says so.
  assert.equal(mine[0].sessionId, '');
  assert.equal(mine[0].agentId, null);
  assert.deepEqual(mine[0].data, { id: 'tag1' });
  assert.deepEqual(mine[2].data, {
    taskId: 'task1',
    taskIds: [],
    resync: true,
  });
  assert.equal(theirs.length, 0);
});

/**
 * A watch belongs to its owner, not to any one session — a NOTIFY_USER watch observes from no
 * session at all — so `watch.changed` rides the owner key like the libraries do, and reaches that
 * owner's stream and nobody else's. This is the event that carries a delivery, a deadline, a dead
 * letter or an agent's create/release to the clients: none of those writes a task or session row,
 * so before it the web watch list only found them on its 60s poll (docs/watch-contract.md §8.1).
 */
test('watch.changed reaches its owner\'s stream, carrying the watch id and nothing else', async () => {
  const svc = svcWith({}, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publishWatchChanged('userA', 'watch-1');
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.equal(mine.length, 1);
  assert.equal(mine[0].type, 'watch.changed');
  // The whole payload, asserted as a whole: no state, no targets, no snapshot, no Match reason
  // (contract `deliveryGuards.redaction`). A client re-reads GET /watches, which redacts.
  assert.deepEqual(mine[0].data, { id: 'watch-1' });
  // The owner's, not a session's: the envelope names none, and nothing looked one up.
  assert.equal(mine[0].sessionId, '');
  assert.equal(mine[0].agentId, null);
  assert.equal(theirs.length, 0);
});

test('task.changed carries a bounded row set or an explicit full-resync signal', async () => {
  const svc = svcWith({}, 0);
  const events: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((event) => events.push(event));

  svc.publishForUser('userA', RunEventType.TASK_CHANGED, {
    taskIds: ['taskA', 'taskB', 'taskA'],
    resync: false,
  });
  svc.publishForUser('userA', RunEventType.TASK_CHANGED, {
    taskIds: [],
    resync: true,
  });
  await delay(30);
  sub.unsubscribe();

  assert.deepEqual(events.map((event) => event.data), [
    { taskId: 'taskA', taskIds: ['taskA', 'taskB'], resync: false },
    { taskIds: [], resync: true },
  ]);
});

test('publishForAllUsers reaches every stream (shared provider catalog)', async () => {
  const svc = svcWith({}, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publishForAllUsers(RunEventType.PROVIDER_CHANGED, 'prov1');
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.equal(mine.length, 1);
  assert.equal(theirs.length, 1);
  assert.equal(mine[0].type, 'provider.changed');
  assert.deepEqual(theirs[0].data, { id: 'prov1' });
});

test('publishSessionUpdated surfaces as session.updated with the current summary (rename)', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionUpdated('sessA');
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'session.updated');
  assert.equal((got[0].data as Record<string, unknown>).title, 'Fix bug');
});

test('session.updated explicitly clears project relation metadata for an ordinary session', async () => {
  const ordinary: Row = {
    ...rowA,
    id: 'sessB',
    coordinatorForProject: null,
  };
  const svc = svcWith({ sessB: ordinary }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionUpdated('sessB');
  await delay(30);
  sub.unsubscribe();

  const data = got[0].data as Record<string, unknown>;
  assert.equal(Object.hasOwn(data, 'projectId'), true);
  assert.equal(Object.hasOwn(data, 'projectTitle'), true);
  assert.equal(data.projectId, null);
  assert.equal(data.projectTitle, null);
});

/**
 * A queued turn has no transcript event until the runner leases it, so this nudge is the only
 * thing that says a message was sent at all. The focused client re-fetches the queue from it; the
 * owner's OTHER clients need it as a plain session update, or a message sent on web reaches the
 * phone's list only once the runner gets round to its first event — the far side of a whole turn,
 * for a message queued behind one.
 */
test('a queued-turn change reaches the focused transcript stream and the control stream', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const transcript: Array<{ type: string }> = [];
  const control: ControlEvent[] = [];
  const runSub = svc.streamForRun('sessA').subscribe((e) => transcript.push(e));
  const controlSub = svc.streamForUser('userA').subscribe((e) => control.push(e));

  svc.publishQueuedTurnsChanged('sessA');
  await delay(20);
  runSub.unsubscribe();
  controlSub.unsubscribe();

  assert.deepEqual(transcript.map((e) => e.type), ['queued_turns_changed']);
  assert.equal(control.length, 1);
  assert.equal(control[0].type, 'session.updated');
  assert.equal((control[0].data as Record<string, unknown>).id, 'sessA');
});

test('lifecycle signals never enter a per-session transcript stream', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const transcript: unknown[] = [];
  const sub = svc.streamForRun('sessA').subscribe((e) => transcript.push(e));

  svc.publishSessionCreated('sessA');
  svc.publishSessionLifecycleChanged(
    'sessA',
    RunStatus.SUCCEEDED,
    SessionEndReason.COMPLETED,
    SessionLifecycleState.COMPLETED,
  );
  svc.publishTaskChanged('sessA', 'task123');
  svc.publishWorkspaceChanged('sessA', 'workspaceNew', false);
  svc.publishSessionUpdated('sessA');
  svc.publishForUser('userA', RunEventType.TAG_CHANGED, 'tag1');
  svc.publishWatchChanged('userA', 'watch-1');
  svc.publish('sessA', { seq: 3, type: RunEventType.STATUS, ts: 't', payload: {} });
  await delay(20);
  sub.unsubscribe();

  // Only the real run event arrives; every lifecycle signal is filtered out.
  assert.equal(transcript.length, 1);
  assert.equal((transcript[0] as { type: string }).type, 'status');
});
