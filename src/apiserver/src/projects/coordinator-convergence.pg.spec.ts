import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CONVERGENCE_THRESHOLDS } from './convergence-contract';
import { ProgressVector } from './convergence-progress';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { PROJECT_NOT_CONVERGING, noProgressDedupeKey } from './coordinator-convergence';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { attemptEndedUnsettledFact } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';

/**
 * Unit T4 against a real PostgreSQL, because every claim it makes is the DATABASE's.
 *
 * "The counters are not in memory" is only true if the numbers a fresh process reads come off disk;
 * "one fact is charged once" is a unique index; "the blocker does not come back" is a statement
 * about what is and is not written on later passes. None of the three has a fake-client version
 * that would mean anything.
 *
 *   docker run -d --name pcct4-pg --tmpfs /var/lib/postgresql/data \
 *     -e POSTGRES_PASSWORD=pcct4 -e POSTGRES_USER=pcct4_admin -e POSTGRES_DB=pcct4_tpl \
 *     -p 127.0.0.1:55673:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcct4_admin:pcct4@127.0.0.1:55673/pcct4_tpl npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcct4_admin:pcct4@127.0.0.1:55673/pcct4_tpl \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcct4_tpl COORDINATOR_PG_EXPECTED_USER=pcct4_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *     'SELECT system_identifier FROM pg_control_system()') \
 *   node --test build/projects/coordinator-convergence.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

/** N: the documented default, read from the frozen table rather than restated as a literal. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

const CRITERIA = ['the ledger is in the database', 'the stop-loss stops', 'the blocker stays closed'];

interface Fixture {
  db: PrismaClient;
  wakes: CoordinatorWakeService;
  convergence: CoordinatorConvergenceService;
  ownerId: string;
  projectId: string;
  taskId: string;
}

async function fixture(): Promise<Fixture> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);
  await identity.end();

  const db = prismaClientFor(URL);
  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `t4-${ownerId}@conv.invalid`, name: 't4', passwordHash: 'x' },
  });
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: 'a project that stops converging',
      goal: 'reach the three criteria',
      acceptanceCriterionDefinitions: {
        create: CRITERIA.map((text, index) => ({
          ordinal: index + 1,
          text,
          verificationMethod: `A person checks that ${text}`,
          // The normalize trigger recomputes it; Prisma needs a value for the required column.
          contentHash: '0'.repeat(64),
        })),
      },
      // Left null on purpose: this is the state every project in production is in, so the N the
      // stop-loss counts to has to come from `DEFAULT_CONVERGENCE_THRESHOLDS`.
      convergenceThresholds: undefined,
    },
  });
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'a task whose attempts keep ending badly',
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      status: TaskStatus.OPEN,
    },
  });
  return {
    db,
    wakes: new CoordinatorWakeService(db as unknown as PrismaService),
    convergence: new CoordinatorConvergenceService(db as unknown as PrismaService),
    ownerId,
    projectId,
    taskId,
  };
}

/**
 * How a consumer of T2's wakes uses this unit, and the only shape it is meant to be used in: claim
 * the committed fact, hand the convergence authorizer along, and open a judgment session ONLY on a
 * `WOKEN` outcome.
 *
 * `opened` is what unit T3 will actually do with the answer. Asserting on it is what makes "第 N+1
 * 次不再开会话" a statement about this code rather than about a number in a test.
 */
async function wake(
  f: Fixture,
  sessionId: string,
): Promise<{ outcome: string; refusalCode: string | null; opened: boolean }> {
  const fact = attemptEndedUnsettledFact({
    projectId: f.projectId,
    taskId: f.taskId,
    taskStatus: 'OPEN',
    sessionId,
  });
  assert.ok(fact);
  const result = await f.wakes.claim(fact, f.convergence.authorizeWake);
  return {
    outcome: result.outcome,
    refusalCode: result.outcome === 'REFUSED' ? result.refusalCode : null,
    opened: result.outcome === 'WOKEN',
  };
}

/** The ledger, oldest first — the audit, read the way a person would. */
async function decisions(f: Fixture) {
  return f.db.projectConvergenceDecision.findMany({
    where: { projectId: f.projectId },
    orderBy: { seq: 'asc' },
  });
}

async function blockers(f: Fixture) {
  return f.db.projectBlocker.findMany({
    where: { projectId: f.projectId },
    orderBy: { lifecycleGeneration: 'asc' },
  });
}

/**
 * Move the progress vector by one dimension that still exists.
 *
 * This used to close an acceptance criterion, which is what `acceptanceClosed` counted. Migration
 * 0229 removed the project acceptance judgment, so nothing can close a criterion any more and that
 * dimension left the vector with it. `openBlockers` is the axis the same scenario moves now: the
 * question this test asks — "what brings a stopped coordinator back is a measured improvement and
 * nothing else" — is about the breaker, not about which axis improved.
 */
async function openWorkBlocker(f: Fixture): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await f.db.projectBlocker.create({
    data: {
      id,
      projectId: f.projectId,
      kind: 'MERGE_CONFLICT',
      subjectType: 'PROJECT',
      subjectId: f.projectId,
      owner: 'USER',
      recovery: 'HUMAN',
      severity: 'CRITICAL',
      requiredAction: 'resolve the conflict',
      nextCheckAt: now,
      dedupeKey: `t4-work:${id}`,
      lifecycleGeneration: 1n,
      conditionVersion: 'f'.repeat(64),
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
  return id;
}

async function makeProgress(f: Fixture, blockerId: string): Promise<void> {
  await f.db.projectBlocker.update({
    where: { id: blockerId },
    // `project_blocker_resolution_chk`: a resolution names who made it, or is not one.
    data: { resolvedAt: new Date(), resolvedBy: 'USER' },
  });
}

async function cleanup(f: Fixture): Promise<void> {
  // Tasks first: `task_project_id_fkey` is RESTRICT, so a project cannot be deleted out from under
  // its own tasks. Everything this unit writes hangs off the project by CASCADE.
  await f.db.task.deleteMany({ where: { ownerId: f.ownerId } });
  await f.db.project.deleteMany({ where: { id: f.projectId } });
  await f.db.user.deleteMany({ where: { id: f.ownerId } });
  await f.db.$disconnect();
}

/**
 * Acceptance criterion 1: the counters are in the database.
 *
 * The restart is modelled the only way it can honestly be modelled in one process — a SECOND Prisma
 * client and a SECOND service instance, sharing nothing but the database. If any part of the count
 * lived in a field, a closure or a module-level map, the fresh instance would read zero, and the
 * budget would be spendable again on every deploy. That is half of the incident this unit exists
 * for: 「重启把计数清零，于是预算永远用不完」.
 */
test('counters survive the process: a fresh service reads the ledger, not zero', {
  skip: !URL,
  timeout: 120_000,
}, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = await wake(f, randomUUID());
      assert.equal(result.opened, true);
    }
    const before = await f.convergence.state(f.projectId);
    assert.equal(before.counters.decisionsWithoutProgress, 3);
    assert.equal(before.decisions, 3);

    // A different client and a different service object: everything a restart would rebuild.
    const restarted = prismaClientFor(URL as string);
    try {
      const fresh = new CoordinatorConvergenceService(restarted as unknown as PrismaService);
      const after = await fresh.state(f.projectId);
      assert.equal(after.counters.decisionsWithoutProgress, 3, 'a restart re-read the counters as zero');
      assert.deepEqual(after.counters, before.counters);
      assert.deepEqual(after.progressVector, before.progressVector);
      assert.equal(after.lastOutcome, 'PROCEED');

      // And the next wake CONTINUES the count rather than starting one.
      const continued = new CoordinatorWakeService(restarted as unknown as PrismaService);
      const fact = attemptEndedUnsettledFact({
        projectId: f.projectId,
        taskId: f.taskId,
        taskStatus: 'OPEN',
        sessionId: randomUUID(),
      });
      assert.ok(fact);
      await continued.claim(fact, fresh.authorizeWake);
      assert.equal((await fresh.state(f.projectId)).counters.decisionsWithoutProgress, 4);
    } finally {
      await restarted.$disconnect();
    }
  } finally {
    await cleanup(f);
  }
});

/**
 * Acceptance criterion 2: the stop-loss stops.
 *
 * N wakes are spent, the N+1th opens nothing, and what a person gets instead is one row addressed
 * to them.
 */
test('after N unimproved wakes the N+1th opens no session and becomes a USER blocker', {
  skip: !URL,
  timeout: 120_000,
}, async () => {
  const f = await fixture();
  try {
    const opened: boolean[] = [];
    for (let i = 0; i < N + 1; i += 1) {
      // A NEW session id every time: each of these is a genuinely different committed fact, so
      // nothing here is being refused for being a duplicate.
      opened.push((await wake(f, randomUUID())).opened);
    }
    assert.deepEqual(
      opened,
      [...Array.from({ length: N }, () => true), false],
      `the first ${N} wakes are the budget and the ${N + 1}th is the one that crosses it`,
    );

    const refused = await wake(f, randomUUID());
    assert.equal(refused.outcome, 'REFUSED');
    assert.equal(refused.refusalCode, PROJECT_NOT_CONVERGING);

    const open = await blockers(f);
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'COORDINATOR_NO_PROGRESS');
    assert.equal(open[0].owner, 'USER');
    assert.equal(open[0].recovery, 'HUMAN');
    assert.equal(open[0].subjectType, 'PROJECT');
    assert.equal(open[0].subjectId, f.projectId);
    assert.equal(open[0].dedupeKey, noProgressDedupeKey(f.projectId));
    assert.equal(open[0].lifecycleGeneration, 1n);
    assert.equal(open[0].resolvedAt, null);

    const ledger = await decisions(f);
    const stop = ledger[N];
    assert.equal(stop.outcome, 'STOP');
    assert.equal(stop.nonConvergenceReason, 'NO_PROGRESS');
    assert.equal(stop.crossedLimit, N);
    assert.equal(stop.observed, N + 1);
    assert.equal(stop.raisedBlockerId, open[0].id);
    // Every earlier row is a PROCEED that raised nothing, and every row carries the pair.
    for (const row of ledger.slice(0, N)) {
      assert.equal(row.outcome, 'PROCEED');
      assert.equal(row.raisedBlockerId, null);
    }
    assert.equal(ledger[0].previousProgressVector, null, 'the first wake has no before');
    for (const row of ledger.slice(1)) {
      assert.ok(row.previousProgressVector, 'every wake after the first records what it improved on');
    }
    assert.equal((ledger[1].previousProgressVector as unknown as ProgressVector).acceptanceTotal, 3);
  } finally {
    await cleanup(f);
  }
});

/**
 * Acceptance criterion 3, and the whole reason this unit was specified the way it was.
 *
 * `COORDINATOR_NO_PROGRESS` used to be re-derived from a snapshot on every pass, so clearing it
 * bought seconds: the same dead session id produced the same `reasonDigest`, the row came back, and
 * `assertDoneAllowed` held a project whose criteria had all passed at OPEN. Here the condition
 * still holds — twelve further facts say so — and not one of them writes a second row.
 */
test('a stop-loss blocker a person resolved does not come back without new progress', {
  skip: !URL,
  timeout: 180_000,
}, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < N + 1; i += 1) await wake(f, randomUUID());
    const raised = await blockers(f);
    assert.equal(raised.length, 1);

    // The person deals with it.
    await f.db.projectBlocker.update({
      where: { id: raised[0].id },
      data: { resolvedAt: new Date(), resolvedBy: 'USER' },
    });

    // Twelve more genuinely new facts arrive — sessions ending, exactly as before.
    for (let i = 0; i < 12; i += 1) {
      const result = await wake(f, randomUUID());
      assert.equal(result.outcome, 'REFUSED', `wake ${i} after the stop opened a session`);
      assert.equal(result.refusalCode, PROJECT_NOT_CONVERGING);
    }

    const after = await blockers(f);
    assert.equal(after.length, 1, 'the stop-loss blocker was raised a second time');
    assert.equal(after[0].id, raised[0].id);
    assert.ok(after[0].resolvedAt, 'the row a person closed was re-opened');
    assert.equal(after[0].lifecycleGeneration, 1n, 'a second episode was opened on the same key');

    // Exactly one ledger row ever named a blocker, and it is the one that raised it.
    const named = (await decisions(f)).filter((row) => row.raisedBlockerId !== null);
    assert.equal(named.length, 1);
    assert.equal(named[0].raisedBlockerId, raised[0].id);
  } finally {
    await cleanup(f);
  }
});

/**
 * The other half of criterion 3: what DOES bring the coordinator back is the frozen definition of
 * progress and nothing else. One measured dimension improves, `strictlyImproves` says so, the
 * window zeroes, and the next fact wakes it — without anybody clearing a row or restarting a
 * process.
 */
test('a measured improvement is what restarts the waking', {
  skip: !URL,
  timeout: 180_000,
}, async () => {
  const f = await fixture();
  try {
    // One real, unresolved piece of work standing between this project and its criteria. It is
    // what the vector measures; the stop-loss blocker this unit raises is deliberately excluded
    // from its own measurement, so it cannot be the thing that moves.
    const blockerId = await openWorkBlocker(f);
    for (let i = 0; i < N + 1; i += 1) await wake(f, randomUUID());
    assert.equal((await wake(f, randomUUID())).outcome, 'REFUSED');

    await makeProgress(f, blockerId);

    const resumed = await wake(f, randomUUID());
    assert.equal(resumed.opened, true, 'the vector improved and the coordinator was still stopped');

    const ledger = await decisions(f);
    const last = ledger[ledger.length - 1];
    assert.equal(last.progressed, true);
    assert.equal(last.outcome, 'PROCEED');
    assert.equal((last.progressVector as unknown as ProgressVector).openBlockers, 0);
    assert.equal((last.counters as { decisionsWithoutProgress: number }).decisionsWithoutProgress, 0);
    // Still exactly one stop-loss blocker: coming back does not resolve the record of having been
    // stopped. (The work blocker this case resolved is the second row, and it is resolved.)
    const open = await blockers(f);
    assert.deepEqual(open.map((row) => `${row.kind}:${row.resolvedAt === null}`).sort(),
      ['COORDINATOR_NO_PROGRESS:true', 'MERGE_CONFLICT:false']);
  } finally {
    await cleanup(f);
  }
});

/**
 * One fact, delivered five times, is charged once — and the wake ledger and the progress ledger
 * agree about that. A budget that could be spent again by redelivering an event is the counter
 * inflation this unit's key exists to prevent.
 */
test('a redelivered fact charges the budget once and re-reads its own judgment', {
  skip: !URL,
  timeout: 120_000,
}, async () => {
  const f = await fixture();
  try {
    const sessionId = randomUUID();
    const outcomes: string[] = [];
    for (let delivery = 0; delivery < 5; delivery += 1) {
      outcomes.push((await wake(f, sessionId)).outcome);
    }
    assert.deepEqual(outcomes, ['WOKEN', 'ALREADY_AWAKE', 'ALREADY_AWAKE', 'ALREADY_AWAKE', 'ALREADY_AWAKE']);
    assert.equal((await decisions(f)).length, 1);
    assert.equal((await f.convergence.state(f.projectId)).counters.decisionsWithoutProgress, 1);
  } finally {
    await cleanup(f);
  }
});

/**
 * The thresholds a project actually runs under. `convergence_thresholds` is null on every project
 * in this deployment, so `resolveThresholds` is where N comes from — and the row records the
 * resolved value rather than the null, because "why did it stop at 6" is a question the ledger has
 * to be able to answer on its own.
 */
test('a project with no threshold overrides runs on the documented defaults, and says so', {
  skip: !URL,
  timeout: 120_000,
}, async () => {
  const f = await fixture();
  try {
    const stored = await f.db.project.findUniqueOrThrow({
      where: { id: f.projectId },
      select: { convergenceThresholds: true },
    });
    assert.equal(stored.convergenceThresholds, null);
    assert.deepEqual(await f.convergence.thresholds(f.projectId), DEFAULT_CONVERGENCE_THRESHOLDS);

    await wake(f, randomUUID());
    const [row] = await decisions(f);
    assert.deepEqual(row.thresholds, DEFAULT_CONVERGENCE_THRESHOLDS);
  } finally {
    await cleanup(f);
  }
});

/**
 * Raising the limit on purpose is the other exit, and it is the one §2 SM4 calls `BUDGET_EXTENDED`:
 * a decision somebody is accountable for, not a timer. It takes effect on the next fact, because
 * the breaker reads the resolved thresholds every time rather than the ones a stop was decided on.
 */
test('raising the limit deliberately lets the coordinator go on', {
  skip: !URL,
  timeout: 180_000,
}, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < N + 1; i += 1) await wake(f, randomUUID());
    assert.equal((await wake(f, randomUUID())).outcome, 'REFUSED');

    await f.db.project.update({
      where: { id: f.projectId },
      data: { convergenceThresholds: { maxDecisionsWithoutProgress: N + 100 } },
    });
    assert.equal(
      (await f.convergence.thresholds(f.projectId)).maxDecisionsWithoutProgress,
      N + 100,
    );

    const allowed = await wake(f, randomUUID());
    assert.equal(allowed.opened, true);
    // The counters were NOT reset by the extension: the spend stands, and only the line moved.
    assert.ok((await f.convergence.state(f.projectId)).counters.decisionsWithoutProgress > N);
  } finally {
    await cleanup(f);
  }
});
