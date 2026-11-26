import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskCompletionEvidenceService } from '../tasks/task-completion-evidence.service';
import { TasksService } from '../tasks/tasks.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { EVIDENCE_UNDECIDED_KIND, evidenceUndecidedDedupeKey, evidenceUndecidedDetailLine } from './evidence-undecided';
import { ORPHAN_SETTLE_MS, readPendingAddressees } from './pending-addressees';
import { openItemTurnId } from './project-open-item';
import { ProjectOrphanSweepService } from './project-orphan-sweep.service';

/**
 * EVIDENCE NOBODY CAN DECIDE IS REPORTED, THEN ESCALATED
 * (project 34xLkkpjrrFbUzGhsgy7f, criterion 34qvp8SfHnGfeJ34xvuOWw).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/undecidable-evidence-escalation.pg.spec.ts
 *
 * The M2 case of 2026-11-12 (task 34wRI2JqCvMMQ4hruFvch, revision 3): a task that declares a project
 * criterion, a revision of its evidence quoting the task's own id instead of that criterion's key, so
 * the decision door refuses every answer to it (EVIDENCE_JUDGMENT_CRITERION_MOVED); its run still
 * live and idle; its Automatic coordinator live; and an open MAIN_SYNC conflict item about the task
 * that the coordinator had been handed. That item was the task's one pending item, so the revision
 * never read as an orphan and nobody was told for 33 hours. The spec asserts the sweep's notice to the
 * coordinator, then nothing for the owner before the project's `exceptionEscalationSeconds`, then the
 * owner's one EVIDENCE_UNDECIDED item and its push after it.
 *
 * The server now binds the standard at submission and a later task (T1) may refuse a wrong quote at
 * the door, so the wrong-key revision is made the way the old server stored M2's: a submission
 * through today's door, whose stored quote is then rewritten to the task's own id. That reaches the
 * same row whatever the door does. A second case moves the criterion's text after submission, through
 * no door that tells anyone, and a third takes a revision handed to nobody at all.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The project default the owner agreed to on 2026-11-14 (`exceptionEscalationSeconds`). */
const DEFAULT_WINDOW_SECONDS = 7_200;
const STANDARD = 'The iOS Settings › Sessions page draws Translation before Session orchestration.';

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  evidence: TaskCompletionEvidenceService;
  sweep: ProjectOrphanSweepService;
  orphanPushes: Array<{ ownerId: string; projectId: string }>;
  ownerItemPushes: string[];
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma as never, sessions, realtime);
  const orphanPushes: Stack['orphanPushes'] = [];
  const ownerItemPushes: string[] = [];
  const push = {
    notifyProjectOrphan: async (input: Stack['orphanPushes'][number]) => { orphanPushes.push(input); },
    notifyOwnerItem: async (itemId: string) => { ownerItemPushes.push(itemId); },
  } as unknown as PushService;
  return {
    db,
    prisma,
    // No completion-input router: whatever the revision is, the platform hands it to nobody here.
    evidence: new TaskCompletionEvidenceService(prisma, tasks),
    sweep: new ProjectOrphanSweepService(prisma, sessions, push),
    orphanPushes,
    ownerItemPushes,
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  project: string;
  coord: string;
  criterion: string;
}

async function conversation(
  db: PrismaClient,
  w: Pick<World, 'ownerId' | 'runnerId' | 'workspaceId'>,
  title: string,
  taskId?: string,
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId,
      startsTaskWork: taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      turnState: null,
      dispatchOrigin: SessionDispatchOrigin.USER,
      lastTurnAt: new Date(),
    },
  });
  await db.conversationTurn.create({
    data: { sessionId: id, seq: 1, clientTurnId: SessionsService.initialTurnClientId(id), kind: 'message', content: title, status: 'ANSWERED' },
  });
  return id;
}

/** An owner, a runner, an Automatic project with a live coordinator and one criterion, at the default window. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({ data: { id: ids.ownerId, email: `${label}-${ids.ownerId}@escalation.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-ws`, enabled: true, canCreateTasks: true, canDelegate: true },
  });
  const coord = await conversation(db, ids, `Coordinator: ${label}`);
  const project = randomUUID();
  await db.project.create({
    data: {
      id: project,
      ownerId: ids.ownerId,
      title: `${label} project`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: ids.workspaceId,
      coordinatorSessionId: coord,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId: project }, create: { projectId: project }, update: {} });
  const criterion = randomUUID();
  await db.projectAcceptanceCriterionDefinition.create({
    data: { id: criterion, projectId: project, ordinal: 1, text: STANDARD, verificationMethod: 'A Swift test pins the order.', contentHash: '0'.repeat(64) },
  });
  return { ...ids, project, coord, criterion };
}

/** A task held to the project's criterion (criterionKey), with a live, idle run. */
async function declaredTask(db: PrismaClient, w: World, title: string): Promise<{ task: string; run: string }> {
  const task = randomUUID();
  await db.task.create({
    data: {
      id: task,
      ownerId: w.ownerId,
      projectId: w.project,
      title,
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      assigneeId: w.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: `${title}: its own notes, which are not the standard it is held to`,
      criterionDefinitionId: w.criterion,
      criterionRevision: 1,
    },
  });
  return { task, run: await conversation(db, w, `${title} run`, task) };
}

async function submit(stack: Stack, w: World, taskId: string, run: string): Promise<string> {
  const cited = `toolu_escalation_${randomUUID().slice(0, 8)}`;
  await stack.db.toolCall.create({
    data: { sessionId: run, name: 'Bash', toolUseId: cited, input: { command: 'swift test' }, isError: false },
  });
  const receipt = await stack.evidence.submit(
    w.ownerId,
    taskId,
    { type: CreatorType.AGENT, id: w.workspaceId },
    {
      sourceSessionId: run,
      idempotencyKey: `${taskId}-rev`,
      evidence: {
        claim: 'Translation is drawn before Session orchestration, and the Swift test pins it.',
        checks: [{ kind: 'TOOL_CALL', ref: cited, command: 'swift test', succeeded: true }],
        gaps: [],
      },
    } as never,
  );
  return receipt.id;
}

/** M2's open MAIN_SYNC conflict item about the task, already handed to the coordinator. */
async function mainSyncItemHandedToCoordinator(db: PrismaClient, w: World, taskId: string): Promise<string> {
  const assignedAt = new Date(Date.now() - 5 * 3_600_000);
  const item = await db.projectOpenItem.create({
    data: {
      projectId: w.project,
      ownerId: w.ownerId,
      kind: 'INTEGRATION_CONFLICT',
      assignee: 'COORDINATOR',
      assigneeReason: 'DEFAULT',
      taskId,
      dedupeKey: `IC:${taskId}:MAIN_SYNC`,
      title: 'Main sync conflict',
      payload: { sourceJob: 'MAIN_SYNC', failureClass: 'CONFLICT' },
      waitingSince: assignedAt,
      assignedAt,
    },
  });
  await db.projectOpenItemDelivery.create({
    data: { itemId: item.id, projectId: w.project, sessionId: w.coord, purpose: 'ITEM', clientTurnId: openItemTurnId(item.id, assignedAt) },
  });
  return item.id;
}

function messagesOn(db: PrismaClient, sessionId: string) {
  return db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { not: SessionsService.initialTurnClientId(sessionId) } },
    select: { content: true, createdAt: true },
    orderBy: { seq: 'asc' },
  });
}

const ownerItems = (db: PrismaClient, w: World) => db.projectOpenItem.findMany({
  where: { projectId: w.project, kind: EVIDENCE_UNDECIDED_KIND },
});

/**
 * The sweep after the notice and around the window: nothing just before it, one owner item and one
 * push just after it, and nothing more on the next pass.
 */
async function assertEscalatesAfterWindow(stack: Stack, w: World, taskId: string, evidenceId: string, noticeAt: Date, route: string) {
  const window = (await stack.db.project.findUniqueOrThrow({ where: { id: w.project }, select: { exceptionEscalationSeconds: true } }))
    .exceptionEscalationSeconds;
  assert.equal(window, DEFAULT_WINDOW_SECONDS, 'the project is not at the default window');
  const at = (offsetMs: number) => new Date(noticeAt.getTime() + window * 1_000 + offsetMs);

  await stack.sweep.sweepProject(w.ownerId, w.project, at(-60_000));
  assert.deepEqual(await ownerItems(stack.db, w), [], 'the owner was asked before the window ran out');
  assert.deepEqual(stack.ownerItemPushes, []);

  await stack.sweep.sweepProject(w.ownerId, w.project, at(60_000));
  const [item, ...more] = await ownerItems(stack.db, w);
  assert.ok(item, 'no owner item once the window ran out');
  assert.deepEqual(more, []);
  assert.equal(item.state, 'OPEN');
  assert.equal(item.assignee, 'OWNER');
  assert.equal(item.assigneeReason, 'ESCALATED');
  assert.equal(item.taskId, taskId);
  assert.equal(item.dedupeKey, evidenceUndecidedDedupeKey(evidenceId));
  const payload = item.payload as Record<string, unknown>;
  assert.equal(payload.evidenceId, evidenceId);
  assert.equal(payload.route, route);
  assert.equal(payload.windowSeconds, DEFAULT_WINDOW_SECONDS);
  assert.deepEqual(stack.ownerItemPushes, [item.id], 'the owner was not pushed the item once');
  const line = evidenceUndecidedDetailLine(item.payload, at(60_000));
  assert.ok(line.startsWith('Revision 1 was submitted'), line);

  await stack.sweep.sweepProject(w.ownerId, w.project, at(10 * 60_000));
  assert.equal((await ownerItems(stack.db, w)).length, 1, 'a second owner item');
  assert.equal(stack.ownerItemPushes.length, 1, 'a second push');
}

test('M2: a revision quoting the task id on a task with criterionKey, hidden behind its MAIN_SYNC item — the coordinator is told within minutes, the owner after exceptionEscalationSeconds', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack.db, 'm2');
    const { task, run } = await declaredTask(stack.db, w, 'M2 · iOS Translation order');
    await mainSyncItemHandedToCoordinator(stack.db, w, task);
    const evidenceId = await submit(stack, w, task, run);
    // As the server before 53a655d6a1 stored M2's revision 3: the quote the run sent, the task's id.
    const row = await stack.db.taskCompletionEvidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { evidence: true } });
    const quotedTaskId = { ...(row.evidence as Record<string, unknown>), criterion: { key: uuidToBase62(task), text: STANDARD } };
    await stack.db.taskCompletionEvidence.update({ where: { id: evidenceId }, data: { evidence: quotedTaskId } });
    const submittedAt = new Date();

    // The state of 2026-11-12: the task's one pending item is the MAIN_SYNC item the coordinator has,
    // so the per-task read shows no orphan, and nobody has been told about the revision.
    const settled = new Date(submittedAt.getTime() + ORPHAN_SETTLE_MS + 60_000);
    const read = await readPendingAddressees(stack.prisma, w.ownerId, w.project, settled);
    const own = read!.items.find((item) => item.taskId === task)!;
    assert.equal(own.kind, 'EXCEPTION_ITEM');
    assert.equal(own.orphan, false);
    const coordinatorBefore = (await messagesOn(stack.db, w.coord)).length;

    // Within minutes: the first sweep past the settle window tells the coordinator.
    const reports = await stack.sweep.sweepProject(w.ownerId, w.project, settled);
    assert.equal(reports.length, 1, 'the undecidable revision was not reported');
    assert.equal(reports[0]!.recipient, 'COORDINATOR');
    assert.ok(reports[0]!.orphanKey.startsWith(`EVIDENCE:${evidenceId}:UNDECIDABLE:`), reports[0]!.orphanKey);
    const told = (await messagesOn(stack.db, w.coord)).slice(coordinatorBefore);
    assert.equal(told.length, 1, 'the coordinator was not told once');
    const says = told[0]!.content ?? '';
    assert.ok(says.includes('M2 · iOS Translation order'), says);
    assert.ok(says.includes('cannot be decided'), says);
    assert.ok(says.includes(uuidToBase62(task)), says);
    assert.deepEqual(stack.orphanPushes, [], 'the owner was pushed though the coordinator was told');
    assert.deepEqual(await ownerItems(stack.db, w), [], 'the owner was asked at once');

    // The next pass is quiet.
    assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, new Date(settled.getTime() + 60_000)), []);

    const notice = await stack.db.projectOrphanNotice.findFirstOrThrow({ where: { projectId: w.project } });
    await assertEscalatesAfterWindow(stack, w, task, evidenceId, notice.createdAt, 'UNDECIDABLE');
    const [item] = await ownerItems(stack.db, w);
    const line = evidenceUndecidedDetailLine(item!.payload);
    assert.ok(line.includes('cannot be decided'), line);

    // A new revision ends it: the submission door's edge.
    const next = await stack.evidence.submit(
      w.ownerId,
      task,
      { type: CreatorType.AGENT, id: w.workspaceId },
      {
        sourceSessionId: run,
        idempotencyKey: `${task}-rev-2`,
        evidence: { claim: 'Revision 2, against the declared criterion.', checks: [{ kind: 'TOOL_CALL', ref: (await stack.db.toolCall.findFirstOrThrow({ where: { sessionId: run } })).toolUseId }], gaps: [] },
      } as never,
    );
    assert.notEqual(next.id, evidenceId);
    const [ended] = await ownerItems(stack.db, w);
    assert.equal(ended!.state, 'SUPERSEDED');
  } finally {
    await stack.db.$disconnect();
  }
});

test('the criterion text moves after submission, through no door that tells anyone: the same notice, then the owner after the window', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack.db, 'reworded');
    const { task, run } = await declaredTask(stack.db, w, 'Reworded task');
    const evidenceId = await submit(stack, w, task, run);
    await stack.db.projectAcceptanceCriterionDefinition.update({
      where: { id: w.criterion },
      data: { text: `${STANDARD} And Android matches it.`, revision: 2 },
    });

    const settled = new Date(Date.now() + ORPHAN_SETTLE_MS + 60_000);
    const reports = await stack.sweep.sweepProject(w.ownerId, w.project, settled);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.recipient, 'COORDINATOR');
    assert.ok(reports[0]!.orphanKey.startsWith(`EVIDENCE:${evidenceId}:UNDECIDABLE:`), reports[0]!.orphanKey);
    const [told] = await messagesOn(stack.db, w.coord);
    assert.ok((told?.content ?? '').includes('cannot be decided'));

    const notice = await stack.db.projectOrphanNotice.findFirstOrThrow({ where: { projectId: w.project } });
    await assertEscalatesAfterWindow(stack, w, task, evidenceId, notice.createdAt, 'UNDECIDABLE');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a decidable revision submitted and handed to nobody: the coordinator is told, then the owner after the window', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack.db, 'undelivered');
    const { task, run } = await declaredTask(stack.db, w, 'Undelivered task');
    const evidenceId = await submit(stack, w, task, run);

    const settled = new Date(Date.now() + ORPHAN_SETTLE_MS + 60_000);
    const reports = await stack.sweep.sweepProject(w.ownerId, w.project, settled);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.recipient, 'COORDINATOR');
    assert.equal(reports[0]!.orphanKey, `EVIDENCE:${evidenceId}:DECIDABLE:COORDINATOR`);
    const [told] = await messagesOn(stack.db, w.coord);
    assert.ok((told?.content ?? '').includes('never handed to the coordinator'), told?.content ?? '');

    const notice = await stack.db.projectOrphanNotice.findFirstOrThrow({ where: { projectId: w.project } });
    await assertEscalatesAfterWindow(stack, w, task, evidenceId, notice.createdAt, 'UNDELIVERED');
  } finally {
    await stack.db.$disconnect();
  }
});
