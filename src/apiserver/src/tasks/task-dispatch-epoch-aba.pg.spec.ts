import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  CreatorType,
  PrismaClient,
  ProjectAutomationPolicy,
  RunStatus,
  RunnerStatus,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ratifyProjectForPgTest } from '../projects/project-ratification-test-helper';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';

/**
 * H2G — the automatic doors' request identity is ABA-safe, on a real PostgreSQL, through the door.
 *
 * H2F made a legacy run request a COMMAND WITH A RECEIPT and left one half open: where an automatic
 * door's NAME comes from. It came from the current value of the fact the door acted on —
 * `sched:<task>:<run_at>`, `dep:<task>:<edge_revision>` — and those values come back:
 *
 *   * `run_at` 09:00 -> 10:00 -> 09:00. The second 09:00 is a legitimate second appointment that
 *     re-derives the first one's name. Frozen as "rescheduled" it never runs; frozen as a dispatch
 *     it hands back the FIRST run's Session and still never runs.
 *   * A prerequisite going DONE -> reopened -> DONE, or the task itself going DONE -> reopened, is a
 *     legitimate second READY transition under an UNCHANGED edge set — which is precisely what
 *     0132's revision cannot see.
 *
 * So the name carries `task_dispatch_epoch` (0137, advanced in one canonical batch since 0154): a
 * counter that only goes up, advanced once per statement that creates a moment at which an
 * automatic door may legitimately start this task's work. Everything below drives
 * `TasksService.execute` and the sweeps that call it — the same methods the API controller, the
 * runner's `task_start` and the reconcile timer reach — against the real triggers, the real
 * `session_task_execution_claim_idx` and the real receipt.
 *
 * Contract: §7.7 D5-b4, whose (7) names the four ABA shapes this file must cover on a real server.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable servers
 * `scripts/project-pg-matrix.sh` and `scripts/deadlock-barrier.sh` provision.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Services {
  db: PrismaClient;
  tasks: TasksService;
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
  taskId: string;
}

/** A whole service stack over its own pool — nothing about an answer may live in a process. */
function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return { db, tasks: new TasksService(prisma, sessions, publishes) };
}

/** An owner, an online runner, an agent on it, a LEGACY-dispatch Project, and one runnable task. */
async function fixture(
  db: PrismaClient,
  label: string,
  task: { runAt?: Date; autoRunWhenReady?: boolean } = {},
): Promise<Fixture> {
  const ids = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    agentId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@h2g.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: ids.agentId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({
    data: {
      id: ids.projectId, ownerId: ids.ownerId, title: label,
      // LEGACY dispatch authority, which is what puts these dispatches through `execute` rather
      // than through the Coordinator — the doors this unit is about.
      coordinatorEnabled: false, automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  await db.task.create({
    data: {
      id: ids.taskId, ownerId: ids.ownerId, projectId: ids.projectId, assigneeId: ids.agentId,
      title: `${label} task`, creatorType: CreatorType.USER, creatorId: ids.ownerId,
      provider: 'claude', runAt: task.runAt ?? null,
      autoRunWhenReady: task.autoRunWhenReady ?? false,
    },
  });
  await ratifyProjectForPgTest(db, ids.ownerId, ids.projectId, `dispatch-epoch-${label}`);
  return ids;
}

/** One more task in the same fixture, so a test can have a prerequisite or a sibling. */
async function extraTask(
  db: PrismaClient,
  ids: Fixture,
  opts: { status?: TaskStatus; autoRunWhenReady?: boolean; parentTaskId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: ids.ownerId, projectId: ids.projectId, assigneeId: ids.agentId,
      title: `extra ${id.slice(0, 8)}`, creatorType: CreatorType.USER, creatorId: ids.ownerId,
      provider: 'claude', status: TaskStatus.OPEN,
      autoRunWhenReady: opts.autoRunWhenReady ?? false,
      parentTaskId: opts.parentTaskId ?? null,
    },
  });
  if (opts.status === TaskStatus.DONE) {
    await completeHumanTaskForPgTest(
      db, ids.ownerId, id, `dispatch-epoch-extra-${id}`,
    );
  }
  return id;
}

/** WHICH MOMENT a task is at, straight off the row the trigger writes. */
async function epochOf(db: PrismaClient, taskId: string): Promise<bigint> {
  const [row] = await db.$queryRaw<Array<{ epoch: bigint }>>`
    SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id" = ${taskId}::uuid`;
  assert.ok(row, `task ${taskId} has no dispatch epoch row`);
  return row.epoch;
}

/** 0132's prerequisite revision, read so a test can prove what it CANNOT see. */
async function revisionOf(db: PrismaClient, taskId: string): Promise<bigint> {
  const [row] = await db.$queryRaw<Array<{ revision: bigint }>>`
    SELECT "revision" FROM "task_dependency_revision" WHERE "task_id" = ${taskId}::uuid`;
  assert.ok(row, `task ${taskId} has no dependency revision row`);
  return row.revision;
}

interface ReceiptRow {
  status: string;
  target: { v?: number; kind?: string; reason?: string } | null;
  result: unknown;
  attempt: number;
  leaseHolder: string | null;
  leaseExpiresAt: Date | null;
}

async function receiptRow(
  db: PrismaClient, ownerId: string, token: string,
): Promise<ReceiptRow | undefined> {
  const [row] = await db.$queryRaw<Array<ReceiptRow>>`
    SELECT "status", "target", "result", "attempt",
           "lease_holder" AS "leaseHolder", "lease_expires_at" AS "leaseExpiresAt"
      FROM "task_run_request"
     WHERE "owner_id" = ${ownerId}::uuid
       AND "action_kind" = ${TASK_RUN_ACTION.execute}
       AND "request_token" = ${token}`;
  return row;
}

const sessionCount = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId, startsTaskWork: true } });

/** Move a task through the production completion door; reopening remains an ordinary status edit. */
async function setStatus(db: PrismaClient, taskId: string, status: TaskStatus): Promise<void> {
  if (status === TaskStatus.DONE) {
    const task = await db.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { ownerId: true },
    });
    await completeHumanTaskForPgTest(
      db, task.ownerId, taskId, `dispatch-epoch-status-${randomUUID()}`,
    );
    return;
  }
  await db.task.update({ where: { id: taskId }, data: { status } });
}

// ---------------------------------------------------------------------------------------------
// D5-b4(7) ABA #1 — `run_at` 09:00 -> 10:00 -> 09:00.
// ---------------------------------------------------------------------------------------------

test('a rescheduled-and-restored appointment is two moments, and only the current one runs',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const nine = new Date(Date.now() - 60 * 60_000);
    const ten = new Date(Date.now() - 30 * 60_000);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'aba-schedule', { runAt: nine });
      // The first 09:00 appointment, as a sweep pass reading a committed row would see it.
      const first = await epochOf(s.db, ids.taskId);

      await s.db.task.update({ where: { id: ids.taskId }, data: { runAt: ten } });
      const moved = await epochOf(s.db, ids.taskId);
      await s.db.task.update({ where: { id: ids.taskId }, data: { runAt: nine } });
      const second = await epochOf(s.db, ids.taskId);

      // MONOTONE and DISTINCT — while `run_at` itself is back where it started. This is the ABA
      // stated as data: the value a token used to be derived from is identical, and the moment it
      // is derived from now is not.
      assert.ok(first < moved && moved < second, `${first} < ${moved} < ${second}`);
      assert.deepEqual(
        (await s.db.task.findUniqueOrThrow({ where: { id: ids.taskId }, select: { runAt: true } })).runAt,
        nine,
        'the appointment really is the same instant again — otherwise this proves nothing',
      );
      assert.notEqual(
        TASK_RUN_TRIGGER.scheduled(ids.taskId, first),
        TASK_RUN_TRIGGER.scheduled(ids.taskId, second),
        'two appointments, two names — the value-derived token gave one',
      );

      // A pass that scanned before the reschedule, delivered late. It must not start work: the
      // moment it is answering has passed, and the pass that read the current moment is the one
      // that gets to decide.
      const stale = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: first },
        TASK_RUN_TRIGGER.scheduled(ids.taskId, first),
      );
      assert.deepEqual(stale, { ok: false, skipped: 'stale-epoch' });
      assert.equal(await sessionCount(s.db, ids.taskId), 0, 'an old event starts nothing');

      // ...and it did not consume the appointment on its way out, which is the damaging half.
      assert.deepEqual(
        (await s.db.task.findUniqueOrThrow({ where: { id: ids.taskId }, select: { runAt: true } })).runAt,
        nine,
      );

      // The current appointment runs, exactly once.
      const kept = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: second },
        TASK_RUN_TRIGGER.scheduled(ids.taskId, second),
      );
      assert.equal(kept.ok, true);
      assert.equal(await sessionCount(s.db, ids.taskId), 1);
      assert.equal(
        (await s.db.task.findUniqueOrThrow({ where: { id: ids.taskId }, select: { runAt: true } })).runAt,
        null,
        'and the appointment it kept is consumed',
      );
    } finally {
      await s.db.$disconnect();
    }
  });

test('a redelivered pass reuses its receipt, and the old event never blocks the new one',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const due = new Date(Date.now() - 60 * 60_000);
    const first = connect();
    let ids: Fixture;
    let staleToken: string;
    let currentToken: string;
    let started: string | undefined;
    try {
      ids = await fixture(first.db, 'aba-redeliver', { runAt: due });
      const before = await epochOf(first.db, ids.taskId);
      await first.db.task.update({ where: { id: ids.taskId }, data: { runAt: new Date(Date.now() - 30 * 60_000) } });
      await first.db.task.update({ where: { id: ids.taskId }, data: { runAt: due } });
      const now = await epochOf(first.db, ids.taskId);
      staleToken = TASK_RUN_TRIGGER.scheduled(ids.taskId, before);
      currentToken = TASK_RUN_TRIGGER.scheduled(ids.taskId, now);

      // OUT OF ORDER, deliberately: the old event is delivered FIRST and twice, then the current
      // one. Neither ordering nor repetition may change what either answers.
      const staleA = await first.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: before }, staleToken,
      );
      const staleB = await first.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: before }, staleToken,
      );
      assert.deepEqual(staleA, { ok: false, skipped: 'stale-epoch' });
      assert.deepEqual(staleB, staleA, 'a redelivered moment is answered from its receipt');

      const current = await first.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: now }, currentToken,
      );
      assert.equal(current.ok, true);
      started = current.sessionId;
      assert.equal(await sessionCount(first.db, ids.taskId), 1);

      // The stale receipt is FROZEN — the moment it names cannot come back — and the current one is
      // frozen with the run it started. Neither holds a lease.
      const stale = await receiptRow(first.db, ids.ownerId, staleToken);
      assert.equal(stale?.status, 'COMPLETED');
      assert.equal(stale?.leaseHolder, null);
      assert.deepEqual(stale?.result, { ok: false, skipped: 'stale-epoch' });
      // TWO deliveries of the stale token, ONE attempt each — the second read the answer rather
      // than evaluating a second time.
      assert.equal(stale?.attempt, 1);
    } finally {
      await first.db.$disconnect();
    }

    // A SECOND service over a fresh pool: nothing about an answer may live in a process.
    const second = connect();
    try {
      assert.deepEqual(
        await second.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: 0n }, staleToken),
        { ok: false, skipped: 'stale-epoch' },
      );
      const again = await second.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: 0n }, currentToken,
      );
      assert.equal(again.ok, true);
      assert.equal(again.sessionId, started, 'the same moment, the same run');
      assert.equal(await sessionCount(second.db, ids.taskId), 1,
        'neither delivery opened a second run');
    } finally {
      await second.db.$disconnect();
    }
  });

test('the scheduled sweep itself keeps the current appointment exactly once',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'aba-sweep', { runAt: new Date(Date.now() - 60 * 60_000) });
      // The sweep is the caller under test here, not `execute`: it is the code that decides which
      // epoch a scheduled dispatch is named after, and a sweep that read the epoch in a second
      // statement would be naming a different snapshot from the one its predicate ran against.
      await (s.tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> })
        .dispatchDueScheduledTasks();
      assert.equal(await sessionCount(s.db, ids.taskId), 1);

      // The run consumed `run_at`, which advanced the epoch again — so a second pass finds no
      // candidate at all, and the run that happened stays named after the appointment it kept.
      await (s.tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> })
        .dispatchDueScheduledTasks();
      assert.equal(await sessionCount(s.db, ids.taskId), 1);
    } finally {
      await s.db.$disconnect();
    }
  });

// ---------------------------------------------------------------------------------------------
// D5-b4(7) ABA #2 and #3 — a prerequisite DONE -> reopen -> DONE, and the task itself DONE -> reopen.
// ---------------------------------------------------------------------------------------------

test('a prerequisite DONE -> reopen -> DONE is two READY moments under one unchanged edge set',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'aba-dependency', { autoRunWhenReady: true });
      const prerequisite = await extraTask(s.db, ids);
      await s.db.taskDependency.create({
        data: { taskId: ids.taskId, dependsOnTaskId: prerequisite },
      });
      const edgeRevision = await revisionOf(s.db, ids.taskId);

      await setStatus(s.db, prerequisite, TaskStatus.DONE);
      const firstReady = await epochOf(s.db, ids.taskId);
      const firstRun = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: firstReady },
        TASK_RUN_TRIGGER.dependency(ids.taskId, firstReady),
      );
      assert.equal(firstRun.ok, true);

      // The run ends, the task is put back, and the prerequisite is reopened and finished again.
      // Every one of those is a `task` status write, so every one of them is a moment.
      await s.db.session.update({
        where: { id: firstRun.sessionId! }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      await setStatus(s.db, ids.taskId, TaskStatus.OPEN);
      await setStatus(s.db, prerequisite, TaskStatus.OPEN);
      await setStatus(s.db, prerequisite, TaskStatus.DONE);
      const secondReady = await epochOf(s.db, ids.taskId);

      // WHAT 0132 CANNOT SEE, stated as the assertion the whole re-keying rests on: not one edge
      // was added, moved or removed, so the revision is exactly where it was — and the second READY
      // transition is every bit as legitimate as the first.
      assert.equal(await revisionOf(s.db, ids.taskId), edgeRevision,
        'the edge set is unchanged, which is why the revision could not name this moment');
      assert.ok(secondReady > firstReady, `${secondReady} > ${firstReady}`);
      assert.notEqual(
        TASK_RUN_TRIGGER.dependency(ids.taskId, edgeRevision),
        TASK_RUN_TRIGGER.dependency(ids.taskId, secondReady),
      );

      const secondRun = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: secondReady },
        TASK_RUN_TRIGGER.dependency(ids.taskId, secondReady),
      );
      assert.equal(secondRun.ok, true);
      assert.notEqual(secondRun.sessionId, firstRun.sessionId,
        'the second READY must get its own run, not the first one back');
      assert.equal(await sessionCount(s.db, ids.taskId), 2);

      // ...and the first moment's receipt still answers with the first moment's run, unchanged.
      const replay = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: firstReady },
        TASK_RUN_TRIGGER.dependency(ids.taskId, firstReady),
      );
      assert.deepEqual(replay, { ok: true, sessionId: firstRun.sessionId });
      assert.equal(await sessionCount(s.db, ids.taskId), 2, 'and it started nothing new');
    } finally {
      await s.db.$disconnect();
    }
  });

test('the task itself DONE -> reopen is a new moment, under the same unchanged edge set',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'aba-reopen', { autoRunWhenReady: true });
      const prerequisite = await extraTask(s.db, ids, { status: TaskStatus.DONE });
      await s.db.taskDependency.create({
        data: { taskId: ids.taskId, dependsOnTaskId: prerequisite },
      });
      const edgeRevision = await revisionOf(s.db, ids.taskId);
      const ready = await epochOf(s.db, ids.taskId);

      const first = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: ready },
        TASK_RUN_TRIGGER.dependency(ids.taskId, ready),
      );
      assert.equal(first.ok, true);
      await s.db.session.update({
        where: { id: first.sessionId! }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });

      await setStatus(s.db, ids.taskId, TaskStatus.DONE);
      await setStatus(s.db, ids.taskId, TaskStatus.OPEN);
      const reopened = await epochOf(s.db, ids.taskId);

      assert.equal(await revisionOf(s.db, ids.taskId), edgeRevision);
      assert.ok(reopened > ready, `${reopened} > ${ready}`);

      const second = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: reopened },
        TASK_RUN_TRIGGER.dependency(ids.taskId, reopened),
      );
      assert.equal(second.ok, true);
      assert.notEqual(second.sessionId, first.sessionId);
      assert.equal(await sessionCount(s.db, ids.taskId), 2);
    } finally {
      await s.db.$disconnect();
    }
  });

// ---------------------------------------------------------------------------------------------
// D5-b4(1) — every automatic token is TASK-scoped, and a new moment is a new command.
// ---------------------------------------------------------------------------------------------

test('two of one owner\'s tasks at the same epoch are two requests, not one',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'aba-scoped');
      const sibling = await extraTask(s.db, ids);
      // Same owner, same door, same epoch. Without the task in the token the receipt's key
      // `(owner, action, token)` would be identical and the second task would be answered with the
      // first task's Session.
      const mine = await epochOf(s.db, ids.taskId);
      const theirs = await epochOf(s.db, sibling);
      assert.equal(mine, theirs, 'both are at the epoch their seed trigger gave them');

      const a = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: mine },
        TASK_RUN_TRIGGER.dependency(ids.taskId, mine),
      );
      const b = await s.tasks.execute(
        ids.ownerId, sibling, { observedEpoch: theirs },
        TASK_RUN_TRIGGER.dependency(sibling, theirs),
      );

      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.notEqual(a.sessionId, b.sessionId);
      assert.equal(await sessionCount(s.db, ids.taskId), 1);
      assert.equal(await sessionCount(s.db, sibling), 1);
    } finally {
      await s.db.$disconnect();
    }
  });

test('a new moment opens its own receipt rather than continuing the previous one\'s attempts',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'aba-attempts', { runAt: new Date(Date.now() - 60 * 60_000) });
      const first = await epochOf(s.db, ids.taskId);
      const firstToken = TASK_RUN_TRIGGER.scheduled(ids.taskId, first);

      // Three deliveries of ONE moment: one evaluation, then two reads of the answer.
      const answers = [
        await s.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: first }, firstToken),
        await s.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: first }, firstToken),
        await s.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: first }, firstToken),
      ];
      assert.deepEqual(answers[1], answers[0], 'deep-equal, not merely both successful');
      assert.deepEqual(answers[2], answers[0]);
      assert.equal(await sessionCount(s.db, ids.taskId), 1);
      assert.equal((await receiptRow(s.db, ids.ownerId, firstToken))?.attempt, 1);

      // A NEW moment on the same task: its own row, its own first attempt, its own answer.
      await s.db.session.update({
        where: { id: answers[0].sessionId! },
        data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      await s.db.task.update({
        where: { id: ids.taskId }, data: { runAt: new Date(Date.now() - 30 * 60_000) },
      });
      const second = await epochOf(s.db, ids.taskId);
      const secondToken = TASK_RUN_TRIGGER.scheduled(ids.taskId, second);
      assert.notEqual(secondToken, firstToken);

      const next = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: second }, secondToken,
      );
      assert.equal(next.ok, true);
      assert.notEqual(next.sessionId, answers[0].sessionId);
      assert.equal((await receiptRow(s.db, ids.ownerId, secondToken))?.attempt, 1,
        'a new moment starts at attempt 1 rather than inheriting the previous receipt\'s count');
    } finally {
      await s.db.$disconnect();
    }
  });

// ---------------------------------------------------------------------------------------------
// D5-b4(6) — every automatic stand-down ends its hold, and each takes the ending it has earned.
// ---------------------------------------------------------------------------------------------

test('every automatic stand-down leaves no holder, and only the stale one freezes',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      // 1. stale-epoch — the moment has passed. FROZEN: it can never come back.
      const stale = await fixture(s.db, 'stand-stale', { runAt: new Date(Date.now() - 60 * 60_000) });
      const before = await epochOf(s.db, stale.taskId);
      await s.db.task.update({ where: { id: stale.taskId }, data: { runAt: new Date(Date.now() - 30 * 60_000) } });

      // 2. superseded (§13.6 SU6) — RELEASED: a supersession link can be removed.
      const retired = await fixture(s.db, 'stand-superseded');
      const successor = await extraTask(s.db, retired);
      // `task_superseded_link_check` (0128): a link is only half a supersession — the terminal
      // reason and the instant are the other half, and the row may not carry one without the others.
      await s.db.task.update({
        where: { id: retired.taskId },
        data: {
          status: TaskStatus.CANCELLED, supersededByTaskId: successor,
          terminalReason: 'SUPERSEDED', supersededAt: new Date(),
        },
      });

      // 3. aggregate-parent (§13.1 AG6) — RELEASED: a policy can go back to MANUAL.
      const parent = await fixture(s.db, 'stand-aggregate');
      await extraTask(s.db, parent, { parentTaskId: parent.taskId });
      await s.db.task.update({
        where: { id: parent.taskId }, data: { completionPolicy: 'ALL_CHILDREN_DONE' },
      });

      const cases: Array<[string, Fixture, string, boolean]> = [
        ['stale-epoch', stale, 'COMPLETED', true],
        ['superseded', retired, 'OPEN', false],
        ['aggregate-parent', parent, 'OPEN', false],
      ];
      for (const [reason, ids, receiptStatus, frozen] of cases) {
        const epoch = reason === 'stale-epoch' ? before : await epochOf(s.db, ids.taskId);
        const token = TASK_RUN_TRIGGER.dependency(ids.taskId, epoch);
        const answer = await s.tasks.execute(
          ids.ownerId, ids.taskId, { observedEpoch: epoch }, token,
        );
        assert.deepEqual(answer, { ok: false, skipped: reason }, `${reason} answered wrongly`);
        assert.equal(await sessionCount(s.db, ids.taskId), 0, `${reason} started something`);

        const row = await receiptRow(s.db, ids.ownerId, token);
        // THE INVARIANT BOTH ENDINGS SHARE, and the one a bare `return` breaks: no delivery may
        // leave the receipt held. A held OPEN row tells the next delivery of the same durable token
        // that the request is in progress — by a process that has already answered it.
        assert.equal(row?.leaseHolder, null, `${reason} left a holder on the receipt`);
        assert.equal(row?.leaseExpiresAt, null, `${reason} left a live lease`);
        assert.equal(row?.status, receiptStatus, `${reason} took the wrong ending`);
        assert.deepEqual(row?.result, frozen ? { ok: false, skipped: reason } : null);
        // 0137's `task_run_request_target_check`, which is what makes a frozen stand-down
        // recoverable rather than merely recorded: a receipt that is not OPEN carries the PLAN it
        // is carrying out, discriminated, so a delivery that dies between deciding and freezing
        // leaves a row the next one can finish.
        assert.deepEqual(
          row?.target,
          frozen
            ? { v: 1, kind: 'STAND_DOWN', taskId: ids.taskId, reason,
                observedEpoch: String(epoch), currentEpoch: String(await epochOf(s.db, ids.taskId)) }
            : null,
        );

        // The half each ending owes. A RELEASED request can be asked again — the cause can be
        // lifted, so a later delivery of the same token must evaluate rather than replay. A FROZEN
        // one answers from the row without evaluating anything.
        const again = await s.tasks.execute(
          ids.ownerId, ids.taskId, { observedEpoch: epoch }, token,
        );
        assert.deepEqual(again, answer, `${reason} did not answer a repeat the same way`);
        assert.equal((await receiptRow(s.db, ids.ownerId, token))?.attempt, frozen ? 1 : 2,
          `${reason}: a released request re-evaluates, a frozen one does not`);
      }
    } finally {
      await s.db.$disconnect();
    }
  });

test('a released stand-down evaluates again once the fact that refused it is lifted',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      // The reason the released ones release rather than freeze, proven rather than argued: the
      // completion policy goes back to MANUAL, the token is unchanged because nothing in the
      // epoch's transition table moved, and the same request now legitimately starts work.
      const ids = await fixture(s.db, 'stand-lift');
      await extraTask(s.db, ids, { parentTaskId: ids.taskId });
      await s.db.task.update({
        where: { id: ids.taskId }, data: { completionPolicy: 'ALL_CHILDREN_DONE' },
      });
      const epoch = await epochOf(s.db, ids.taskId);
      const token = TASK_RUN_TRIGGER.dependency(ids.taskId, epoch);

      assert.deepEqual(
        await s.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: epoch }, token),
        { ok: false, skipped: 'aggregate-parent' },
      );

      await s.db.task.update({
        where: { id: ids.taskId }, data: { completionPolicy: 'MANUAL' },
      });
      assert.equal(await epochOf(s.db, ids.taskId), epoch,
        'changing a completion policy is not a dispatch moment, so the token is the same one');

      const run = await s.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: epoch }, token);
      assert.equal(run.ok, true, 'a frozen refusal here would have wedged this task for ever');
      assert.equal(await sessionCount(s.db, ids.taskId), 1);
    } finally {
      await s.db.$disconnect();
    }
  });

test('a stand-down that was decided but not frozen is finished, not re-decided',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      // The window `task_run_request_target_check` exists for: a holder that decided "this moment
      // has passed", bound that plan, and died before recording the answer. The world has since
      // moved on — this task is now perfectly runnable at the epoch the delivery carries — and the
      // takeover must still carry out the PLAN rather than re-read the world and start work.
      const ids = await fixture(s.db, 'stand-takeover');
      const epoch = await epochOf(s.db, ids.taskId);
      const token = TASK_RUN_TRIGGER.dependency(ids.taskId, epoch);
      await s.db.$executeRaw`
        INSERT INTO "task_run_request"
          ("owner_id", "action_kind", "request_token", "fingerprint", "status", "target", "bound_at")
        VALUES (${ids.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${token},
                ${`task:${ids.taskId}`}, 'BOUND',
                ${JSON.stringify({
                  v: 1, kind: 'STAND_DOWN', taskId: ids.taskId, reason: 'stale-epoch',
                  observedEpoch: String(epoch), currentEpoch: String(epoch + 1n),
                })}::jsonb,
                statement_timestamp())`;

      const answer = await s.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: epoch }, token,
      );

      assert.deepEqual(answer, { ok: false, skipped: 'stale-epoch' });
      assert.equal(await sessionCount(s.db, ids.taskId), 0,
        'the takeover carried out the plan, which was to write nothing');
      const row = await receiptRow(s.db, ids.ownerId, token);
      assert.equal(row?.status, 'COMPLETED');
      assert.equal(row?.leaseHolder, null);
    } finally {
      await s.db.$disconnect();
    }
  });

test('a BOUND plan this binary cannot read is refused rather than guessed at',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const ids = await fixture(s.db, 'stand-unreadable');
      const epoch = await epochOf(s.db, ids.taskId);
      const token = TASK_RUN_TRIGGER.dependency(ids.taskId, epoch);
      // A receipt left BOUND by something else — a newer replica mid-deploy — carrying a plan whose
      // discriminator this code has never heard of. A takeover that guessed would apply the wrong
      // effect; the honest answer is that it cannot finish somebody else's command.
      await s.db.$executeRaw`
        INSERT INTO "task_run_request"
          ("owner_id", "action_kind", "request_token", "fingerprint", "status", "target", "bound_at")
        VALUES (${ids.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${token},
                ${`task:${ids.taskId}`}, 'BOUND',
                ${JSON.stringify({ v: 2, kind: 'SOMETHING_ELSE', taskId: ids.taskId })}::jsonb,
                statement_timestamp())`;

      await assert.rejects(
        () => s.tasks.execute(ids.ownerId, ids.taskId, { observedEpoch: epoch }, token),
        (e: Error & { status?: number; response?: { code?: string } }) => {
          assert.equal(e.status, 409);
          assert.equal(e.response?.code, 'TASK_RUN_REQUEST_UNREADABLE');
          return true;
        },
      );
      assert.equal(await sessionCount(s.db, ids.taskId), 0, 'fail-closed means nothing happened');
      // ...and the refusal left the request askable by the replica that DOES understand it.
      const row = await receiptRow(s.db, ids.ownerId, token);
      assert.equal(row?.status, 'BOUND');
      assert.equal(row?.leaseHolder, null);
    } finally {
      await s.db.$disconnect();
    }
  });

// ---------------------------------------------------------------------------------------------
// D5-b4(2) — the counter is a fact about committed rows, not about a process.
// ---------------------------------------------------------------------------------------------

test('an aborted transaction advances no moment, and an unrelated Task write advances none either',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    const raw = new Client({ connectionString: URL! });
    try {
      const ids = await fixture(s.db, 'aba-durable', { runAt: new Date(Date.now() - 60 * 60_000) });
      const start = await epochOf(s.db, ids.taskId);

      // ROLLED BACK. A moment is created by a COMMITTED write and by nothing else — otherwise a
      // retried transaction would burn epochs and two passes over one moment would disagree.
      await raw.connect();
      await raw.query('BEGIN');
      await raw.query(
        `UPDATE "task" SET "status" = 'IN_PROGRESS'::task_status WHERE "id" = $1::uuid`,
        [ids.taskId],
      );
      await raw.query('ROLLBACK');
      assert.equal(await epochOf(s.db, ids.taskId), start, 'an aborted write is not a moment');

      // A write that changes neither the appointment nor the status is not a moment either — the
      // transition table is a closed list, and a title edit is not on it.
      await s.db.task.update({ where: { id: ids.taskId }, data: { title: 'renamed' } });
      assert.equal(await epochOf(s.db, ids.taskId), start);

      // One STATEMENT, many rows, one advance each: the counter is per Task per statement, which is
      // what lets a bulk write name a moment for every task it touched without counting rows.
      const sibling = await extraTask(s.db, ids);
      await s.db.task.updateMany({
        where: { id: { in: [ids.taskId, sibling] } }, data: { status: TaskStatus.IN_PROGRESS },
      });
      assert.equal(await epochOf(s.db, ids.taskId), start + 1n);
      assert.equal(await epochOf(s.db, sibling), 1n);
    } finally {
      await raw.end().catch(() => undefined);
      await s.db.$disconnect();
    }
  });

test('a real server restart does not change what a moment named or what it answered',
  { skip: skip || !process.env.COORDINATOR_PG_RESTART_COMMAND, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const before = connect();
    let ids: Fixture;
    let epoch: bigint;
    let token: string;
    let started: string | undefined;
    try {
      ids = await fixture(before.db, 'aba-restart', { runAt: new Date(Date.now() - 60 * 60_000) });
      epoch = await epochOf(before.db, ids.taskId);
      token = TASK_RUN_TRIGGER.scheduled(ids.taskId, epoch);
      const run = await before.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: epoch }, token,
      );
      assert.equal(run.ok, true);
      started = run.sessionId;
    } finally {
      await before.db.$disconnect();
    }

    const [command, ...args] = process.env.COORDINATOR_PG_RESTART_COMMAND!.split(' ');
    await promisify(execFile)(command, args);
    // A fresh Client per attempt: `pg` refuses to reconnect one that has already tried.
    for (let attempt = 0; ; attempt += 1) {
      const admin = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
      try {
        await admin.connect();
        await verifyCoordinatorPgIdentity(admin);
        await admin.end();
        break;
      } catch (e) {
        await admin.end().catch(() => undefined);
        if (attempt >= 60) throw e;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    const after = connect();
    try {
      // The moment survived as a number on a row, and the answer survived as bytes on a receipt.
      // The dispatch consumed `run_at`, so the epoch has moved on — and the redelivery is answered
      // from the receipt BEFORE any of that is looked at, which is why it still returns the run.
      assert.ok(await epochOf(after.db, ids.taskId) > epoch);
      const again = await after.tasks.execute(
        ids.ownerId, ids.taskId, { observedEpoch: epoch }, token,
      );
      assert.deepEqual(again, { ok: true, sessionId: started });
      assert.equal(await sessionCount(after.db, ids.taskId), 1);
    } finally {
      await after.db.$disconnect();
    }
  });
