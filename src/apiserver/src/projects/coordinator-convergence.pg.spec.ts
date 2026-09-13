import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CONVERGENCE_THRESHOLDS, ZERO_COUNTERS } from './convergence-contract';
import { ProgressVector } from './convergence-progress';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { COORDINATOR_NO_PROGRESS_KIND } from './coordinator-convergence';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { attemptEndedUnsettledFact } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';

/**
 * Unit T4 against a real PostgreSQL, because every claim it makes is the DATABASE's.
 *
 * "The state a restart resumes from is on disk" is only true if a fresh process reads it off disk;
 * "one fact is one judgment" is a unique index; "nothing is raised" is a statement about what is and
 * is not written. None of the three has a fake-client version that would mean anything.
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

/** N: the limit the retired breaker counted to, read from the frozen table. */
const N = DEFAULT_CONVERGENCE_THRESHOLDS.maxDecisionsWithoutProgress as number;

const CRITERIA = ['the ledger is in the database', 'a fact is recorded once', 'nothing is raised'];

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
      title: 'a project whose facts keep arriving',
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
      // Left null on purpose: this is the state every project in production is in, so the
      // thresholds each judgment records have to come from `DEFAULT_CONVERGENCE_THRESHOLDS`.
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
      completionCriterion: 'EVIDENCE_JUDGMENT',
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
 * How a producer uses this unit: claim the committed fact and hand the convergence authorizer
 * along. `opened` is what unit T3 would do with the answer.
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
 * One real, unresolved piece of work standing between the project and its criteria — the
 * dimension of the vector a person can move.
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
 * The state is in the database.
 *
 * The restart is modelled the only way it can honestly be modelled in one process — a SECOND Prisma
 * client and a SECOND service instance, sharing nothing but the database. If any part of what the
 * next judgment reads lived in a field, a closure or a module-level map, the fresh instance would
 * read something else.
 */
test('the ledger is in the database: a fresh service reads the state a restart resumes from', {
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
    assert.equal(before.decisions, 3);
    assert.deepEqual(before.counters, ZERO_COUNTERS);

    // A different client and a different service object: everything a restart would rebuild.
    const restarted = prismaClientFor(URL as string);
    try {
      const fresh = new CoordinatorConvergenceService(restarted as unknown as PrismaService);
      const after = await fresh.state(f.projectId);
      assert.equal(after.decisions, 3, 'a restart read a different ledger');
      assert.deepEqual(after.counters, before.counters);
      assert.deepEqual(after.progressVector, before.progressVector);
      assert.equal(after.lastOutcome, 'PROCEED');

      // And the next wake CONTINUES the ledger rather than starting one.
      const continued = new CoordinatorWakeService(restarted as unknown as PrismaService);
      const fact = attemptEndedUnsettledFact({
        projectId: f.projectId,
        taskId: f.taskId,
        taskStatus: 'OPEN',
        sessionId: randomUUID(),
      });
      assert.ok(fact);
      await continued.claim(fact, fresh.authorizeWake);
      assert.equal((await fresh.state(f.projectId)).decisions, 4);
    } finally {
      await restarted.$disconnect();
    }
  } finally {
    await cleanup(f);
  }
});

/**
 * Where the retired breaker stopped the project, nothing stops.
 *
 * N + 3 genuinely different facts about a project that is not improving: every one is allowed and
 * recorded, none is charged, and the blocker the breaker used to raise on the (N + 1)th is not.
 */
test('wakes past the old limit are all allowed and recorded, and nothing is charged or raised', {
  skip: !URL,
  timeout: 120_000,
}, async () => {
  const f = await fixture();
  try {
    const opened: boolean[] = [];
    for (let i = 0; i < N + 3; i += 1) {
      // A NEW session id every time: each of these is a genuinely different committed fact.
      opened.push((await wake(f, randomUUID())).opened);
    }
    assert.deepEqual(opened, Array.from({ length: N + 3 }, () => true));
    assert.deepEqual(await blockers(f), []);

    const ledger = await decisions(f);
    assert.equal(ledger.length, N + 3);
    for (const row of ledger) {
      assert.equal(row.outcome, 'PROCEED');
      assert.equal(row.nonConvergenceReason, null);
      assert.equal(row.observed, null);
      assert.equal(row.crossedLimit, null);
      assert.equal(row.raisedBlockerId, null);
      assert.equal(row.progressed, false);
      assert.deepEqual(row.counters, ZERO_COUNTERS);
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
 * The ledger still measures. One dimension improves, `strictlyImproves` says so, and that judgment
 * is the one recorded as progress — without anybody clearing a row the ledger raised, because it
 * raises none.
 */
test('a measured improvement is recorded as progress', {
  skip: !URL,
  timeout: 180_000,
}, async () => {
  const f = await fixture();
  try {
    const blockerId = await openWorkBlocker(f);
    for (let i = 0; i < N + 1; i += 1) await wake(f, randomUUID());

    await makeProgress(f, blockerId);
    assert.equal((await wake(f, randomUUID())).opened, true);

    const ledger = await decisions(f);
    assert.deepEqual(
      ledger.map((row) => row.progressed),
      [...Array.from({ length: N + 1 }, () => false), true],
    );
    const last = ledger[ledger.length - 1];
    assert.equal((last.previousProgressVector as unknown as ProgressVector).openBlockers, 1);
    assert.equal((last.progressVector as unknown as ProgressVector).openBlockers, 0);
    assert.deepEqual(
      (await blockers(f)).map((row) => `${row.kind}:${row.resolvedAt === null}`),
      ['MERGE_CONFLICT:false'],
    );
    assert.equal((await blockers(f)).some((row) => row.kind === COORDINATOR_NO_PROGRESS_KIND), false);
  } finally {
    await cleanup(f);
  }
});

/** One fact, delivered five times, is one judgment — and the wake ledger and this one agree. */
test('a redelivered fact is recorded once and re-reads its own judgment', {
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
    assert.equal((await f.convergence.state(f.projectId)).decisions, 1);
  } finally {
    await cleanup(f);
  }
});

/**
 * The thresholds a project runs under. `convergence_thresholds` is null on every project in this
 * deployment, so `resolveThresholds` is where they come from — and the row records the resolved
 * value rather than the null, so the ledger can answer on its own what was in force.
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
