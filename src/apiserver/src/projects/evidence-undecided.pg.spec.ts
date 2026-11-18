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
 *  - a project whose coordinator switch is off opens nothing (its evidence is the owner's card already);
 *  - an item whose task was cancelled is closed by the backstop (TASK_CLOSED).
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
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
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

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const KIND = 'EVIDENCE_UNDECIDED';
/** The project's window: the shortest the column accepts, so ageing a revision past it is small. */
const WINDOW_SECONDS = 300;
const MINUTE = 60_000;

async function fixture(db: PrismaClient, options: { coordinatorEnabled?: boolean } = {}) {
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
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: forTask !== null,
    },
  });
  await session(coordinatorSessionId, null, 'the coordinator');
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

  await t.test('a project whose coordinator switch is off raises nothing: its evidence is the owner\'s card already', async () => {
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
});
