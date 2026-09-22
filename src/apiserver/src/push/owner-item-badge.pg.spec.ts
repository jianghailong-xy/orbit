/**
 * THE THREE COUNTING READS AGREE ABOUT THE FOUR OWNER ITEMS — WITH ROWS IN THE TABLE.
 *
 * `push.service.spec.ts` holds the rule over a fake Prisma: which four ring a phone and which do
 * not. What a fake cannot witness is the QUERY — the nested relation filter that decides which
 * conversations carry an owner item at all (`owner-decision-signal.ts`), and the row it is run
 * against. Empty results are what every existing spec produces for that read, and an empty result
 * is exactly what a filter that matches nothing looks like.
 *
 * So this file builds the rows a real project makes and asks all three readers:
 *
 *   (1) the session list's `pendingApprovals` on the coordinator conversation,
 *   (2) the per-workspace `needsYou`,
 *   (3) `PushService.needsYouSessions` — the APNs badge, which is computed server-side for a phone
 *       that is not running the app and was, until this task, blind to the four (contract §7.6 V13).
 *
 * THE NEGATIVES COME FIRST, and each is the same fixture one fact earlier: before any item exists;
 * with an item the COORDINATOR is working through (owner decision 10 — pushing it would interrupt
 * somebody about work already being done); with an OWNER-assigned item that is NOT one of the four
 * (`ownerItemKind`'s predicate, which is the only spelling of "this one is the owner's"); and with
 * an owner item on a project that has no coordinator conversation to draw the card in (a badge that
 * opens nothing is worse than a dark one). Only then does a real question make all three light.
 *
 * AND ONE POSITIVE THAT USED TO BE DARK: the same item on a project whose coordinator is SWITCHED
 * OFF but whose conversation is still bound — `coordinatorEnabled = false`. The switch decides
 * whether the coordinator may act (where an item can be handed to, which is why these items are the
 * owner's at all); where the card is DRAWN is the binding, and the client reads the binding. Gating
 * the count on the switch made the badge and the card disagree, in the worst direction: a dark row
 * over a conversation holding an unanswered card (the account owner's report, 2026-09-22 — a
 * project confirmed but never started, three escalations, nothing pointing at them).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PushService } from './push.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  /** A project with no coordinator bound: its page still draws the card, nothing points at it. */
  uncoordinatedProjectId: string;
  /**
   * A project whose coordinator is SWITCHED OFF (`coordinatorEnabled` left at its default) but whose
   * conversation is bound and live: the card is drawn in that conversation, so all three reads have
   * to count it there.
   */
  switchedOffProjectId: string;
  switchedOffSessionId: string;
}

/**
 * One owner, one workspace, one coordinated project and its PARKED coordinator conversation, plus a
 * second project nobody coordinates.
 *
 * Parked on purpose: a coordinator conversation waits for an answer at AWAITING_INPUT, so a fixture
 * that was RUNNING would let a read that only knew about running sessions look as if it knew about
 * the item.
 */
async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const uncoordinatedProjectId = randomUUID();
  const switchedOffProjectId = randomUUID();
  const switchedOffSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@owner-item-badge.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 的项目`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  // The same shape with the switch left OFF: `coordinatorEnabled` is the column default here, which
  // is exactly the state a project lands in when nobody has confirmed what would settle it.
  await db.session.create({
    data: {
      id: switchedOffSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}（已关掉）`,
      prompt: `协调：${label}（已关掉）`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  await db.project.create({
    data: {
      id: switchedOffProjectId,
      ownerId,
      title: `${label} 的关掉协调者的项目`,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId: switchedOffSessionId,
    },
  });
  await db.projectRuntime.upsert({
    where: { projectId: switchedOffProjectId },
    create: { projectId: switchedOffProjectId },
    update: {},
  });
  await db.project.create({
    data: { id: uncoordinatedProjectId, ownerId, title: `${label} 的无协调会话项目` },
  });
  await db.projectRuntime.upsert({
    where: { projectId: uncoordinatedProjectId },
    create: { projectId: uncoordinatedProjectId },
    update: {},
  });
  return {
    ownerId, workspaceId, projectId, coordinatorSessionId, uncoordinatedProjectId,
    switchedOffProjectId, switchedOffSessionId,
  };
}

/** One `project_open_item` row, in the columns `ownerItemKind` decides from. */
let dedupe = 0;
function item(f: Fixture, projectId: string, over: Record<string, unknown> = {}) {
  dedupe += 1;
  return {
    projectId,
    ownerId: f.ownerId,
    kind: 'COORDINATOR_QUESTION',
    state: 'OPEN',
    assignee: 'OWNER',
    assigneeReason: 'DEFAULT',
    dedupeKey: `owner-item-badge-${dedupe}`,
    title: 'Coordinator asks: Take the slower fix?',
    payload: { question: 'Take the slower fix?', options: [], blocksTaskIds: [], ifUnanswered: null },
    waitingSince: new Date('2026-09-19T00:30:00Z'),
    assignedAt: new Date('2026-09-19T00:30:00Z'),
    ...over,
  };
}

test('the four owner items light the badge, the list and the workspace count — and the others do not', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  // `needsYouSessions` does not gate on the credential (the badge is computed for a phone that is
  // not running the app, not for a delivery), so an unconfigured service is the honest one here.
  const push = new PushService(prisma, { get: () => undefined } as never);

  const f = await fixture(db, 'owner-item-badge');

  /** All three readers at once: the row, the workspace tally, and the badge. */
  async function reads(sessionId: string = f.coordinatorSessionId) {
    const rows = await sessions.list(f.ownerId, {});
    const row = rows.find((s: { id: string }) => s.id === sessionId);
    assert.ok(row, 'the coordinator conversation is in this owner’s Open list');
    const counts = await sessions.workspaceSessionCounts(f.ownerId);
    const workspace = counts.find((c: { workspaceId: string }) => c.workspaceId === f.workspaceId);
    return {
      pendingApprovals: (row as { pendingApprovals: number }).pendingApprovals,
      workspaceNeedsYou: workspace?.needsYou ?? 0,
      badge: await push.needsYouSessions(f.ownerId),
    };
  }

  // (1) The fixture before it holds anything: all three answer zero, so "greater than zero" below
  //     cannot be true of a read that counts every session it can find.
  const empty = await reads();
  assert.deepEqual(
    { ...empty, badge: empty.badge.includes(f.coordinatorSessionId) },
    { pendingApprovals: 0, workspaceNeedsYou: 0, badge: false },
    'nothing is waiting yet',
  );

  // (2) An exception the COORDINATOR is working through is not the owner's: it is a row on the
  //     table, in the project, with an assignee — and it lights nothing (owner decision 10).
  await db.projectOpenItem.create({
    data: item(f, f.projectId, {
      kind: 'INTEGRATION_CONFLICT', assignee: 'COORDINATOR', assigneeReason: 'DEFAULT',
    }),
  } as never);
  const handling = await reads();
  assert.deepEqual(
    { ...handling, badge: handling.badge.includes(f.coordinatorSessionId) },
    { pendingApprovals: 0, workspaceNeedsYou: 0, badge: false },
    'the coordinator is on it; the owner is not told',
  );

  // (3) Handed to the owner, but NOT one of the four — a kind and a reason `ownerItemKind` refuses.
  //     This is the predicate with a row in front of it, which no fake can witness.
  const mistaken = await db.projectOpenItem.create({
    data: item(f, f.projectId, {
      kind: 'INTEGRATION_CONFLICT', assignee: 'OWNER', assigneeReason: 'DEFAULT',
    }),
  } as never);
  const refused = await reads();
  assert.deepEqual(
    { ...refused, badge: refused.badge.includes(f.coordinatorSessionId) },
    { pendingApprovals: 0, workspaceNeedsYou: 0, badge: false },
    'owner-assigned is not enough; it has to be one of the four',
  );

  // (4) One of the four on a project with NO coordinator conversation: the card exists on the
  //     project page, but there is no conversation to open, and a lit badge that opens nothing is
  //     worse than a dark one — so none of the three counts it.
  await db.projectOpenItem.create({ data: item(f, f.uncoordinatedProjectId) } as never);
  const nowhere = await reads();
  assert.deepEqual(
    { ...nowhere, badge: nowhere.badge.includes(f.coordinatorSessionId) },
    { pendingApprovals: 0, workspaceNeedsYou: 0, badge: false },
    'no conversation to point at, so no count',
  );

  // (5) The real thing: one of the four, on the coordinated project, assigned to the owner.
  const ask = await db.projectOpenItem.create({
    data: item(f, f.projectId),
  } as never);
  const waiting = await reads();
  assert.equal(waiting.pendingApprovals, 1, 'the session list counts it on the conversation');
  assert.equal(waiting.workspaceNeedsYou, 1, 'so does the workspace tally');
  assert.ok(waiting.badge.includes(f.coordinatorSessionId), 'and so does the APNs badge');

  // (6) Resolving it is what puts all three back — a committed row, with the session untouched.
  await db.projectOpenItem.update({
    where: { id: ask.id },
    data: { state: 'RESOLVED', resolution: 'ANSWERED', resolvedAt: new Date(), resolvedBy: 'USER' },
  });
  const after = await reads();
  assert.deepEqual(
    { ...after, badge: after.badge.includes(f.coordinatorSessionId) },
    { pendingApprovals: 0, workspaceNeedsYou: 0, badge: false },
    'answered, so nothing is waiting',
  );

  // (7) One of the four on a project whose coordinator is SWITCHED OFF, with its conversation still
  //     bound. The switch decides whether an item can be handed to that conversation at all — which
  //     is why this one is the owner's — while the card is drawn there and the client reads the
  //     binding, not the switch. All three follow the card.
  await db.projectOpenItem.create({ data: item(f, f.switchedOffProjectId) } as never);
  const switchedOff = await reads(f.switchedOffSessionId);
  assert.equal(switchedOff.pendingApprovals, 1, 'the switched-off conversation counts it too');
  assert.equal(switchedOff.workspaceNeedsYou, 1, 'so does the workspace tally');
  assert.ok(switchedOff.badge.includes(f.switchedOffSessionId), 'and so does the APNs badge');

  // The refused row from (3) is still OPEN and still the owner's — it must not have been what lit
  // (5), which is why it stays in the table through every phase above.
  const stillOpen = await db.projectOpenItem.findUnique({ where: { id: mistaken.id } });
  assert.equal(stillOpen?.state, 'OPEN');
});
