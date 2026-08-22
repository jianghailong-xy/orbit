import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  createDecisionId,
  planProjectDecision,
  ProjectDecisionService,
} from './project-decision.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileLease, ProjectReconcileService } from './project-reconcile.service';
import {
  ProjectTaskDispatchCommand,
  ProjectTaskDispatcherService,
} from './project-task-dispatcher.service';
import { dispatchDesiredSessionId } from './project-dispatch-identity';
import { PROJECT_BLOCKER_NON_BLOCKING_REFUSALS } from './project-blocker';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * H2 — a dispatch REQUEST has a permanent name, and the Session it intends to write is derived from
 * it, on a real PostgreSQL.
 *
 * What every scenario here is really about is a question the old code could not answer: **is the
 * row that beat me my own?** With `randomUUID()` the answer was unobtainable, so the loser guessed
 * — from "the newest Session on this task" and from a live-status window that moves while the
 * lookup is being made. The two guesses fail in opposite directions, and both are reproduced below:
 * a winner that finished first reads as ABSENT (and a second run gets opened for a request that had
 * already run), and a paused run belonging to somebody else reads as PRESENT.
 *
 * These are real-server scenarios and not unit ones because every mechanism under test is the
 * database's: three unique indexes, two deferred constraint triggers, and REPEATABLE READ's rule
 * that a row committed after your snapshot is invisible to you even when you just collided with it.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Provider slugs and emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface Fixture {
  ownerId: string;
  projectId: string;
  agentId: string;
  runnerId: string;
  taskId: string;
}

interface Services {
  db: PrismaClient;
  decisions: ProjectDecisionService;
  reconciler: ProjectReconcileService;
  dispatcher: ProjectTaskDispatcherService;
  announced: string[];
}

function servicesOn(db: PrismaClient): Services {
  const prisma = db as unknown as PrismaService;
  const events = new ProjectEventsService(prisma);
  const decisions = new ProjectDecisionService(prisma);
  const reconciler = new ProjectReconcileService(prisma, events, decisions);
  const announced: string[] = [];
  const dispatcher = new ProjectTaskDispatcherService(
    prisma,
    reconciler,
    new ProjectAuthorizationService(),
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    { publishSessionCreated: (id: string) => announced.push(id) } as unknown as RealtimeService,
  );
  return { db, decisions, reconciler, dispatcher, announced };
}

function connectServices(): Services {
  return servicesOn(prismaClientFor(URL!));
}

async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@pcch2.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: ['session-orchestration-credential-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: label,
      coordinatorEnabled: true,
      automationPolicy: ProjectAutomationPolicy.AUTO,
      maxConcurrentTasks: 3,
    },
  });
  await db.projectMember.create({
    data: { projectId, agentId, role: ProjectRole.COORDINATOR },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      assigneeId: agentId,
      title: `${label}-task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      provider: 'claude',
    },
  });
  return { ownerId, projectId, agentId, runnerId, taskId };
}

async function plan(
  services: Pick<Services, 'db' | 'decisions' | 'reconciler'>,
  target: Fixture,
  options: { attempt?: number; lease?: ProjectReconcileLease } = {},
): Promise<{ lease: ProjectReconcileLease; command: ProjectTaskDispatchCommand }> {
  const lease = options.lease ?? await services.reconciler.acquireLease(target.projectId);
  assert.ok(lease, 'the fixture Project must be leasable');
  const decisionId = createDecisionId();
  const idempotencyKey =
    `pc:v1:${target.projectId}:dispatch:${target.taskId}:${options.attempt ?? 1}`;
  await services.db.$transaction(async (tx) => {
    const captured = await services.decisions.capture(tx, target.projectId);
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: [{
        type: 'DISPATCH_TASK',
        idempotencyKey,
        subject: { type: 'TASK', id: uuidToBase62(target.taskId) },
      }],
    });
    await services.decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { lease, command: { decisionId, taskId: target.taskId, idempotencyKey } };
}

/** The refusal as a LEDGER ROW, which is the only form another process ever sees it in. */
async function refusalRow(db: PrismaClient, actionId: string) {
  const action = await db.projectAction.findUniqueOrThrow({ where: { id: actionId } });
  const detail = action.detail as Record<string, {
    reasonCode?: string; refusalCode?: string; retryable?: boolean; retryAt?: string | null;
  }>;
  return { action, failure: detail.dispatchFailure ?? {} };
}

/**
 * A Session that is NOT this request's, written the one way a test legitimately can.
 *
 * `USER` origin, because 0122's `session_dispatch_attribution_check` refuses a
 * `PROJECT_COORDINATOR` row that no APPLIED action points at — and because §12.3 D3's carve-out is
 * exactly "a person pressed start". `startsTaskWork` because §13.6 SU6 makes that the difference
 * between a run and somebody reading about one.
 */
async function foreignSession(
  db: PrismaClient,
  target: Fixture,
  id: string,
  status: RunStatus,
): Promise<string> {
  const created = await db.session.create({
    data: {
      id,
      ownerId: target.ownerId,
      creatorId: target.ownerId,
      taskId: target.taskId,
      workspaceId: target.agentId,
      assignedRunnerId: target.runnerId,
      title: 'pcch2',
      prompt: 'pcch2',
      provider: 'claude',
      status,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      finishedAt: status === RunStatus.SUCCEEDED || status === RunStatus.FAILED ? new Date() : null,
    },
  });
  return created.id;
}

test('two connections running one request leave one Session, under the id the request names',
  { skip, timeout: 120_000 }, async () => {
    const services = connectServices();
    const second = servicesOn(prismaClientFor(URL!));
    try {
      const target = await fixture(services.db, 'same-request');
      const planned = await plan(services, target);
      const [a, b] = await Promise.all([
        services.dispatcher.dispatch(planned.lease, planned.command),
        second.dispatcher.dispatch(planned.lease, planned.command),
      ]);

      assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1,
        'one request must not produce two runs');
      assert.equal(a.sessionId, b.sessionId, 'both connections must name the same Session');
      // The point of the whole unit: the id was not merely AGREED on after the fact, it was
      // KNOWABLE in advance. A recovery that never received either response can still find this row.
      assert.equal(a.sessionId, dispatchDesiredSessionId(planned.command.idempotencyKey),
        'the Session must carry the id derived from the request');
      assert.equal(
        await services.db.projectAction.count({
          where: { idempotencyKey: planned.command.idempotencyKey },
        }),
        1,
        'one request must not spend two permanent action keys',
      );
      // Exactly one of the two performed it; the other replayed. Neither is an error.
      const applied = [a, b].filter((r) => r.action.status === 'APPLIED');
      assert.equal(applied.length, 1, 'exactly one connection may perform the effect');
    } finally {
      await services.db.$disconnect();
      await second.db.$disconnect();
    }
  });

test('a winner that reached a terminal status first is still returned exactly',
  { skip, timeout: 120_000 }, async () => {
    const services = connectServices();
    try {
      // Every status a fast run can be in by the time the loser looks — the two live ones the
      // claim index covers, and the three terminal ones it does not. A status-filtered lookup
      // reports the last three as ABSENT, which is how a second run gets opened for a request that
      // already finished.
      //
      // What secures this is §8.3's ledger rather than the derived id: `result_session_id` is a
      // durable column on the action row, so the replay answer does not consult the Session's
      // status at all. Asserted here because that independence is the property, and nothing else
      // in the suite would notice if a status predicate were added to it.
      for (const status of [
        RunStatus.AWAITING_INPUT,
        RunStatus.INTERRUPTED,
        RunStatus.SUCCEEDED,
        RunStatus.FAILED,
        RunStatus.CANCELLED,
      ]) {
        const target = await fixture(services.db, `winner-${status.toLowerCase()}`);
        const planned = await plan(services, target);
        const first = await services.dispatcher.dispatch(planned.lease, planned.command);
        assert.ok(first.sessionId, 'the first dispatch must produce a Session');

        await services.db.session.update({
          where: { id: first.sessionId! },
          data: {
            status,
            ...(status === RunStatus.AWAITING_INPUT || status === RunStatus.INTERRUPTED
              ? {} : { finishedAt: new Date() }),
          },
        });

        const replay = await services.dispatcher.dispatch(planned.lease, planned.command);
        assert.equal(replay.sessionId, first.sessionId,
          `a ${status} winner must still be named exactly`);
        assert.equal(replay.action.status, 'ALREADY_APPLIED');
        assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1,
          `a ${status} winner must not be joined by a second run`);
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('a paused Session under a different id is not mistaken for this request\'s',
  { skip, timeout: 120_000 }, async () => {
    const services = connectServices();
    try {
      for (const status of [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED, RunStatus.PENDING]) {
        const target = await fixture(services.db, `paused-${status.toLowerCase()}`);
        // Somebody else's run, holding the task's claim under an id this request did not derive.
        // Written BEFORE the snapshot: a row that appears after it makes §7.4's staleness gate the
        // one that answers, and this scenario is about what the DISPATCH says, not the planner.
        const holder = await foreignSession(services.db, target, randomUUID(), status);
        const planned = await plan(services, target);
        assert.notEqual(holder, dispatchDesiredSessionId(planned.command.idempotencyKey));

        const result = await services.dispatcher.dispatch(planned.lease, planned.command);

        assert.equal(result.sessionId, null, 'this request produced no run, and must not claim one');
        const { action, failure } = await refusalRow(services.db, result.action.actionId);
        assert.equal(action.refusalCode, 'TASK_ALREADY_RUNNING');
        assert.equal(failure.reasonCode, 'TASK_ALREADY_RUNNING');
        assert.equal(action.resultSessionId, null,
          'a refused dispatch must not adopt somebody else\'s Session');
        // The paused run is still exactly where it was — not resumed, not relabelled, not adopted.
        const untouched = await services.db.session.findUniqueOrThrow({ where: { id: holder } });
        assert.equal(untouched.status, status);
        assert.equal(untouched.projectActionId, null);
        assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1);
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('a Session already holding the derived id is a fact to read, never a raw unique violation',
  { skip, timeout: 120_000 }, async () => {
    const services = connectServices();
    try {
      // The mixed-version shape, and the one the old `ON CONFLICT ("task_id")` clause could not
      // survive: a row already carries the id this request derives, and the task's live claim is
      // FREE, so the only index the insert can collide on is the PRIMARY KEY. PostgreSQL allows one
      // inference clause, so that collision used to leave the transaction as a raw P2002 — no
      // refusal code, no `dispatchFailure`, and §8.5 C1's "keep committing the rest of the outcome"
      // physically impossible because the transaction was already aborted.
      const target = await fixture(services.db, 'derived-id-taken');
      const key = `pc:v1:${target.projectId}:dispatch:${target.taskId}:1`;
      const desired = dispatchDesiredSessionId(key);
      // Before the snapshot, so the dispatch really reaches its INSERT rather than being turned
      // back by the staleness gate — the collision is the thing under test.
      await foreignSession(services.db, target, desired, RunStatus.SUCCEEDED);
      const planned = await plan(services, target);
      assert.equal(planned.command.idempotencyKey, key);

      const result = await services.dispatcher.dispatch(planned.lease, planned.command);

      assert.equal(result.sessionId, null, 'a raced insert must not report a run it did not make');
      const { action, failure } = await refusalRow(services.db, result.action.actionId);
      // §13.1 AG6-e: the DURABLE column carries a word every replica in a rolling deploy already
      // classifies. A code only this build knows would be read by the old one as `UNKNOWN_FAILURE`
      // against the PROJECT — "stop everything", permanently.
      assert.equal(action.refusalCode, 'STALE_SNAPSHOT');
      assert.ok(PROJECT_BLOCKER_NON_BLOCKING_REFUSALS.has(action.refusalCode!));
      // ...while the precise cause is still recorded, next to the id that collided.
      assert.equal(action.reasonCode, 'DISPATCH_SESSION_RACED');
      assert.equal(failure.reasonCode, 'DISPATCH_SESSION_RACED');
      assert.equal(failure.retryable, true);
      assert.ok(failure.retryAt, 'a race that resolves itself must say when to come back');
      const detail = action.detail as Record<string, unknown>;
      assert.equal(detail.desiredSessionId, desired);
      // No second run, and the row that was already there is untouched.
      assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1);
      const untouched = await services.db.session.findUniqueOrThrow({ where: { id: desired } });
      assert.equal(untouched.status, RunStatus.SUCCEEDED);
      assert.equal(untouched.projectActionId, null);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a live Session under the derived id is typed busy, not a raw unique violation',
  { skip, timeout: 120_000 }, async () => {
    const services = connectServices();
    try {
      // Same collision, with the claim held: two indexes can answer and the truthful one wins.
      const target = await fixture(services.db, 'derived-id-live');
      const desired = dispatchDesiredSessionId(`pc:v1:${target.projectId}:dispatch:${target.taskId}:1`);
      await foreignSession(services.db, target, desired, RunStatus.RUNNING);
      const planned = await plan(services, target);

      const result = await services.dispatcher.dispatch(planned.lease, planned.command);

      assert.equal(result.sessionId, null);
      const { action } = await refusalRow(services.db, result.action.actionId);
      assert.equal(action.refusalCode, 'TASK_ALREADY_RUNNING');
      assert.equal(action.resultSessionId, null);
      assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a request whose key another connection claimed first replays instead of erroring',
  { skip, timeout: 120_000 }, async () => {
    const services = connectServices();
    assertCoordinatorPgUrlIsIsolated(URL);
    const claimant = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    const observer = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await claimant.connect();
    await observer.connect();
    await verifyCoordinatorPgIdentity(observer);
    try {
      const target = await fixture(services.db, 'key-raced');
      const planned = await plan(services, target);

      // A concurrent replica of the SAME request claims the key and has not committed yet.
      await claimant.query('BEGIN');
      await claimant.query(
        `INSERT INTO "project_action" ("id", "project_id", "idempotency_key", "type", "status",
           "subject_type", "subject_id", "fencing_token", "detail", "updated_at")
         VALUES ($1::uuid, $2::uuid, $3, 'DISPATCH_TASK', 'CLAIMED', 'TASK', $4::uuid, $5, '{}'::jsonb, now())`,
        [randomUUID(), target.projectId, planned.command.idempotencyKey, target.taskId,
          planned.lease.fencingToken.toString()],
      );

      // This one takes its REPEATABLE READ snapshot BEFORE that row is visible, then blocks on the
      // unique index behind it.
      const raced = services.dispatcher.dispatch(planned.lease, planned.command);
      // Bounded, and short: a Prisma interactive transaction times out at 5s, so a barrier held
      // longer would be measuring the timeout instead of the race.
      const blocked = await waitForBlockedBackend(observer, 1_500);
      assert.ok(blocked, 'the second claim must block on the action key');
      await claimant.query('COMMIT');

      // Measured rather than assumed: under REPEATABLE READ, `INSERT ... ON CONFLICT DO NOTHING`
      // whose conflicting row was committed after the snapshot raises `40001` — it does NOT insert
      // nothing and leave the row invisible. So §8.6 LO4's bounded retry is what carries this, and
      // this scenario is here to keep that true: the loser must come back on a fresh snapshot and
      // get the replay answer, not surface a serialization error to the caller.
      const result = await raced;
      assert.equal(result.action.status, 'ALREADY_APPLIED');
      assert.equal(
        await services.db.projectAction.count({
          where: { idempotencyKey: planned.command.idempotencyKey },
        }),
        1,
        'the raced key must still be spent exactly once',
      );
      assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 0,
        'the claimant wrote no Session, so neither may this one');
    } finally {
      await claimant.query('ROLLBACK').catch(() => undefined);
      await claimant.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      await services.db.$disconnect();
    }
  });

/**
 * Poll for a backend parked on a lock, from a connection of its own.
 *
 * A `pg` Client runs its queries strictly in order, so asking the BLOCKED connection anything —
 * even its own pid — queues behind the statement that is stuck, and the test hangs until its parent
 * kills it. Observation is always somebody else's connection.
 */
async function waitForBlockedBackend(observer: Client, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
    if (rows[0]?.n > 0) return true;
  }
  return false;
}
