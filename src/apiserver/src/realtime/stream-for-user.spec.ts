import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlEvent, RunEventType, RunStatus, SessionEndReason } from '@orbit/shared';
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
  lastTurnAt: Date | null;
  agent: { id: string; name: string | null; model: string | null } | null;
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
  lastTurnAt: new Date('2026-06-26T00:00:00.000Z'),
  agent: { id: 'agentA', name: 'builder', model: 'opus' },
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
  assert.equal(data.pendingApprovals, 3);
  assert.equal(data.lastTurnAt, '2026-06-26T00:00:00.000Z');
  assert.deepEqual(data.agent, { id: 'agentA', name: 'builder', model: 'opus' });
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

test('publishSessionEnded surfaces as session.ended with status+endReason', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const got: ControlEvent[] = [];
  const sub = svc.streamForUser('userA').subscribe((e) => got.push(e));

  svc.publishSessionEnded('sessA', RunStatus.SUCCEEDED, SessionEndReason.COMPLETED);
  await delay(30);
  sub.unsubscribe();

  assert.equal(got.length, 1);
  assert.equal(got[0].type, 'session.ended');
  assert.deepEqual(got[0].data, { status: 'SUCCEEDED', endReason: 'completed' });
});

test('lifecycle signals never enter a per-session transcript stream', async () => {
  const svc = svcWith({ sessA: rowA }, 0);
  const transcript: unknown[] = [];
  const sub = svc.streamForRun('sessA').subscribe((e) => transcript.push(e));

  svc.publishSessionCreated('sessA');
  svc.publishSessionEnded('sessA', RunStatus.SUCCEEDED, SessionEndReason.COMPLETED);
  svc.publish('sessA', { seq: 3, type: RunEventType.STATUS, ts: 't', payload: {} });
  await delay(20);
  sub.unsubscribe();

  // Only the real run event arrives; both lifecycle signals are filtered out.
  assert.equal(transcript.length, 1);
  assert.equal((transcript[0] as { type: string }).type, 'status');
});
