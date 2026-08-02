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
  ownerId: string;
  agentId: string | null;
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
  agent: { id: string; name: string | null; model: string | null; effort: string | null } | null;
};

// Fake just the Prisma surface streamForUser touches: session.findUnique (owner + summary —
// the mock ignores `select` and returns the whole row, which satisfies both selects),
// approval.count, and the $executeRawUnsafe that publish() fires for the cross-replica NOTIFY.
function fakePrisma(rows: Record<string, Row>, pendingApprovals = 0): PrismaService {
  return {
    $executeRawUnsafe: async () => 0,
    session: { findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null },
    approval: { count: async () => pendingApprovals },
  } as unknown as PrismaService;
}

const rowA: Row = {
  id: 'sessA',
  ownerId: 'userA',
  agentId: 'agentA',
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
  agent: { id: 'agentA', name: 'builder', model: 'opus', effort: 'high' },
};

// Do NOT call onModuleInit — that would open a real pg LISTEN connection. The constructor only
// sets up the in-memory hub, which is all these tests exercise.
function svcWith(rows: Record<string, Row>, pending = 0): RealtimeService {
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
  assert.equal(ev.agentId, 'agentA');
  const data = ev.data as Record<string, unknown>;
  assert.equal(data.id, 'sessA');
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
    id: 'agentA',
    name: 'builder',
    model: 'opus',
    effort: 'high',
  });
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
  assert.deepEqual(got[0].data, { approvalId: 'ap1', pendingApprovals: 2 });
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
    runState: 'CANCELLED',
    lifecycleState: 'COMPLETED',
    filingState: 'ARCHIVED',
    endReason: 'completed',
  });
});

test('completing a dormant terminal session preserves its actual runState', async () => {
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
    runState: 'DORMANT',
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
  assert.deepEqual(mine[0].data, { taskId: 'task123' });
  // Routed by the creating session's owner — another user never sees it.
  assert.equal(theirs.length, 0);
});

test('publishAgentChanged surfaces as agent.changed with the changed agentId', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const mine: ControlEvent[] = [];
  const theirs: ControlEvent[] = [];
  const subA = svc.streamForUser('userA').subscribe((e) => mine.push(e));
  const subB = svc.streamForUser('userB').subscribe((e) => theirs.push(e));

  svc.publishAgentChanged('sessA', 'agentNew');
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.equal(mine.length, 1);
  assert.equal(mine[0].type, 'agent.changed');
  assert.equal(mine[0].sessionId, 'sessA');
  // `data.agentId` is the CREATED agent; the envelope's stays the calling session's agent.
  assert.deepEqual(mine[0].data, { agentId: 'agentNew' });
  assert.equal(mine[0].agentId, 'agentA');
  assert.equal(theirs.length, 0);
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
  // Session events need session-derived payloads and may not ride the owner-key shortcut.
  svc.publishForUser('userA', RunEventType.STATUS, 'not-a-session');
  await delay(30);
  subA.unsubscribe();
  subB.unsubscribe();

  assert.deepEqual(
    mine.map((e) => e.type),
    ['tag.changed', 'task.list.changed', 'task.changed'],
  );
  // The library belongs to the owner, not a session — the envelope says so.
  assert.equal(mine[0].sessionId, '');
  assert.equal(mine[0].agentId, null);
  assert.deepEqual(mine[0].data, { id: 'tag1' });
  assert.deepEqual(mine[2].data, { taskId: 'task1' });
  assert.equal(theirs.length, 0);
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
  svc.publishAgentChanged('sessA', 'agentNew');
  svc.publishSessionUpdated('sessA');
  svc.publishForUser('userA', RunEventType.TAG_CHANGED, 'tag1');
  svc.publish('sessA', { seq: 3, type: RunEventType.STATUS, ts: 't', payload: {} });
  await delay(20);
  sub.unsubscribe();

  // Only the real run event arrives; every lifecycle signal is filtered out.
  assert.equal(transcript.length, 1);
  assert.equal((transcript[0] as { type: string }).type, 'status');
});
