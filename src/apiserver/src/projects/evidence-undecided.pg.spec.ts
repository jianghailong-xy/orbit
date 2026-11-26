/**
 * Evidence its coordinator has not decided reaches the owner after the project's window
 * (`EVIDENCE_UNDECIDED`, migration 1110, `evidence-undecided.ts`).
 *
 * Pinned here, against real PostgreSQL, through the services the API wires — the evidence doors
 * (`TaskCompletionEvidenceService.submit` / `decide`), the escalation clock
 * (`ProjectOpenItemEscalationService`) and the open-items read (`ProjectOpenItemService.list`):
 *
 *  - a latest revision undecided past the window opens exactly one owner item, in Needs you, with a
 *    Review action; another tick opens no second one;
 *  - a CONFIRM ends it (DECIDED), a SEND_BACK ends it (DECIDED), a newer revision ends it (REVISED);
 *  - a revision decided within the window opens nothing, however long afterwards the clock looks;
 *  - a revision still inside its window opens nothing;
 *  - a project that was never Automatic opens nothing (its evidence is the owner's card already);
 *  - an item whose task was cancelled is closed by the backstop (TASK_CLOSED).
 *
 * Those cases run with the project's coordinator DOWN (FAILED, no retry pending): the one state in which
 * the clock runs from submission whatever was delivered. The owner's rule for every exception item
 * (2026-10-08, contract revision 13 §4.6, `escalatesAt`) is pinned by the cases after them:
 *
 *  - a live coordinator that took the delivery up holds it: no item, however long past the window;
 *  - a live coordinator that has not taken it up (queued, or nothing delivered yet), and one parked on
 *    a retry it armed, hold it too;
 *  - a coordinator that took it up and then went down: the window runs from that delivery's taking-up;
 *  - a coordinator down that never took it up, one that ended, one with a cancel requested, and one
 *    switched off after being asked: an item one window after submission;
 *  - a coordinator that comes back and decides ends the item DECIDED.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied (`scripts/run-pg-spec.sh` provides one).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ownerItemKind } from './project-open-item';
import { completionEvidenceWakeKey } from './completion-input';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const KIND = 'EVIDENCE_UNDECIDED';
/** The project's window: the shortest the column accepts, so ageing a revision past it is small. */
const WINDOW_SECONDS = 300;
const MINUTE = 60_000;

/** Where the project's coordinator conversation stands. */
type CoordinatorState = 'live' | 'down' | 'retry' | 'ended' | 'cancelled';

function coordinatorColumns(state: CoordinatorState) {
  const failed = state === 'down' || state === 'retry';
  return {
    status: failed ? RunStatus.FAILED : RunStatus.AWAITING_INPUT,
    finishedAt: failed ? new Date() : null,
    // A failure release carries FAILED on its turn (removal step R2), which is what reads it as down since R7.
    lastTurnOutcome: failed ? 'FAILED' : null,
    retryAt: state === 'retry' ? new Date(Date.now() + 60 * MINUTE) : null,
    completedAt: state === 'ended' ? new Date() : null,
    cancelRequestedAt: state === 'cancelled' ? new Date() : null,
  };
}

async function fixture(
  db: PrismaClient,
  options: { coordinatorEnabled?: boolean; coordinator?: CoordinatorState } = {},
) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const workerSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const toolUseId = `toolu_undecided_${taskId.slice(0, 8)}`;
  await db.user.create({
    data: { id: ownerId, email: `undecided-${ownerId}@invalid.test`, name: 'Undecided', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'undecided-runner', tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'undecided-workspace', enabled: true } });
  const session = (id: string, forTask: string | null, title: string) => db.session.create({
    data: {
      id,
      ownerId,
      creatorId: ownerId,
      taskId: forTask,
      workspaceId,
      assignedRunnerId: runnerId,
      title,
      prompt: title,
      provider: 'claude',
      turnState: null,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: forTask !== null,
    },
  });
  await session(coordinatorSessionId, null, 'the coordinator');
  await db.session.update({
    where: { id: coordinatorSessionId },
    data: coordinatorColumns(options.coordinator ?? 'down'),
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: 'the project the evidence waits in',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
      exceptionEscalationSeconds: WINDOW_SECONDS,
    },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'Ship the queue drain',
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.OPEN,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: 'the queue drains',
    },
  });
  await session(workerSessionId, taskId, 'the run that did the work');
  await db.toolCall.create({
    data: { sessionId: workerSessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false },
  });
  return { ownerId, workspaceId, projectId, taskId, workerSessionId, coordinatorSessionId, toolUseId };
}

suite('evidence its coordinator has not decided reaches the owner after the window', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query('TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE');
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const evidence = new TaskCompletionEvidenceService(prisma);
  const clock = new ProjectOpenItemEscalationService(prisma);

  function harness(f: Awaited<ReturnType<typeof fixture>>) {
    const actor = { type: CreatorType.AGENT, id: f.workspaceId } as const;
    return {
      submit: (claim = 'the queue drains') => evidence.submit(f.ownerId, f.taskId, actor, {
        sourceSessionId: f.workerSessionId,
        evidence: { claim, checks: [{ kind: 'TOOL_CALL', ref: f.toolUseId }], gaps: [] },
      }),
      decide: (evidenceRevision: string, decision: 'CONFIRM' | 'SEND_BACK') => evidence.decide(
        f.ownerId, f.taskId, actor,
        {
          decidingSessionId: f.coordinatorSessionId,
          evidenceRevision,
          decision,
          ...(decision === 'SEND_BACK' ? { note: 'Show the drain under load.' } : {}),
        },
      ),
      /** Move a revision's submission back by `ms`, as if it had waited that long. */
      age: (revision: string, ms: number) => sql.query(
        `UPDATE "task_completion_evidence" SET "submitted_at" = "submitted_at" - ($1::int * interval '1 millisecond')
          WHERE "task_id" = $2 AND "revision" = $3`,
        [ms, f.taskId, revision],
      ),
      /** Where the coordinator conversation stands now: it goes down, comes back, ends. */
      coordinator: (state: CoordinatorState) => db.session.update({
        where: { id: f.coordinatorSessionId },
        data: coordinatorColumns(state),
      }),
      /**
       * The producer's delivery of a revision to the coordinator, as its ledger leaves it: a DELIVERED
       * wake under the revision's own key, naming the turn it wrote, and that turn — taken up `takenAgo`
       * ms ago, or still queued when null.
       */
      deliver: async (revision: string, takenAgo: number | null) => {
        const row = await db.taskCompletionEvidence.findFirstOrThrow({
          where: { taskId: f.taskId, revision: BigInt(revision) },
        });
        const clientTurnId = `evidence-delivery-${randomUUID()}`;
        const seq = (await db.conversationTurn.count({ where: { sessionId: f.coordinatorSessionId } })) + 1;
        await db.conversationTurn.create({
          data: {
            sessionId: f.coordinatorSessionId,
            seq,
            clientTurnId,
            kind: 'message',
            content: 'Decide this evidence.',
            status: takenAgo === null ? 'PENDING' : 'ANSWERED',
            deliveredAt: takenAgo === null ? null : new Date(Date.now() - takenAgo),
          },
        });
        const version = { revision, criterionRevision: row.criterionRevision, evidenceDigest: row.evidenceDigest };
        await db.projectCoordinatorWake.create({
          data: {
            id: randomUUID(),
            projectId: f.projectId,
            event: 'COMPLETION_EVIDENCE_REVISED',
            subjectType: 'TASK',
            subjectId: f.taskId,
            subjectVersion: [revision, row.criterionRevision, row.evidenceDigest].join(':'),
            idempotencyKey: completionEvidenceWakeKey(f.taskId, version),
            status: 'DELIVERED',
            sessionId: f.coordinatorSessionId,
            delivery: { clientTurnId },
          },
        });
      },
      items: () => db.projectOpenItem.findMany({
        where: { projectId: f.projectId, kind: KIND },
        orderBy: { createdAt: 'asc' },
      }),
    };
  }
  const pastTheWindow = WINDOW_SECONDS * 1_000 + MINUTE;
  const opened = async (projectId: string) =>
    (await clock.openUndecidedEvidenceItems()).filter((item) => item.projectId === projectId);

  await t.test('undecided past the window: exactly one owner item, in Needs you with Review; no duplicate on the next tick', async () => {
    const f = await fixture(db);
    const h = harness(f);
    const submitted = await h.submit();
    assert.equal(submitted.revision, '1');
    await h.age('1', pastTheWindow);

    const first = await opened(f.projectId);
    assert.equal(first.length, 1, 'one item for the one waiting revision');
    const [item] = await h.items();
    assert.equal(item.state, 'OPEN');
    assert.equal(item.assignee, 'OWNER');
    assert.equal(item.assigneeReason, 'ESCALATED');
    assert.equal(item.taskId, f.taskId);
    assert.equal(item.title, 'Evidence waiting for a decision: Ship the queue drain');
    assert.equal(ownerItemKind(item), 'ESCALATED', 'counted among the owner items Needs you shows');

    // The re-run: a tick a minute later, and another, open nothing new.
    assert.deepEqual(await opened(f.projectId), []);
    assert.deepEqual(await opened(f.projectId), []);
    assert.equal((await h.items()).length, 1, 'no duplicate item');

    const view = await openItems.list(f.ownerId, f.projectId);
    const row = view.needsYou.find((candidate) => candidate.kind === KIND);
    assert.ok(row, 'the item is in Needs you');
    assert.equal(row.taskId, f.taskId);
    assert.equal(row.primaryAction, 'REVIEW');
    assert.ok(row.actions.includes('REVIEW'), `Review is offered: ${row.actions.join(', ')}`);
    assert.match(row.detailLine, /^Revision 1 was submitted 6 minutes ago, and the coordinator has not decided it\.$/);
    assert.match(row.requiredAction ?? '', /The coordinator has not decided this evidence/);
    assert.equal(view.withCoordinator.some((candidate) => candidate.kind === KIND), false);
  });

  await t.test('a CONFIRM ends the item as DECIDED', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit();
    await h.age('1', pastTheWindow);
    assert.equal((await opened(f.projectId)).length, 1);
    await h.decide('1', 'CONFIRM');
    const [item] = await h.items();
    assert.equal(item.state, 'RESOLVED');
    assert.equal(item.resolution, 'DECIDED');
    assert.equal(item.resolvedBy, 'COORDINATOR');
    assert.equal(item.resolvedBySessionId, f.coordinatorSessionId);
    assert.equal((await openItems.list(f.ownerId, f.projectId)).needsYou.some((row) => row.kind === KIND), false);
    assert.deepEqual(await opened(f.projectId), [], 'a decided revision is not opened again');
  });

  await t.test('a SEND_BACK ends the item as DECIDED', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit();
    await h.age('1', pastTheWindow);
    assert.equal((await opened(f.projectId)).length, 1);
    await h.decide('1', 'SEND_BACK');
    const [item] = await h.items();
    assert.equal(item.state, 'RESOLVED');
    assert.equal(item.resolution, 'DECIDED');
    assert.deepEqual(await opened(f.projectId), [], 'a sent-back revision is not opened again');
  });

  await t.test('a newer revision ends the item as REVISED, and the new revision waits its own window', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit('first try');
    await h.age('1', pastTheWindow);
    assert.equal((await opened(f.projectId)).length, 1);
    const second = await h.submit('second try');
    assert.equal(second.revision, '2');
    const [old] = await h.items();
    assert.equal(old.state, 'SUPERSEDED');
    assert.equal(old.resolution, 'REVISED');
    assert.deepEqual(await opened(f.projectId), [], 'revision 2 is still inside its window');

    await h.age('2', pastTheWindow);
    assert.equal((await opened(f.projectId)).length, 1, 'revision 2 gets an item of its own once it waits it out');
    const all = await h.items();
    assert.equal(all.length, 2);
    assert.equal(all.filter((item) => item.state === 'OPEN').length, 1);
  });

  await t.test('evidence decided within the window raises nothing, however late the clock looks', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit();
    await h.age('1', 2 * MINUTE);
    await h.decide('1', 'SEND_BACK');
    await h.age('1', 10 * pastTheWindow);
    assert.deepEqual(await opened(f.projectId), []);
    assert.equal((await h.items()).length, 0);
  });

  await t.test('a revision still inside its window raises nothing', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit();
    await h.age('1', WINDOW_SECONDS * 1_000 - MINUTE);
    assert.deepEqual(await opened(f.projectId), []);
    assert.equal((await h.items()).length, 0);
  });

  await t.test('a project that was never Automatic raises nothing: its evidence is the owner\'s card already', async () => {
    const f = await fixture(db, { coordinatorEnabled: false });
    const h = harness(f);
    await h.submit();
    await h.age('1', pastTheWindow);
    assert.deepEqual(await opened(f.projectId), []);
    assert.equal((await h.items()).length, 0);
  });

  await t.test('an item whose task was cancelled is closed by the backstop as TASK_CLOSED', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit();
    await h.age('1', pastTheWindow);
    assert.equal((await opened(f.projectId)).length, 1);
    await db.task.update({ where: { id: f.taskId }, data: { status: TaskStatus.CANCELLED } });
    const closed = (await clock.reconcile()).filter((item) => item.projectId === f.projectId);
    assert.equal(closed.length, 1);
    const [item] = await h.items();
    assert.equal(item.state, 'RESOLVED');
    assert.equal(item.resolution, 'TASK_CLOSED');
    assert.equal(item.resolvedBy, 'PLATFORM');
    assert.match(item.resolutionNote ?? '', /^backstop: evidence /);
  });
  // The owner's rule for every exception item (2026-10-08, §4.6, `escalatesAt`), case by case.

  await t.test('a live coordinator that took the delivery up holds it: no item, however long past the window', async () => {
    const f = await fixture(db, { coordinator: 'live' });
    const h = harness(f);
    await h.submit();
    await h.age('1', 10 * pastTheWindow);
    await h.deliver('1', 9 * pastTheWindow);
    assert.deepEqual(await opened(f.projectId), []);
    assert.equal((await h.items()).length, 0);
  });

  await t.test('a live coordinator that has not taken the delivery up, or has been handed nothing yet, holds it too', async () => {
    const queued = await fixture(db, { coordinator: 'live' });
    const q = harness(queued);
    await q.submit();
    await q.age('1', 10 * pastTheWindow);
    await q.deliver('1', null);
    assert.deepEqual(await opened(queued.projectId), [], 'a queued delivery waits with no deadline');

    const nothing = await fixture(db, { coordinator: 'live' });
    const n = harness(nothing);
    await n.submit();
    await n.age('1', 10 * pastTheWindow);
    assert.deepEqual(await opened(nothing.projectId), [], 'nothing delivered yet: it waits for the coordinator');
  });

  await t.test('a coordinator parked on a retry it armed holds it: paused with an end is not down', async () => {
    const f = await fixture(db, { coordinator: 'retry' });
    const h = harness(f);
    await h.submit();
    await h.age('1', 10 * pastTheWindow);
    assert.deepEqual(await opened(f.projectId), []);
  });

  await t.test('a coordinator that took it up and then went down: the window runs from the taking-up', async () => {
    const f = await fixture(db, { coordinator: 'live' });
    const h = harness(f);
    await h.submit();
    await h.age('1', 3 * pastTheWindow);
    await h.deliver('1', MINUTE);
    await h.coordinator('down');
    assert.deepEqual(await opened(f.projectId), [], 'taken up a minute ago: inside the window');
    await sql.query(
      `UPDATE "conversation_turn" SET "delivered_at" = "delivered_at" - ($1::int * interval '1 millisecond')
        WHERE "session_id" = $2 AND "delivered_at" IS NOT NULL`,
      [pastTheWindow, f.coordinatorSessionId],
    );
    assert.equal((await opened(f.projectId)).length, 1, 'one window after the taking-up, the owner has it');
  });

  await t.test('a coordinator down that never took the delivery up: an item one window after submission', async () => {
    const f = await fixture(db, { coordinator: 'live' });
    const h = harness(f);
    await h.submit();
    await h.deliver('1', null);
    await h.coordinator('down');
    await h.age('1', WINDOW_SECONDS * 1_000 - MINUTE);
    assert.deepEqual(await opened(f.projectId), [], 'inside the window');
    await h.age('1', 2 * MINUTE);
    assert.equal((await opened(f.projectId)).length, 1);
  });

  for (const state of ['ended', 'cancelled'] as const) {
    await t.test(`a coordinator conversation that is ${state === 'ended' ? 'over' : 'being cancelled'}: an item one window after submission`, async () => {
      const f = await fixture(db, { coordinator: 'live' });
      const h = harness(f);
      await h.submit();
      await h.deliver('1', 2 * pastTheWindow);
      await h.coordinator(state);
      await h.age('1', 3 * pastTheWindow);
      assert.equal((await opened(f.projectId)).length, 1);
      const [item] = await h.items();
      assert.equal(item.assignee, 'OWNER');
    });
  }

  await t.test('a coordinator switched off after it was asked: an item one window after the taking-up', async () => {
    const f = await fixture(db, { coordinator: 'live' });
    const h = harness(f);
    await h.submit();
    await h.age('1', 3 * pastTheWindow);
    await h.deliver('1', 2 * pastTheWindow);
    await db.project.update({ where: { id: f.projectId }, data: { coordinatorEnabled: false } });
    assert.equal((await opened(f.projectId)).length, 1);
  });

  await t.test('a coordinator that comes back and decides ends the item as DECIDED', async () => {
    const f = await fixture(db, { coordinator: 'live' });
    const h = harness(f);
    await h.submit();
    await h.deliver('1', null);
    await h.coordinator('down');
    await h.age('1', pastTheWindow);
    assert.equal((await opened(f.projectId)).length, 1);
    await h.coordinator('live');
    assert.deepEqual(await opened(f.projectId), [], 'back and live: nothing new is opened');
    await h.decide('1', 'CONFIRM');
    const [item] = await h.items();
    assert.equal(item.state, 'RESOLVED');
    assert.equal(item.resolution, 'DECIDED');
    assert.equal(item.resolvedBySessionId, f.coordinatorSessionId);
  });
});
