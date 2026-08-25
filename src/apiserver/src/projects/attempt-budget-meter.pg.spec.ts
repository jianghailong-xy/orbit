import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, PrismaClient, RunStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ATTEMPT_BUDGET_DIMENSIONS,
  ATTEMPT_BUDGET_LIMIT,
  AttemptBudgetDimension,
} from './attempt-budget';
import { COORDINATOR_DISABLED } from './attempt-budget-meter';
import { AttemptBudgetMeterService } from './attempt-budget-meter.service';
import { DEFAULT_ATTEMPT_BUDGET } from './convergence-contract';
import { EMPTY_PROGRESS_VECTOR, scopeHash } from './convergence-progress';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { SessionAttemptService } from './session-attempt.service';

/**
 * Unit T5 against a real PostgreSQL, because the claims it makes are the DATABASE's.
 *
 * "The six dimensions are charged against a real session" is only true if the numbers come off the
 * session's own columns and its tool-call rows. "The spend is not in memory" is only true if a
 * SECOND service instance over a SECOND client reads back what the first one wrote. "One exhausted
 * attempt wakes the coordinator once" is a partial unique index. None of the three has a
 * fake-client version that would mean anything.
 *
 *   docker run -d --name pcct5-pg --tmpfs /var/lib/postgresql/data \
 *     -e POSTGRES_PASSWORD=pcct5 -e POSTGRES_USER=pcct5_admin -e POSTGRES_DB=pcct5_tpl \
 *     -p 127.0.0.1:55681:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcct5_admin:pcct5@127.0.0.1:55681/pcct5_tpl npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcct5_admin:pcct5@127.0.0.1:55681/pcct5_tpl \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcct5_tpl COORDINATOR_PG_EXPECTED_USER=pcct5_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(docker exec pcct5-pg psql -U pcct5_admin \
 *     -d pcct5_tpl -tAc 'SELECT system_identifier FROM pg_control_system()') \
 *   node --test build/projects/attempt-budget-meter.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

const BUDGET = DEFAULT_ATTEMPT_BUDGET;
const WINDOW = 200_000;

interface Fixture {
  db: PrismaClient;
  meter: AttemptBudgetMeterService;
  attempts: SessionAttemptService;
  ownerId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
}

/**
 * A project, a task and a session that is genuinely ONE attempt under one scope revision.
 *
 * `attemptBudget` is left NULL, which is the state every project in production is in — so the six
 * limits this spec measures against have to arrive through `resolveAttemptBudget` from
 * `DEFAULT_ATTEMPT_BUDGET`, and a change to those defaults moves this spec with it rather than
 * leaving it asserting numbers nobody uses.
 */
async function fixture(options: { coordinatorEnabled?: boolean } = {}): Promise<Fixture> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);
  await identity.end();

  const db = prismaClientFor(URL);
  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `t5-${ownerId}@budget.invalid`, name: 't5', passwordHash: 'x' },
  });
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: 'a project whose attempts are bounded',
      goal: 'spend six dimensions',
      acceptanceCriteria: 'the budget is charged\nthe fact is produced',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      // Deliberately absent: production has never written this column.
      attemptBudget: undefined,
    },
  });
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'a task with one attempt on it',
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      status: TaskStatus.IN_PROGRESS,
    },
  });
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      title: 'the attempt',
      prompt: 'do the task',
      status: RunStatus.RUNNING,
      startedAt: new Date(),
    },
  });
  return { db, ...services(db), ownerId, projectId, taskId, sessionId };
}

/**
 * The services, built over one client.
 *
 * A helper rather than four `new`s inline because the persistence test needs a SECOND set over a
 * second client — "the counters are not in memory" is a statement about what a fresh object reads,
 * and the only honest way to make it is to build a fresh object.
 */
function services(db: PrismaClient): {
  meter: AttemptBudgetMeterService;
  attempts: SessionAttemptService;
} {
  const prisma = db as unknown as PrismaService;
  const attempts = new SessionAttemptService(prisma, new ConvergenceLedgerService(prisma));
  return {
    attempts,
    meter: new AttemptBudgetMeterService(
      prisma,
      attempts,
      new CoordinatorWakeService(prisma),
      new CoordinatorConvergenceService(prisma),
    ),
  };
}

/**
 * Open the one attempt this session is, through the ledger, exactly as `[K3]` §4 requires.
 *
 * The progress vector names the task's own scope hash because migration 0138 checks that it does —
 * a measurement of one target filed against another is not comparable to anything.
 */
async function openAttempt(f: Fixture, hypothesis = 'try the obvious thing'): Promise<void> {
  const task = await f.db.task.findUniqueOrThrow({
    where: { id: f.taskId },
    select: { title: true, description: true, acceptanceCriteria: true },
  });
  await f.attempts.open(f.ownerId, f.taskId, {
    attemptKey: `dispatch:${f.sessionId}`,
    sessionId: f.sessionId,
    hypothesis,
    progressVector: { ...EMPTY_PROGRESS_VECTOR, scopeHash: scopeHash(task) },
    observedAt: new Date(),
  });
}

/**
 * Push the session (or the attempt) over exactly ONE line, using the session's own columns.
 *
 * Nothing here writes `task_attempt.spend`: the point of the unit is that the spend is READ from
 * columns other code wrote. `WALL_CLOCK` moves `started_at` backwards rather than moving a clock
 * forwards, because `now` is an argument to the meter and the session is what holds the start.
 */
async function spend(f: Fixture, dimension: AttemptBudgetDimension, now: Date): Promise<void> {
  switch (dimension) {
    case 'CONTEXT':
      await f.db.session.update({
        where: { id: f.sessionId },
        data: {
          contextTokens: Math.ceil((BUDGET.maxContextPercent as number) / 100 * WINDOW),
          contextWindow: WINDOW,
        },
      });
      return;
    case 'WALL_CLOCK':
      await f.db.session.update({
        where: { id: f.sessionId },
        data: { startedAt: new Date(now.getTime() - (BUDGET.maxWallClockMs as number)) },
      });
      return;
    case 'TURNS':
      await f.db.session.update({
        where: { id: f.sessionId },
        data: { numTurns: BUDGET.maxTurns as number },
      });
      return;
    case 'TOOL_CALLS':
      await f.db.toolCall.createMany({
        data: Array.from({ length: BUDGET.maxToolCalls as number }, () => ({
          id: randomUUID(),
          sessionId: f.sessionId,
          name: 'Bash',
        })),
      });
      return;
    case 'COST':
      await f.db.session.update({
        where: { id: f.sessionId },
        data: { costUsd: (BUDGET.maxCostMicros as number) / 1_000_000 },
      });
      return;
    case 'COORDINATOR_STEERS':
      // Through the API an agent actually knocks on, not by writing the column: the steer counter
      // is the one dimension the control plane itself increments, and `chargeSteer` is where.
      for (let i = 0; i < (BUDGET.maxCoordinatorSteers as number); i += 1) {
        await f.attempts.chargeSteer(f.ownerId, f.sessionId, {
          kind: 'AGENT_SESSION',
          sessionId: randomUUID(),
        });
      }
      return;
  }
}

/** AC1: six dimensions, six assertions, each one a session that crossed only that line. */
for (const dimension of ATTEMPT_BUDGET_DIMENSIONS) {
  test(`a real session that spends ${dimension} produces ATTEMPT_BUDGET_SPENT`, { skip: skip() }, async () => {
    const f = await fixture();
    try {
      await openAttempt(f);
      const now = new Date();
      // Nothing is owed before the line is crossed — so what the assertion below sees is the
      // CROSSING and not a fact this fixture produces on any input at all.
      assert.equal((await f.meter.meter(f.sessionId, now))?.fact, false);

      await spend(f, dimension, now);
      const metered = await f.meter.meter(f.sessionId, now);

      assert.ok(metered, 'a bound session is metered');
      assert.equal(metered.report.exhausted, dimension);
      assert.equal(metered.fact, true);
      assert.equal(metered.wake?.outcome, 'WOKEN');

      const [wake] = await f.db.$queryRawUnsafe<Array<{
        event: string;
        subjectId: string;
        subjectVersion: string;
        detail: { dimension?: string };
      }>>(
        `SELECT "event", "subject_id" AS "subjectId", "subject_version" AS "subjectVersion",
                "detail" FROM "project_coordinator_wake" WHERE "project_id" = $1::uuid`,
        f.projectId,
      );
      assert.equal(wake.event, 'ATTEMPT_BUDGET_SPENT');
      // AT1, in the row: the fact is about the TASK, versioned by the SESSION that was the attempt.
      assert.equal(wake.subjectId, f.taskId);
      assert.equal(wake.subjectVersion, f.sessionId);
      assert.equal(wake.detail.dimension, dimension);
    } finally {
      await f.db.$disconnect();
    }
  });
}

/**
 * AC2 over the real thing: `CONTEXT` and `TURNS` both spent, and the report names `CONTEXT`,
 * because that is what `ATTEMPT_BUDGET_DIMENSIONS` says comes first — its exhaustion is the one
 * that destroys the ability to write a credible checkpoint, so it is the one worth reporting.
 */
test('two dimensions spent at once report the earlier one', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    await openAttempt(f);
    const now = new Date();
    await spend(f, 'TURNS', now);
    await spend(f, 'CONTEXT', now);

    const metered = await f.meter.meter(f.sessionId, now);
    assert.equal(metered?.report.exhausted, 'CONTEXT');
    assert.equal(
      ATTEMPT_BUDGET_DIMENSIONS.indexOf('CONTEXT') < ATTEMPT_BUDGET_DIMENSIONS.indexOf('TURNS'),
      true,
    );
    // Both really were over the line — otherwise this asserts nothing about ORDER.
    const turns = metered.report.readings.find((r) => r.dimension === 'TURNS');
    assert.equal(turns?.state, 'EXHAUSTED');
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * AC3: the spend is in the database.
 *
 * A budget held in a process is not a budget — 「重启把计数清零，于是预算永远用不完」. So this
 * measures through one service, throws that service AND its client away, and reads back through a
 * second pair. What the second one sees is what was on disk.
 */
test('the measured spend survives the service that measured it', { skip: skip() }, async () => {
  const f = await fixture();
  const second = prismaClientFor(URL as string);
  try {
    await openAttempt(f);
    const now = new Date();
    await spend(f, 'TURNS', now);
    await f.meter.meter(f.sessionId, now);
    await f.db.$disconnect();

    const [row] = await second.$queryRawUnsafe<Array<{
      spend: { turns: number } | null;
      status: string;
      exhausted: string | null;
    }>>(
      `SELECT "spend", "status", "exhausted_dimension" AS "exhausted"
         FROM "task_attempt" WHERE "session_id" = $1::uuid`,
      f.sessionId,
    );
    assert.equal(row.spend?.turns, BUDGET.maxTurns);
    assert.equal(row.status, 'WINDING_DOWN');
    assert.equal(row.exhausted, 'TURNS');

    // And a service instance that never saw the first one reads the same numbers rather than zero.
    const rebuilt = services(second);
    const reread = await rebuilt.meter.meter(f.sessionId, now);
    assert.equal(reread?.spend.turns, BUDGET.maxTurns);
    assert.equal(reread.report.exhausted, 'TURNS');
  } finally {
    await second.$disconnect();
    await f.db.$disconnect().catch(() => undefined);
  }
});

/**
 * AC4, the negative one, against a worker that really is winding down.
 *
 * `CONTEXT` runs out first, so the attempt is asked to finish. Then the coordinator's steer
 * allowance runs out on top of it. The worker must be left exactly where it was: still
 * `WINDING_DOWN`, still writing its checkpoint, its session untouched — because the steer budget
 * bounds the COORDINATOR, and a coordinator with nothing left to say is not a reason to cut a
 * worker off mid-sentence.
 */
test('a spent steer allowance does not stop a worker that is finishing', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    await openAttempt(f);
    const now = new Date();
    await spend(f, 'CONTEXT', now);
    const first = await f.meter.meter(f.sessionId, now);
    assert.equal(first?.report.exhausted, 'CONTEXT');
    assert.equal(first.attempt.status, 'WINDING_DOWN');

    // The coordinator now spends its last steers. `chargeSteer` refuses once the attempt is
    // winding down, so the count is put where a coordinator that steered EARLIER would have left it.
    await f.db.$executeRawUnsafe(
      `UPDATE "task_attempt" SET "coordinator_steers" = $1 WHERE "session_id" = $2::uuid`,
      BUDGET.maxCoordinatorSteers as number,
      f.sessionId,
    );

    const after = await f.meter.meter(f.sessionId, now);
    const steers = after?.report.readings.find((r) => r.dimension === 'COORDINATOR_STEERS');
    assert.equal(steers?.state, 'EXHAUSTED');
    // Still winding down, not closed; still no outcome written by anybody but the worker.
    assert.equal(after?.attempt.status, 'WINDING_DOWN');
    assert.equal(after.attempt.outcome, null);
    assert.equal(after.attempt.closedAt, null);
    const session = await f.db.session.findUniqueOrThrow({ where: { id: f.sessionId } });
    assert.equal(session.status, RunStatus.RUNNING);
    assert.equal(session.cancelRequestedAt, null);
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * The steer allowance alone, on a worker nobody has asked to stop: the fact is produced (somebody
 * has to know the coordinator is out of steers) and the attempt is NOT moved to `WINDING_DOWN`.
 */
test('spending only the steer allowance produces the fact without a wind-down', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    await openAttempt(f);
    const now = new Date();
    await spend(f, 'COORDINATOR_STEERS', now);

    const metered = await f.meter.meter(f.sessionId, now);
    assert.equal(metered?.report.exhausted, 'COORDINATOR_STEERS');
    assert.equal(metered.fact, true);
    assert.equal(metered.wake?.outcome, 'WOKEN');
    assert.equal(metered.report.windDownRequired, false);
    assert.equal(metered.attempt.status, 'OPEN');
    assert.equal(metered.attempt.windDownRequestedAt, null);
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * One exhausted attempt is one fact, however many turns it is metered over.
 *
 * The key is (event, TASK, session), so the dimension is not in it — an attempt that goes on to
 * cross a second line re-derives the key it already used. That is what lets the runner's
 * turn-complete call this on every single turn with no state of its own.
 */
test('metering an exhausted attempt again does not wake anybody twice', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    await openAttempt(f);
    const now = new Date();
    await spend(f, 'TURNS', now);
    assert.equal((await f.meter.meter(f.sessionId, now))?.wake?.outcome, 'WOKEN');

    await spend(f, 'CONTEXT', now);
    const again = await f.meter.meter(f.sessionId, now);
    assert.equal(again?.wake?.outcome, 'ALREADY_AWAKE');

    const [{ count }] = await f.db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) FROM "project_coordinator_wake" WHERE "project_id" = $1::uuid`,
      f.projectId,
    );
    assert.equal(Number(count), 1);
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * A project with its coordinator switched off is refused — and the refusal does NOT burn the key.
 *
 * That is migration 0172's partial unique index doing its one job: the same attempt, metered again
 * after somebody switches the coordinator on, still wakes it. `project_action`'s plain unique key
 * is why this has to be asserted rather than assumed.
 */
test('a project with no coordinator refuses the wake without spending the fact', { skip: skip() }, async () => {
  const f = await fixture({ coordinatorEnabled: false });
  try {
    await openAttempt(f);
    const now = new Date();
    await spend(f, 'TURNS', now);

    const refused = await f.meter.meter(f.sessionId, now);
    assert.equal(refused?.wake?.outcome, 'REFUSED');
    assert.equal(
      refused.wake.outcome === 'REFUSED' ? refused.wake.refusalCode : null,
      COORDINATOR_DISABLED,
    );

    await f.db.project.update({
      where: { id: f.projectId },
      data: { coordinatorEnabled: true },
    });
    assert.equal((await f.meter.meter(f.sessionId, now))?.wake?.outcome, 'WOKEN');
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * Where the budget comes from: `project.attempt_budget`, which is NULL on every project that
 * exists — so what an attempt is actually judged by is `DEFAULT_ATTEMPT_BUDGET`, frozen onto the
 * attempt at open.
 */
test('a project with no attempt_budget freezes the documented defaults', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    const project = await f.db.project.findUniqueOrThrow({ where: { id: f.projectId } });
    assert.equal(project.attemptBudget, null, 'the column is untouched, as in production');

    await openAttempt(f);
    const metered = await f.meter.meter(f.sessionId, new Date());
    assert.deepEqual(metered?.attempt.budget, { ...DEFAULT_ATTEMPT_BUDGET });
    for (const reading of metered.report.readings) {
      assert.equal(
        reading.limit,
        DEFAULT_ATTEMPT_BUDGET[ATTEMPT_BUDGET_LIMIT[reading.dimension]],
        `${reading.dimension} is judged by the default`,
      );
    }
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * A project that HAS stated a budget is judged by it — and BD5: once the attempt is open, editing
 * the project cannot end a running attempt, because the budget it is judged by is the one on its
 * own row. A policy edit that could stop a run in flight is a result overwritten by another result.
 */
test('the project budget is read at open and frozen there', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    await f.db.project.update({
      where: { id: f.projectId },
      data: { attemptBudget: { maxTurns: 4 } },
    });
    await openAttempt(f);

    const now = new Date();
    const opened = await f.meter.meter(f.sessionId, now);
    assert.equal(opened?.attempt.budget.maxTurns, 4, 'the project overrode one dimension');
    assert.equal(
      opened.attempt.budget.maxCostMicros,
      DEFAULT_ATTEMPT_BUDGET.maxCostMicros,
      'and the other five still come from the defaults',
    );

    // Now move the policy under the running attempt, both ways round.
    await f.db.session.update({ where: { id: f.sessionId }, data: { numTurns: 4 } });
    await f.db.project.update({
      where: { id: f.projectId },
      data: { attemptBudget: { maxTurns: 5_000 } },
    });
    const after = await f.meter.meter(f.sessionId, now);
    assert.equal(after?.attempt.budget.maxTurns, 4, 'the frozen budget did not move');
    assert.equal(after.report.exhausted, 'TURNS', 'and the raise did not revive the attempt');
  } finally {
    await f.db.$disconnect();
  }
});

/**
 * Every session that exists today. No `task_attempt` row means the run is not under convergence
 * management, so it is not bounded by this unit at all and nothing is written about it.
 */
test('a session that is not an attempt is not metered', { skip: skip() }, async () => {
  const f = await fixture();
  try {
    assert.equal(await f.meter.meter(f.sessionId, new Date()), null);
    const [{ count }] = await f.db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) FROM "project_coordinator_wake" WHERE "project_id" = $1::uuid`,
      f.projectId,
    );
    assert.equal(Number(count), 0);
  } finally {
    await f.db.$disconnect();
  }
});

function skip(): string | false {
  return URL ? false : 'COORDINATOR_PG_URL is not set';
}
