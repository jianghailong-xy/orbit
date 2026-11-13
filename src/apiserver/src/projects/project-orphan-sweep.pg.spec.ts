import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
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
import { tellEvidenceUndecidable } from '../tasks/undecidable-evidence';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ORPHAN_SETTLE_MS, type PendingItem, readPendingAddressees } from './pending-addressees';
import { derivedUuid } from './project-dispatch-identity';
import { openItemTurnId } from './project-open-item';
import { ProjectOrphanSweepService } from './project-orphan-sweep.service';

/**
 * EVERY PENDING ITEM HAS AN ADDRESSEE; THE SWEEP REPORTS THE ONES THAT DO NOT, ONCE
 * (docs/evidence-always-has-an-addressee-design.md §4, criterion 4 of project 34w9J4ycWBHKATEW1R7Pr).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-orphan-sweep.pg.spec.ts
 *
 * The first case builds the state of 2026-11-12 — an unanswered latest revision that can no longer be
 * decided, its run idle, the Automatic coordinator never told — and shows the sweep messages the
 * coordinator exactly once and is quiet on the next pass. The others take each pending-item kind
 * (exception item, evidence, running run, waiting on dependencies) with an addressee that was told and
 * without one, and a project with no coordinator to tell, where the owner is told instead.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Past the settle window, as a sweep running a while after the state was built reads it. */
const later = () => new Date(Date.now() + ORPHAN_SETTLE_MS + 60_000);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

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
  sessions: SessionsService;
  evidence: TaskCompletionEvidenceService;
  sweep: ProjectOrphanSweepService;
  pushed: Array<{ ownerId: string; projectId: string; title: string; body: string }>;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const tasks = new TasksService(prisma as never, sessions, realtime);
  const pushed: Stack['pushed'] = [];
  const push = { notifyProjectOrphan: async (input: Stack['pushed'][number]) => { pushed.push(input); } } as unknown as PushService;
  return {
    db,
    prisma,
    sessions,
    // No completion-input router: a revision is recorded and handed to nobody, as on 2026-11-12.
    evidence: new TaskCompletionEvidenceService(prisma, tasks),
    sweep: new ProjectOrphanSweepService(prisma, sessions, push),
    pushed,
  };
}

interface Ids { ownerId: string; runnerId: string; workspaceId: string }

async function owner(db: PrismaClient, label: string): Promise<Ids> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: { id: ids.ownerId, email: `${label}-${ids.ownerId}@orphan.invalid`, name: label, passwordHash: 'x' },
  });
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
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-ws`,
      enabled: true,
      canCreateTasks: true,
      canDelegate: true,
    },
  });
  return ids;
}

/** A conversation with its opening prompt as a turn. */
async function conversation(
  db: PrismaClient,
  w: Ids,
  title: string,
  options: { status?: RunStatus; ended?: boolean; taskId?: string; at?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId: options.taskId,
      startsTaskWork: options.taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: options.status ?? RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      ...(options.at ? { createdAt: options.at, lastTurnAt: options.at } : { lastTurnAt: new Date() }),
      ...(options.ended ? { completedAt: new Date() } : {}),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: id,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(id),
      kind: 'message',
      content: title,
      status: 'ANSWERED',
      ...(options.at ? { createdAt: options.at } : {}),
    },
  });
  return id;
}

interface World extends Ids {
  project: string;
  /** The coordinator conversation, or null for a project with none. */
  coord: string | null;
}

async function world(
  stack: Stack,
  label: string,
  coordinator: 'automatic' | 'manual' | 'ended' | 'none' = 'automatic',
): Promise<World> {
  const ids = await owner(stack.db, label);
  const coord = coordinator === 'none'
    ? null
    : await conversation(stack.db, ids, `Coordinator: ${label}`, coordinator === 'ended'
      ? { status: RunStatus.SUCCEEDED, ended: true }
      : {});
  const project = randomUUID();
  await stack.db.project.create({
    data: {
      id: project,
      ownerId: ids.ownerId,
      title: `${label} project`,
      coordinatorEnabled: coordinator === 'automatic' || coordinator === 'ended',
      coordinatorWorkspaceId: ids.workspaceId,
      coordinatorSessionId: coord,
    },
  });
  await stack.db.projectRuntime.upsert({ where: { projectId: project }, create: { projectId: project }, update: {} });
  return { ...ids, project, coord };
}

async function task(
  stack: Stack,
  w: World,
  title: string,
  options: { status?: TaskStatus; autoRun?: boolean; criteria?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await stack.db.task.create({
    data: {
      id,
      ownerId: w.ownerId,
      projectId: w.project,
      title,
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      assigneeId: w.workspaceId,
      status: options.status ?? TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: options.criteria ?? `${title}: the work is done and its spec passes`,
      autoRunWhenReady: options.autoRun ?? true,
    },
  });
  return id;
}

/** A revision of the envelope a current runner sends, citing a tool call of `run`. */
async function submit(stack: Stack, w: World, taskId: string, run: string): Promise<string> {
  const cited = `toolu_orphan_${randomUUID().slice(0, 8)}`;
  await stack.db.toolCall.create({
    data: { sessionId: run, name: 'Bash', toolUseId: cited, input: { command: 'npm test' }, isError: false },
  });
  const receipt = await stack.evidence.submit(
    w.ownerId,
    taskId,
    { type: CreatorType.AGENT, id: w.workspaceId },
    {
      sourceSessionId: run,
      idempotencyKey: `${taskId}-1`,
      evidence: {
        claim: 'the work is done and its spec passes',
        checks: [{ kind: 'TOOL_CALL', ref: cited, command: 'npm test', succeeded: true }],
        gaps: [],
      },
    } as never,
  );
  return receipt.id;
}

/** Everything put on a conversation after its opening prompt, oldest first. */
function messagesOn(db: PrismaClient, sessionId: string | null) {
  if (sessionId === null) return Promise.resolve([]);
  return db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { not: SessionsService.initialTurnClientId(sessionId) } },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  });
}

async function itemOf(stack: Stack, w: World, taskId: string, readAt = later()): Promise<PendingItem> {
  const read = await readPendingAddressees(stack.prisma, w.ownerId, w.project, readAt);
  assert.ok(read, 'the project is not read');
  const item = read.items.find((candidate) => candidate.taskId === taskId);
  assert.ok(item, `task ${taskId} has no pending item`);
  return item;
}

const notices = (stack: Stack, w: World) => stack.db.projectOrphanNotice.findMany({
  where: { projectId: w.project }, orderBy: { createdAt: 'asc' },
});

function assertTold(item: PendingItem, kind: PendingItem['kind'], addressee: string, sessionId: string | null): void {
  assert.equal(item.kind, kind);
  assert.equal(item.addressee?.kind, addressee, `${kind}: addressed to ${item.addressee?.kind ?? 'nobody'}`);
  assert.equal(item.addressee?.sessionId ?? null, sessionId);
  assert.ok(item.notifiedAt instanceof Date, `${kind}: no notifiedAt`);
  assert.equal(item.orphan, false, `${kind}: an item that was told is an orphan`);
}

test('2026-11-12: an undecidable latest revision, an idle run, an Automatic coordinator nobody told — the sweep tells the coordinator exactly once', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'incident');
    const d = await task(stack, w, 'task D');
    const run = await conversation(stack.db, w, 'task D run', { taskId: d, status: RunStatus.AWAITING_INPUT });
    const evidenceId = await submit(stack, w, d, run);
    // The standard the revision is bound to changes after it was submitted, through no door that
    // tells anyone: exactly the revision that sat with nobody woken.
    await stack.db.task.update({ where: { id: d }, data: { acceptanceCriteria: 'task D: a different standard now' } });

    const item = await itemOf(stack, w, d);
    assert.equal(item.kind, 'EVIDENCE');
    assert.equal(item.subjectId, evidenceId);
    assert.deepEqual(item.addressee, { kind: 'RUN', sessionId: run }, 'the run is not the one who can file it again');
    assert.equal(item.notifiedAt, null);
    assert.equal(item.notifiedAtAbsentReason, 'NEVER_TOLD');
    assert.equal(item.orphan, true, 'an undecidable revision its run was never told about is not an orphan');
    assert.equal((await itemOf(stack, w, d, new Date())).orphan, false, 'a state that has just changed is judged before it settles');
    assert.deepEqual(await messagesOn(stack.db, w.coord), [], 'the coordinator was told before the sweep');

    // The periodic sweep, over every project.
    const first = (await stack.sweep.sweep(later())).filter((report) => report.projectId === w.project);
    assert.equal(first.length, 1, 'the orphan was not reported once');
    assert.equal(first[0]!.recipient, 'COORDINATOR');
    const told = await messagesOn(stack.db, w.coord);
    assert.equal(told.length, 1, 'the coordinator was messaged other than once');
    assert.equal(told[0]!.clientTurnId, derivedUuid(`project-orphan:v1:${w.project}:${item.orphanKey}`));
    const says = told[0]!.content ?? '';
    assert.ok(says.includes('task D'));
    assert.ok(says.includes(uuidToBase62(run)), 'the message does not name the run that can file it again');
    assert.ok(says.includes('task_start'), 'the message does not say what would move it');
    assert.ok(!says.includes('task_evidence_decide'), 'the coordinator is asked to decide a revision nobody can');
    assert.deepEqual(await messagesOn(stack.db, run), [], 'the sweep wrote to the run');

    // The next passes: quiet, though nothing changed and the item is still an orphan.
    assert.equal((await itemOf(stack, w, d)).orphan, true);
    assert.deepEqual((await stack.sweep.sweep(later())).filter((report) => report.projectId === w.project), []);
    assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, later()), []);
    assert.equal((await messagesOn(stack.db, w.coord)).length, 1, 'the next pass said something more');
    const ledger = await notices(stack, w);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!.recipient, 'COORDINATOR');
    assert.equal(ledger[0]!.sessionId, w.coord);
    assert.equal(stack.pushed.length, 0, 'the owner was pushed though the coordinator was told');

    // Once the shared undecidable path tells the run, the revision has an addressee who was told.
    await tellEvidenceUndecidable(stack.prisma, stack.sessions, { ownerId: w.ownerId, taskId: d, cause: { kind: 'CRITERIA_CHANGED' } });
    assertTold(await itemOf(stack, w, d), 'EVIDENCE', 'RUN', run);
  } finally {
    await stack.db.$disconnect();
  }
});

test('evidence with an addressee that was told: the owner\'s card in a project the coordinator does not decide; the coordinator, once its notice is written', { skip }, async () => {
  const stack = await connect();
  try {
    const manual = await world(stack, 'evidence-manual', 'manual');
    const t = await task(stack, manual, 'manual task');
    const run = await conversation(stack.db, manual, 'manual run', { taskId: t });
    await submit(stack, manual, t, run);
    assertTold(await itemOf(stack, manual, t), 'EVIDENCE', 'OWNER', null);

    // Undecidable with no live run: the Automatic coordinator's to act on, told by the shared path.
    const auto = await world(stack, 'evidence-auto');
    const u = await task(stack, auto, 'ended-run task');
    const ended = await conversation(stack.db, auto, 'ended run', { taskId: u });
    await submit(stack, auto, u, ended);
    await stack.db.session.update({ where: { id: ended }, data: { status: RunStatus.SUCCEEDED, completedAt: new Date() } });
    await stack.db.task.update({ where: { id: u }, data: { acceptanceCriteria: 'reworded after the run ended' } });
    const untold = await itemOf(stack, auto, u);
    assert.deepEqual(untold.addressee, { kind: 'COORDINATOR', sessionId: auto.coord });
    assert.equal(untold.orphan, true, 'the coordinator was never told, and that is not an orphan');
    await tellEvidenceUndecidable(stack.prisma, stack.sessions, { ownerId: auto.ownerId, taskId: u, cause: { kind: 'CRITERIA_CHANGED' } });
    assertTold(await itemOf(stack, auto, u), 'EVIDENCE', 'COORDINATOR', auto.coord);

    for (const w of [manual, auto]) {
      const before = await messagesOn(stack.db, w.coord);
      assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, later()), [], 'an item that was told is reported');
      assert.deepEqual(await messagesOn(stack.db, w.coord), before);
      assert.deepEqual(await notices(stack, w), []);
    }
  } finally {
    await stack.db.$disconnect();
  }
});

test('an exception item: told when its turn was queued on the coordinator; an orphan when it never was, or when its coordinator has ended', { skip }, async () => {
  const stack = await connect();
  try {
    const failed = async (w: World, title: string, delivered: boolean) => {
      const t = await task(stack, w, title, { status: TaskStatus.FAILED });
      const assignedAt = hoursAgo(1);
      const item = await stack.db.projectOpenItem.create({
        data: {
          projectId: w.project,
          ownerId: w.ownerId,
          kind: 'TASK_FAILED',
          assignee: 'COORDINATOR',
          assigneeReason: 'DEFAULT',
          taskId: t,
          dedupeKey: `TF:${t}:1`,
          title: `${title} failed`,
          payload: {},
          waitingSince: assignedAt,
          assignedAt,
        },
      });
      if (delivered) {
        await stack.db.projectOpenItemDelivery.create({
          data: { itemId: item.id, projectId: w.project, sessionId: w.coord!, purpose: 'ITEM', clientTurnId: openItemTurnId(item.id, assignedAt) },
        });
      }
      return { task: t, item: item.id };
    };

    const w = await world(stack, 'exception');
    const told = await failed(w, 'delivered task', true);
    const untold = await failed(w, 'undelivered task', false);
    assertTold(await itemOf(stack, w, told.task), 'EXCEPTION_ITEM', 'COORDINATOR', w.coord);
    const orphan = await itemOf(stack, w, untold.task);
    assert.equal(orphan.kind, 'EXCEPTION_ITEM');
    assert.equal(orphan.subjectId, untold.item);
    assert.deepEqual(orphan.addressee, { kind: 'COORDINATOR', sessionId: w.coord });
    assert.equal(orphan.notifiedAtAbsentReason, 'NEVER_TOLD');
    assert.equal(orphan.orphan, true);

    const reports = await stack.sweep.sweepProject(w.ownerId, w.project, later());
    assert.deepEqual(reports.map((report) => report.taskIds), [[untold.task]]);
    const said = await messagesOn(stack.db, w.coord);
    assert.equal(said.length, 1);
    assert.ok((said[0]!.content ?? '').includes('undelivered task failed'));
    assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, later()), []);
    assert.equal((await messagesOn(stack.db, w.coord)).length, 1);

    // Its coordinator conversation is over: nobody can read it, and the owner is told.
    const gone = await world(stack, 'exception-ended', 'ended');
    const stranded = await failed(gone, 'stranded task', false);
    const nobody = await itemOf(stack, gone, stranded.task);
    assert.equal(nobody.addressee, null);
    assert.equal(nobody.addresseeAbsentReason, 'COORDINATOR_ENDED');
    assert.equal(nobody.orphan, true);
    const pushedBefore = stack.pushed.length;
    const toOwner = await stack.sweep.sweepProject(gone.ownerId, gone.project, later());
    assert.deepEqual(toOwner.map((report) => report.recipient), ['OWNER']);
    assert.equal(stack.pushed.length, pushedBefore + 1);
    assert.equal(stack.pushed.at(-1)!.ownerId, gone.ownerId);
    assert.ok(stack.pushed.at(-1)!.body.includes('stranded task failed'));
    assert.deepEqual(await messagesOn(stack.db, gone.coord), [], 'an ended coordinator was written to');
    assert.deepEqual(await stack.sweep.sweepProject(gone.ownerId, gone.project, later()), []);
    assert.equal(stack.pushed.length, pushedBefore + 1, 'the owner was pushed twice');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a running task run: its own addressee while it works, has a job running or a wake-up waiting; nobody once it has been quiet for the window', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'runs');
    const working = await task(stack, w, 'working task');
    const workingRun = await conversation(stack.db, w, 'working run', { taskId: working, status: RunStatus.RUNNING });
    const quiet = await task(stack, w, 'quiet task');
    const quietRun = await conversation(stack.db, w, 'quiet run', { taskId: quiet, at: hoursAgo(3) });
    const waking = await task(stack, w, 'waking task');
    const wakingRun = await conversation(stack.db, w, 'waking run', { taskId: waking, at: hoursAgo(3) });
    await stack.db.sessionScheduledWakeup.create({
      data: { sessionId: wakingRun, delaySeconds: 3_600, reason: 'waiting for CI', dueAt: new Date(Date.now() + 3_600_000) },
    });
    const building = await task(stack, w, 'building task');
    const buildingRun = await conversation(stack.db, w, 'building run', { taskId: building, at: hoursAgo(3) });
    await stack.db.session.update({ where: { id: buildingRun }, data: { runningBgJobs: ['bgj_build'] } });
    const reporting = await task(stack, w, 'reporting task');
    const reportingRun = await conversation(stack.db, w, 'reporting run', { taskId: reporting, at: hoursAgo(3) });
    await stack.db.taskProgress.create({ data: { taskId: reporting, phase: 'tests', lastProgressAt: hoursAgo(0.5), revision: 1 } });

    assertTold(await itemOf(stack, w, working), 'TASK_RUN', 'RUN', workingRun);
    assertTold(await itemOf(stack, w, waking), 'TASK_RUN', 'RUN', wakingRun);
    assertTold(await itemOf(stack, w, building), 'TASK_RUN', 'RUN', buildingRun);
    assertTold(await itemOf(stack, w, reporting), 'TASK_RUN', 'RUN', reportingRun);
    const orphan = await itemOf(stack, w, quiet);
    assert.equal(orphan.kind, 'TASK_RUN');
    assert.equal(orphan.subjectId, quietRun);
    assert.equal(orphan.addressee, null);
    assert.equal(orphan.addresseeAbsentReason, 'RUN_QUIET');
    assert.equal(orphan.orphan, true);

    const reports = await stack.sweep.sweepProject(w.ownerId, w.project, later());
    assert.deepEqual(reports.map((report) => report.taskIds), [[quiet]]);
    const said = await messagesOn(stack.db, w.coord);
    assert.equal(said.length, 1);
    assert.ok((said[0]!.content ?? '').includes(uuidToBase62(quietRun)));
    assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, later()), []);
    assert.equal((await messagesOn(stack.db, w.coord)).length, 1);

    // The run takes a turn and goes quiet again: a new state, reported once more.
    const back = hoursAgo(2.5);
    await stack.db.session.update({ where: { id: quietRun }, data: { lastTurnAt: back } });
    assert.notEqual((await itemOf(stack, w, quiet)).orphanKey, orphan.orphanKey);
    assert.equal((await stack.sweep.sweepProject(w.ownerId, w.project, later())).length, 1);
    assert.equal((await messagesOn(stack.db, w.coord)).length, 2);
  } finally {
    await stack.db.$disconnect();
  }
});

test('a task waiting on dependencies: its prerequisite\'s addressee; one report for an orphan prerequisite and everything behind it', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'deps');
    const dependsOn = (dependent: string, prerequisite: string) => stack.db.taskDependency.create({
      data: { taskId: dependent, dependsOnTaskId: prerequisite },
    });

    // Behind a run that is working: the run.
    const busy = await task(stack, w, 'busy prerequisite');
    const busyRun = await conversation(stack.db, w, 'busy run', { taskId: busy, status: RunStatus.RUNNING });
    const behindBusy = await task(stack, w, 'behind the busy one', { status: TaskStatus.OPEN });
    await dependsOn(behindBusy, busy);
    const item = await itemOf(stack, w, behindBusy);
    assertTold(item, 'DEPENDENCIES', 'RUN', busyRun);
    assert.equal(item.waitsOnTaskId, busy);

    // Behind a prerequisite that will start by itself: the platform's.
    const queued = await task(stack, w, 'auto-run prerequisite', { status: TaskStatus.OPEN });
    const behindQueued = await task(stack, w, 'behind the auto-run one', { status: TaskStatus.OPEN });
    await dependsOn(behindQueued, queued);
    assertTold(await itemOf(stack, w, behindQueued), 'DEPENDENCIES', 'PLATFORM', null);

    // Behind a prerequisite nobody will start: nobody.
    const manual = await task(stack, w, 'manual prerequisite', { status: TaskStatus.OPEN, autoRun: false });
    const behindManual = await task(stack, w, 'behind the manual one', { status: TaskStatus.OPEN });
    await dependsOn(behindManual, manual);
    const stuck = await itemOf(stack, w, behindManual);
    assert.equal(stuck.addressee, null);
    assert.equal(stuck.addresseeAbsentReason, 'PREREQUISITE_NOT_MOVING');
    assert.equal(stuck.waitsOnTaskId, manual);
    assert.equal(stuck.orphan, true);

    // Two deep behind a quiet run: every one of them carries the run's orphan key.
    const quiet = await task(stack, w, 'quiet prerequisite');
    await conversation(stack.db, w, 'quiet run', { taskId: quiet, at: hoursAgo(3) });
    const middle = await task(stack, w, 'middle task', { status: TaskStatus.OPEN });
    const last = await task(stack, w, 'last task', { status: TaskStatus.OPEN });
    await dependsOn(middle, quiet);
    await dependsOn(last, middle);
    const root = await itemOf(stack, w, quiet);
    assert.equal(root.addresseeAbsentReason, 'RUN_QUIET');
    for (const id of [middle, last]) {
      const behind = await itemOf(stack, w, id);
      assert.equal(behind.kind, 'DEPENDENCIES');
      assert.equal(behind.orphanKey, root.orphanKey, 'a dependent is reported apart from the orphan it waits on');
      assert.equal(behind.orphan, true);
    }

    const reports = await stack.sweep.sweepProject(w.ownerId, w.project, later());
    assert.equal(reports.length, 2, 'not one report per orphan');
    const forQuiet = reports.find((report) => report.orphanKey === root.orphanKey)!;
    assert.deepEqual(new Set(forQuiet.taskIds), new Set([quiet, middle, last]));
    assert.deepEqual(reports.find((report) => report !== forQuiet)!.taskIds, [behindManual]);
    const said = await messagesOn(stack.db, w.coord);
    assert.equal(said.length, 2);
    const aboutQuiet = said.find((turn) => (turn.content ?? '').includes('quiet prerequisite'))!.content ?? '';
    assert.ok(aboutQuiet.includes('middle task') && aboutQuiet.includes('last task'), 'the report does not name what waits behind it');
    assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, later()), []);
    assert.equal((await messagesOn(stack.db, w.coord)).length, 2);
  } finally {
    await stack.db.$disconnect();
  }
});

test('no coordinator to tell — none at all, or a Manual one — the owner is told, once, and no conversation is written to', { skip }, async () => {
  const stack = await connect();
  try {
    for (const mode of ['none', 'manual'] as const) {
      const w = await world(stack, `owner-${mode}`, mode);
      const quiet = await task(stack, w, `${mode} quiet task`);
      const run = await conversation(stack.db, w, `${mode} quiet run`, { taskId: quiet, at: hoursAgo(3) });
      assert.equal((await itemOf(stack, w, quiet)).orphan, true);

      const pushedBefore = stack.pushed.length;
      const reports = await stack.sweep.sweepProject(w.ownerId, w.project, later());
      assert.deepEqual(reports.map((report) => [report.recipient, report.sessionId]), [['OWNER', null]]);
      assert.equal(stack.pushed.length, pushedBefore + 1, `${mode}: the owner was not pushed once`);
      const pushed = stack.pushed.at(-1)!;
      assert.equal(pushed.ownerId, w.ownerId);
      assert.equal(pushed.projectId, w.project);
      assert.ok(pushed.body.includes(`${mode} quiet task`));
      const ledger = await notices(stack, w);
      assert.deepEqual(ledger.map((row) => row.recipient), ['OWNER']);
      assert.deepEqual(await messagesOn(stack.db, w.coord), [], `${mode}: a coordinator conversation was written to`);
      assert.deepEqual(await messagesOn(stack.db, run), []);

      assert.deepEqual(await stack.sweep.sweepProject(w.ownerId, w.project, later()), []);
      assert.equal(stack.pushed.length, pushedBefore + 1, `${mode}: the owner was pushed again`);
    }
  } finally {
    await stack.db.$disconnect();
  }
});

test('the read is the owner\'s: another account\'s project is not read', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'tenant');
    const other = await owner(stack.db, 'tenant-other');
    assert.equal(await readPendingAddressees(stack.prisma, other.ownerId, w.project), null);
    assert.deepEqual(await stack.sweep.sweepProject(other.ownerId, w.project, later()), []);
  } finally {
    await stack.db.$disconnect();
  }
});
