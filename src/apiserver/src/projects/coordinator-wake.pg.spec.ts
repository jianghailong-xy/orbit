import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  WakeFact,
  attemptEndedUnsettledFact,
  projectTasksSettledFact,
  wakeIdempotencyKey,
} from './coordinator-wake';
import {
  CoordinatorWakeService,
  WAKE_AUTHORIZATION_FAILED,
  WakeAuthorization,
  WakeAuthorizer,
  WakeClaim,
} from './coordinator-wake.service';

/**
 * Unit T2 against a real PostgreSQL, because every claim it makes is the DATABASE's.
 *
 * "Five deliveries of one fact land one row" is a partial unique index; "a refusal gives the key
 * back" is that index's predicate; "the winner is picked before anything is authorized" is the
 * order of two statements around an await. None of the three has a fake-client version that would
 * mean anything — a hand-rolled double agrees with whatever the code does, which is the drift a
 * unique index exists to make impossible.
 *
 *   docker run -d --name pcct2-pg -e POSTGRES_PASSWORD=pcct2 -e POSTGRES_USER=pcct2_admin \
 *     -e POSTGRES_DB=pcct2_wake -p 127.0.0.1:55671:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcct2_admin:pcct2@127.0.0.1:55671/pcct2_wake \
 *     npx prisma migrate deploy
 *   COORDINATOR_PG_URL=postgresql://pcct2_admin:pcct2@127.0.0.1:55671/pcct2_wake \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcct2_wake COORDINATOR_PG_EXPECTED_USER=pcct2_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=$(psql -tAc \
 *     'SELECT system_identifier FROM pg_control_system()') \
 *   node --test build/projects/coordinator-wake.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

/** Always yes. The producer's own authorization is unit T6's; this one only has to not refuse. */
const ALLOW: WakeAuthorizer = () => ({ allowed: true });

const refuse = (refusalCode: string): WakeAuthorizer => () => ({ allowed: false, refusalCode });

interface Fixture {
  db: PrismaClient;
  wakes: CoordinatorWakeService;
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
    data: { id: ownerId, email: `wake-${ownerId}@wake.invalid`, name: 'wake', passwordHash: 'x' },
  });
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId, title: 'wake facts' } });
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'a task whose attempt ends badly',
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      status: TaskStatus.OPEN,
    },
  });
  return {
    db,
    wakes: new CoordinatorWakeService(db as unknown as PrismaService),
    ownerId,
    projectId,
    taskId,
  };
}

/** Every wake row this project has, oldest first — the audit, read the way a person would. */
async function wakeRows(
  db: PrismaClient,
  projectId: string,
): Promise<Array<{ idempotencyKey: string; status: string; refusalCode: string | null }>> {
  return db.projectCoordinatorWake.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    select: { idempotencyKey: true, status: true, refusalCode: true },
  });
}

/** Acceptance criterion 1. */
test(
  'the same committed fact delivered five times lands exactly one wake',
  { skip: !URL, timeout: 120_000 },
  async () => {
    const { db, wakes, projectId, taskId } = await fixture();
    try {
      const sessionId = randomUUID();
      const outcomes = [];
      for (let delivery = 0; delivery < 5; delivery += 1) {
        // Re-derived every time, exactly as a producer that re-reads committed rows would. The
        // fact object is not carried between deliveries — the KEY is what makes them one fact.
        const fact = attemptEndedUnsettledFact({
          projectId,
          taskId,
          taskStatus: 'FAILED',
          sessionId,
        })!;
        outcomes.push(await wakes.claim(fact, ALLOW));
      }

      assert.deepEqual(
        outcomes.map((outcome) => outcome.outcome),
        ['WOKEN', 'ALREADY_AWAKE', 'ALREADY_AWAKE', 'ALREADY_AWAKE', 'ALREADY_AWAKE'],
        'only the first delivery of a fact may wake anybody',
      );

      const rows = await wakeRows(db, projectId);
      assert.equal(rows.length, 1, 'five deliveries of one fact wrote more than one row');
      assert.equal(rows[0].status, 'CLAIMED');
      assert.equal(
        rows[0].idempotencyKey,
        `cw:v1:ATTEMPT_ENDED_UNSETTLED:TASK:${taskId}:${sessionId}`,
      );

      // Concurrency, not just repetition: five deliveries racing each other still land one row,
      // and they land it because of the index rather than because they took turns.
      const secondSession = randomUUID();
      const raced = await Promise.all(
        Array.from({ length: 5 }, () =>
          wakes.claim(
            attemptEndedUnsettledFact({
              projectId,
              taskId,
              taskStatus: 'FAILED',
              sessionId: secondSession,
            })!,
            ALLOW,
          ),
        ),
      );
      assert.equal(
        raced.filter((outcome) => outcome.outcome === 'WOKEN').length,
        1,
        'two concurrent deliveries of one fact both woke a coordinator',
      );
      assert.equal((await wakeRows(db, projectId)).length, 2);
    } finally {
      await db.$disconnect();
    }
  },
);

/** Acceptance criterion 2 — the negative one, and the accident it is about. */
test(
  'a refused wake does not spend the key: the same fact wakes once the authorization is fixed',
  { skip: !URL, timeout: 120_000 },
  async () => {
    const { db, wakes, projectId, taskId } = await fixture();
    try {
      const sessionId = randomUUID();
      const fact = (): WakeFact =>
        attemptEndedUnsettledFact({ projectId, taskId, taskStatus: 'FAILED', sessionId })!;
      const key = wakeIdempotencyKey(fact());

      const refused = await wakes.claim(fact(), refuse('COORDINATOR_DISABLED'));
      assert.deepEqual(
        { outcome: refused.outcome, code: 'refusalCode' in refused ? refused.refusalCode : null },
        { outcome: 'REFUSED', code: 'COORDINATOR_DISABLED' },
      );

      // The refusal is ON THE RECORD. A wake that vanished would leave "it silently did nothing"
      // as a state this table can be in, which is the one thing it exists to prevent.
      const afterRefusal = await wakeRows(db, projectId);
      assert.deepEqual(afterRefusal, [
        { idempotencyKey: key, status: 'REFUSED', refusalCode: 'COORDINATOR_DISABLED' },
      ]);

      // ...and the key is free. This is the whole assertion: on `project_action`'s plain unique
      // index the line below is ALREADY_APPLIED forever, and the fact is welded shut.
      const woken = await wakes.claim(fact(), ALLOW);
      assert.equal(woken.outcome, 'WOKEN', 'a refusal spent the key — the fact can never wake again');

      const both = await wakeRows(db, projectId);
      assert.deepEqual(
        both.map((row) => [row.idempotencyKey, row.status]),
        [[key, 'REFUSED'], [key, 'CLAIMED']],
        'the released key produced a second row, and the refusal is still readable beside it',
      );

      // The released key is released ONCE: the live claim now holds it again.
      assert.equal((await wakes.claim(fact(), ALLOW)).outcome, 'ALREADY_AWAKE');
      assert.equal((await wakeRows(db, projectId)).length, 2);
    } finally {
      await db.$disconnect();
    }
  },
);

/** Acceptance criterion 3 — the key is claimed before anything is authorized. */
test(
  'the winner is chosen before authorization, and refusing does not change who won',
  { skip: !URL, timeout: 120_000 },
  async () => {
    const { db, wakes, projectId, taskId } = await fixture();
    try {
      const sessionId = randomUUID();
      const fact = (): WakeFact =>
        attemptEndedUnsettledFact({ projectId, taskId, taskStatus: 'FAILED', sessionId })!;
      const key = wakeIdempotencyKey(fact());

      // The interleaving is FORCED rather than raced. Two deliveries fired at once would prove
      // nothing here: an authorization that refuses releases the key, so a second delivery landing
      // after that release wins for a legitimate reason, and which of the two orders the pool
      // happens to produce is not the property under test. So the winner is parked INSIDE its
      // authorization — the exact window where the gate has been asked and has not yet answered —
      // and the second delivery is issued while it is standing there.
      const seen: Array<{ claim: WakeClaim; rowsAtDecision: number; statusAtDecision: string }> = [];
      let arrived: () => void;
      const authorizerReached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let proceed: () => void;
      const held = new Promise<void>((resolve) => {
        proceed = resolve;
      });

      const inspect =
        (decision: WakeAuthorization, park: boolean): WakeAuthorizer =>
        async (_fact, claim) => {
          // Read the claim back through the CLIENT, not through the value we were handed: what has
          // to be true is that the row is committed and visible, not that a caller passed an id.
          const row = await db.projectCoordinatorWake.findUnique({
            where: { id: claim.wakeId },
            select: { status: true },
          });
          seen.push({
            claim,
            rowsAtDecision: (await wakeRows(db, projectId)).length,
            statusAtDecision: row?.status ?? 'ABSENT',
          });
          if (park) {
            arrived();
            await held;
          }
          return decision;
        };

      const winner = wakes.claim(
        fact(),
        inspect({ allowed: false, refusalCode: 'PROJECT_NOT_AUTOMATED' }, true),
      );
      await authorizerReached;

      // The key was claimed BEFORE this authorization was consulted: there is a committed CLAIMED
      // row, and the authorizer is looking at it while still owing an answer.
      assert.equal(
        seen[0].statusAtDecision,
        'CLAIMED',
        'the authorizer was consulted about a claim that was not committed yet',
      );
      assert.equal(seen[0].rowsAtDecision, 1);
      assert.equal(seen[0].claim.idempotencyKey, key);

      // ...and while it stands, a second delivery of the same fact loses at the INDEX and never
      // reaches an authorizer at all. Nothing about the pending answer took part in deciding that.
      let loserWasAuthorized = false;
      const loser = await wakes.claim(fact(), () => {
        loserWasAuthorized = true;
        return { allowed: true };
      });
      assert.equal(loser.outcome, 'ALREADY_AWAKE', 'two deliveries of one fact both won');
      assert.equal(
        loserWasAuthorized,
        false,
        'the loser was authorized — the gate is being asked before the key is claimed',
      );
      assert.equal(seen.length, 1);

      // Only now does the first delivery's authorization answer, and it answers no.
      proceed!();
      assert.equal((await winner).outcome, 'REFUSED');

      // The key computed for a delivery that gets refused is byte-identical to the one computed
      // for a delivery that gets allowed: the authorization is not an input to the identity.
      const allowedLater = await wakes.claim(fact(), inspect({ allowed: true }, false));
      assert.equal(allowedLater.outcome, 'WOKEN');
      assert.equal(seen[1].claim.idempotencyKey, key);
      assert.equal(seen[1].claim.wakeId === seen[0].claim.wakeId, false, 'a released claim was reused');
    } finally {
      await db.$disconnect();
    }
  },
);

/**
 * An authorizer that throws is not an authorizer that refused — but the key still has to come
 * back. Leaving the claim standing over a dropped connection is the same permanent weld as a
 * refusal that spends the key, arrived at by accident instead of by decision.
 */
test(
  'an authorization that throws releases the key and re-raises',
  { skip: !URL, timeout: 120_000 },
  async () => {
    const { db, wakes, projectId, taskId } = await fixture();
    try {
      const sessionId = randomUUID();
      const fact = (): WakeFact =>
        attemptEndedUnsettledFact({ projectId, taskId, taskStatus: 'FAILED', sessionId })!;

      await assert.rejects(
        wakes.claim(fact(), () => {
          throw new Error('the authorization service is down');
        }),
        /the authorization service is down/,
      );

      const rows = await wakeRows(db, projectId);
      assert.deepEqual(
        rows.map((row) => [row.status, row.refusalCode]),
        [['REFUSED', WAKE_AUTHORIZATION_FAILED]],
      );
      assert.equal((await wakes.claim(fact(), ALLOW)).outcome, 'WOKEN');
    } finally {
      await db.$disconnect();
    }
  },
);

/**
 * The project-scoped fact, end to end over real rows: the version is a digest of what the tasks
 * ARE, so an unrelated write does not re-wake anybody and a genuine change does.
 */
test(
  'a project-settled wake is keyed on the task set, not on when it was last touched',
  { skip: !URL, timeout: 120_000 },
  async () => {
    const { db, wakes, ownerId, projectId, taskId } = await fixture();
    try {
      const other = randomUUID();
      await db.task.create({
        data: {
          id: other,
          ownerId,
          projectId,
          title: 'the second one',
          creatorType: CreatorType.USER,
          creatorId: ownerId,
          status: TaskStatus.OPEN,
        },
      });

      const settledFact = async (): Promise<WakeFact | null> => {
        const tasks = await db.task.findMany({
          where: { projectId },
          select: { id: true, status: true },
        });
        return projectTasksSettledFact(
          projectId,
          tasks.map((task) => ({ taskId: task.id, status: task.status })),
        );
      };

      assert.equal(await settledFact(), null, 'a project with open tasks has not settled');

      await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
      await db.task.update({ where: { id: other }, data: { status: TaskStatus.CANCELLED } });

      const first = (await settledFact())!;
      assert.equal((await wakes.claim(first, ALLOW)).outcome, 'WOKEN');

      // An unrelated write moves `updated_at` and nothing the fact is defined over. Re-derived
      // from the same committed rows, it is the same fact, and it does not wake anybody again.
      await db.task.update({ where: { id: taskId }, data: { title: 'renamed, not reopened' } });
      const unchanged = (await settledFact())!;
      assert.equal(unchanged.subjectVersion, first.subjectVersion);
      assert.equal((await wakes.claim(unchanged, ALLOW)).outcome, 'ALREADY_AWAKE');

      // Reopening a task and settling it to a DIFFERENT status is a different world, and wakes.
      await db.task.update({ where: { id: other }, data: { status: TaskStatus.DONE } });
      const moved = (await settledFact())!;
      assert.notEqual(moved.subjectVersion, first.subjectVersion);
      assert.equal((await wakes.claim(moved, ALLOW)).outcome, 'WOKEN');

      assert.equal((await wakeRows(db, projectId)).length, 2);
    } finally {
      await db.$disconnect();
    }
  },
);

/**
 * The table is the project's, and it goes when the project does. A wake ledger that outlived its
 * project would keep a key alive for a subject that cannot be read any more.
 */
test(
  'deleting a project takes its wake ledger with it',
  { skip: !URL, timeout: 120_000 },
  async () => {
    const { db, wakes, projectId, taskId } = await fixture();
    try {
      await wakes.claim(
        attemptEndedUnsettledFact({
          projectId,
          taskId,
          taskStatus: 'FAILED',
          sessionId: randomUUID(),
        })!,
        ALLOW,
      );
      assert.equal((await wakeRows(db, projectId)).length, 1);

      await db.task.delete({ where: { id: taskId } });
      await db.project.delete({ where: { id: projectId } });
      assert.equal((await wakeRows(db, projectId)).length, 0);
    } finally {
      await db.$disconnect();
    }
  },
);
