import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { Prisma, ProjectAutomationPolicy, RunStatus, TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';
import {
  E2eServices,
  World,
  connectIsolatedPg,
  deliver,
  dispatch,
  drainToIdle,
  emptyWorld,
  failTask,
  servicesOn,
  task,
  world,
} from './project-e2e-harness';
import { ProjectFailureRecoveryService } from './project-failure-recovery.service';
import {
  createDecisionId,
  planProjectDecision,
  publicIdempotencyKey,
} from './project-decision.service';

/**
 * §7.4 A1-b and §9.5 Q3-e on a real PostgreSQL — the half of `PC-CX-64` a pure test cannot state.
 *
 * The decision half is `project-failed-retry.spec.ts` and `project-failure-turn.spec.ts`. What only
 * a database can answer is whether the retry is ONE act: the new Session and the task's
 * `FAILED → IN_PROGRESS` commit together or not at all, the failed Session that is the retry
 * budget's own evidence is not touched, and two passes racing one task produce one run.
 *
 * §34.3's recovery scan is here too, for the same reason: its whole subject is a project whose
 * `next_wake_at` is NULL and whose failure predates the turn machinery — a row shape, not a value.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The state `reclaimStalledTask(..., FAILED)` leaves behind: N failed runs and a FAILED task. */
async function failedTask(
  services: E2eServices,
  target: World,
  title: string,
  options: { times?: number; attributable?: boolean; lastFailureAt?: Date } = {},
): Promise<string> {
  const id = await task(services.db, target, title);
  const times = options.times ?? 1;
  await failTask(services.db, target, id, times, options.lastFailureAt ?? new Date(Date.now() - 60 * 60_000));
  if (options.attributable === false) {
    await services.db.session.updateMany({
      where: { taskId: id, status: RunStatus.FAILED }, data: { error: null },
    });
  }
  await services.db.task.update({ where: { id }, data: { status: TaskStatus.FAILED } });
  return id;
}

async function sessionsOf(services: E2eServices, taskId: string) {
  return services.db.session.findMany({
    where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, status: true, error: true, dispatchOrigin: true, finishedAt: true },
  });
}

async function blockersOf(services: E2eServices, projectId: string) {
  return services.db.projectBlocker.findMany({
    where: { projectId, resolvedAt: null },
    orderBy: [{ kind: 'asc' }],
    select: {
      kind: true, owner: true, recovery: true, requiredAction: true, subjectId: true,
      nextCheckAt: true, lifecycleGeneration: true, conditionVersion: true, occurrences: true,
    },
  });
}

test('unit 28: a FAILED task the loop can still move is dispatched again, atomically',
  { skip, timeout: 900_000 },
  async (t) => {
    const identity = await connectIsolatedPg(URL);
    const services = servicesOn(URL!);

    const scenario = async (name: string, body: () => Promise<void>): Promise<void> => {
      await t.test(name, async () => {
        await emptyWorld(identity);
        await body();
      });
    };

    try {
      await scenario('PC-CX-64: the retry commits the new Session and IN_PROGRESS together',
        async () => {
          const target = await world(services.db, 'retry-atomic',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work');
          const failed = await sessionsOf(services, work);
          assert.equal(failed.length, 1);
          assert.equal(failed[0].status, RunStatus.FAILED);

          // The ONE door: a signal, drained by the real consumer. Nothing calls execute, nothing
          // calls the dispatcher, no legacy sweep runs in this process.
          await deliver(services, target.projectId);
          await drainToIdle(services);

          const actions = await services.db.projectAction.findMany({
            where: { projectId: target.projectId, type: 'DISPATCH_TASK' },
          });
          assert.equal(actions.length, 1, 'the pass proposed exactly one dispatch');
          assert.equal(actions[0].status, 'APPLIED', 'a FAILED task below the cap is dispatchable');
          assert.equal(actions[0].subjectId, work);

          const after = await services.db.task.findUniqueOrThrow({ where: { id: work } });
          assert.equal(after.status, TaskStatus.IN_PROGRESS,
            'A1-b: the retry moves the task off FAILED in the same transaction');
          assert.equal(after.dispatchAttempt, 1n, 'DA1: one claimed action, one attempt');

          const now = await sessionsOf(services, work);
          assert.equal(now.length, 2, 'the retry is a NEW run, never a rewritten one');
          const [old, fresh] = now;
          assert.equal(old.id, failed[0].id);
          assert.equal(old.status, RunStatus.FAILED, 'A1-b: the old run keeps its verdict');
          assert.equal(old.error, failed[0].error, 'and its error, which is the retry budget itself');
          assert.equal(old.finishedAt?.getTime(), failed[0].finishedAt?.getTime());
          assert.equal(fresh.id, actions[0].resultSessionId);
          assert.equal(fresh.status, RunStatus.PENDING);
          assert.equal(fresh.dispatchOrigin, 'PROJECT_COORDINATOR');

          assert.deepEqual(await blockersOf(services, target.projectId), [],
            'Q3-a: inside the budget there is nothing for a person to do');
          const turns = await services.db.projectAction.count({
            where: { projectId: target.projectId, type: 'OPEN_COORDINATOR_TURN' },
          });
          assert.equal(turns, 0, 'TU2-b: a retry the loop performs itself wakes nobody');
        });

      await scenario('a refused retry leaves the task FAILED — no half-applied retry exists',
        async () => {
          // The runner is offline, so the dispatch reaches the commit point and is REFUSED there.
          // Everything up to the Session insert has run; the status flip must not survive it.
          const target = await world(services.db, 'retry-rollback', {
            policy: ProjectAutomationPolicy.GUARDED_AUTO,
            runnerStatus: 'OFFLINE',
          });
          const work = await failedTask(services, target, 'work');

          const outcome = await dispatch(services, target, work);
          assert.equal(outcome.status, 'REFUSED');
          assert.equal(outcome.sessionId, null);

          const after = await services.db.task.findUniqueOrThrow({ where: { id: work } });
          assert.equal(after.status, TaskStatus.FAILED,
            'a refusal is not a retry: the task is exactly where it was');
          assert.equal((await sessionsOf(services, work)).length, 1, 'and no run was created');
        });

      await scenario('a REPLAY of one retry key produces one run and one flip',
        async () => {
          const target = await world(services.db, 'retry-race',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work');

          // The same permanent key, twice, SEQUENTIALLY — a pass replayed after a crash, or a
          // delivery redelivered. The concurrent case is the scenario below; this one is the
          // property §8.3 calls replay-idempotence, and the two are not the same test.
          const first = await dispatch(services, target, work, 1);
          const second = await dispatch(services, target, work, 1);
          assert.equal(first.applyStatus, 'APPLIED');
          assert.equal(second.applyStatus, 'ALREADY_APPLIED');
          assert.equal(second.sessionId, first.sessionId, 'the replay names the run that exists');

          const runs = await sessionsOf(services, work);
          assert.equal(runs.length, 2, 'one failed run, one retry — not two retries');
          assert.equal(
            (await services.db.task.findUniqueOrThrow({ where: { id: work } })).status,
            TaskStatus.IN_PROGRESS,
          );
        });

      await scenario('two dispatchers racing ONE retry, released together, still make one run',
        async () => {
          const target = await world(services.db, 'retry-concurrent',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work');
          const failedBefore = (await sessionsOf(services, work))[0];

          // A second service graph = a second PrismaClient = a second connection pool. Without it
          // the two attempts would take turns on one pool and this would be the replay test again.
          const other = servicesOn(URL!, { registerHandler: false, registerDispatchPass: false });
          const lease = await services.reconciler.acquireLease(target.projectId);
          assert.ok(lease, 'the project under test must be leasable');
          const decisionId = createDecisionId();
          const idempotencyKey = `pc:v1:${target.projectId}:dispatch:${work}:1`;
          const barrier = new Client({ connectionString: URL });
          await barrier.connect();
          try {
            // ONE decision, claimed by both attempts — two holders that both decided the same
            // retry, which is the only way two dispatches of one key exist at once.
            //
            // Written BEFORE the barrier is taken, and that order is load-bearing: `capture` reads
            // the project row this scenario is about to lock, so a barrier held across it would
            // block the test's own setup and no dispatcher would ever start.
            await services.db.$transaction(async (tx) => {
              const captured = await services.decisions.capture(tx, target.projectId);
              const outcome = planProjectDecision(captured.input, {
                decisionId,
                actions: [{
                  type: 'DISPATCH_TASK',
                  idempotencyKey: publicIdempotencyKey(idempotencyKey),
                  subject: { type: 'TASK', id: uuidToBase62(work) },
                }],
              });
              await services.decisions.persist(tx, captured, outcome, decisionId);
            }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

            // The barrier: a third connection holds the project row, which is the FIRST statement
            // both dispatch transactions make (§7.7's linearization point is
            // `SELECT … FROM project … FOR NO KEY UPDATE`). Both therefore stop before doing
            // anything, and are released into the ledger at the same instant.
            await barrier.query('BEGIN');
            await barrier.query('SELECT "id" FROM "project" WHERE "id" = $1 FOR UPDATE',
              [target.projectId]);

            const command = { decisionId, taskId: work, idempotencyKey };
            // Started, NOT awaited: both are in flight before either can finish.
            const left = services.dispatcher.dispatch(lease!, command);
            const right = other.dispatcher.dispatch(lease!, command);

            // Wait until PostgreSQL itself says both are blocked on that row lock, so the release
            // below is a release of two contenders and not of one that already went past.
            //
            // `pg_locks.granted = false` rather than `pg_stat_activity.wait_event_type`: the lock
            // table is the authority on "is waiting for this row", and it is true from the instant
            // the request queues. The poll is deliberately short — both dispatchers are inside a
            // Prisma interactive transaction while they wait, and that has a five-second timeout of
            // its own, so a barrier held longer would test the timeout rather than the race.
            const waiters = async (): Promise<number> => {
              const rows = await barrier.query<{ waiting: string }>(
                `SELECT count(*)::text AS waiting FROM pg_locks
                  WHERE NOT granted AND pid <> pg_backend_pid()`,
              );
              return Number(rows.rows[0].waiting);
            };
            for (let i = 0; i < 150 && await waiters() < 2; i += 1) {
              await new Promise((resolve) => { setTimeout(resolve, 10); });
            }
            if (await waiters() < 2) {
              const state = await barrier.query(
                `SELECT pid, state, wait_event_type, wait_event, left(query, 70) AS query
                   FROM pg_stat_activity WHERE datname = current_database()`,
              );
              assert.fail(`both dispatchers must be waiting on the barrier: ${
                JSON.stringify(state.rows)}`);
            }
            await barrier.query('COMMIT');

            const settled = await Promise.allSettled([left, right]);
            const applied = settled.filter((result) => result.status === 'fulfilled'
              && result.value.action.status === 'APPLIED');
            assert.equal(applied.length, 1,
              `exactly one attempt may apply, got ${JSON.stringify(settled.map((r) => (
                r.status === 'fulfilled' ? r.value.action.status : `rejected:${String(r.reason)}`)))}`);

            const actions = await services.db.projectAction.findMany({
              where: { projectId: target.projectId, type: 'DISPATCH_TASK' },
            });
            assert.equal(actions.length, 1, '§8.2: one permanent key, one row');
            assert.equal(actions[0].status, 'APPLIED');
            assert.equal(actions[0].idempotencyKey, idempotencyKey);

            const runs = await sessionsOf(services, work);
            assert.equal(runs.length, 2, 'one failed run and exactly one retry');
            assert.equal(runs.filter((run) => run.status === RunStatus.PENDING).length, 1);
            assert.equal(runs[0].id, failedBefore.id);
            assert.equal(runs[0].status, RunStatus.FAILED, 'the old run is untouched by the race');
            assert.equal(runs[0].error, failedBefore.error);
            assert.equal(runs[0].finishedAt?.getTime(), failedBefore.finishedAt?.getTime());

            const after = await services.db.task.findUniqueOrThrow({ where: { id: work } });
            assert.equal(after.status, TaskStatus.IN_PROGRESS, 'flipped once, by the winner');
            assert.equal(after.dispatchAttempt, 1n, 'DA1: the attempt never advances on a replay');
          } finally {
            await services.reconciler.releaseLease(lease!);
            await barrier.end().catch(() => undefined);
            await other.dispose();
          }
        });

      await scenario('a second failure lands back at FAILED and spends the next rung',
        async () => {
          const target = await world(services.db, 'retry-second',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work');
          await deliver(services, target.projectId);
          await drainToIdle(services);

          const retry = await services.db.session.findFirstOrThrow({
            where: { taskId: work, status: RunStatus.PENDING },
          });
          // What a runner reporting a failure does, in the two writes production makes.
          await services.db.session.update({
            where: { id: retry.id },
            data: { status: RunStatus.FAILED, error: 'second failure', finishedAt: new Date() },
          });
          await services.db.task.update({ where: { id: work }, data: { status: TaskStatus.FAILED } });

          const failures = await services.db.session.count({
            where: { taskId: work, status: RunStatus.FAILED },
          });
          assert.equal(failures, 2, 'IN_PROGRESS as the retry target is what makes this land here');

          // Rung two of §9.5's ladder is 8 minutes, and the second failure just happened — so the
          // next pass must NOT dispatch, and must not open anything either.
          await deliver(services, target.projectId, 'task.status_changed');
          await drainToIdle(services);
          const actions = await services.db.projectAction.findMany({
            where: { projectId: target.projectId, type: 'DISPATCH_TASK' },
          });
          assert.equal(actions.length, 1, 'Q3 row 2: inside the backoff the loop waits');
          assert.deepEqual(await blockersOf(services, target.projectId), []);
        });

      await scenario('Q3-e: the budget runs out — one blocker, one turn, no further dispatch',
        async () => {
          const target = await world(services.db, 'retry-exhausted',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work', { times: MAX_AUTO_RUN_FAILURES });

          await deliver(services, target.projectId);
          await drainToIdle(services);

          assert.equal(
            await services.db.projectAction.count({
              where: { projectId: target.projectId, type: 'DISPATCH_TASK' },
            }),
            0,
            'Q1: automatic dispatch stops',
          );
          const blockers = await blockersOf(services, target.projectId);
          assert.equal(blockers.length, 1);
          assert.equal(blockers[0].kind, 'TEST_FAILED');
          assert.equal(blockers[0].owner, 'USER', 'Q3-b: a person owns it');
          assert.equal(blockers[0].recovery, 'HUMAN');
          assert.equal(blockers[0].subjectId, work);
          assert.ok(blockers[0].requiredAction.length > 0, 'BL1: it says what to do');
          assert.ok(blockers[0].nextCheckAt, 'BL1: and when it is looked at again');
          assert.equal(
            (await services.db.task.findUniqueOrThrow({ where: { id: work } })).status,
            TaskStatus.FAILED,
            'nothing moved it, which is the point',
          );
        });

      await scenario('Q3-e / BL10: the overlap opens ONE row, and a second pass does not add the other',
        async () => {
          // Both terminal conditions at once: the budget is spent AND no failed run said why.
          const target = await world(services.db, 'retry-overlap',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work',
            { times: MAX_AUTO_RUN_FAILURES, attributable: false });

          await deliver(services, target.projectId);
          await drainToIdle(services);

          const first = await blockersOf(services, target.projectId);
          assert.deepEqual(first.map((row) => row.kind), ['UNKNOWN_FAILURE'],
            'BL10: UNKNOWN_FAILURE wins, and TEST_FAILED is not also opened');
          assert.equal(first[0].subjectId, work);
          assert.equal(first[0].lifecycleGeneration, 1n);

          // Reconcile the same world again: §11.3 touches the row, and the other kind must not
          // appear on the second look either.
          await deliver(services, target.projectId, 'task.updated');
          await drainToIdle(services);
          const again = await blockersOf(services, target.projectId);
          assert.deepEqual(again.map((row) => row.kind), ['UNKNOWN_FAILURE']);
          assert.equal(again[0].lifecycleGeneration, 1n, 'BE1: the same condition, not a new episode');
          assert.equal(again[0].conditionVersion, first[0].conditionVersion);
          assert.ok(again[0].occurrences >= first[0].occurrences, 'ES5: it was seen again');
          assert.equal(
            await services.db.projectBlocker.count({
              where: { projectId: target.projectId, kind: 'TEST_FAILED' },
            }),
            0,
            'not even a resolved one — the second kind was never raised',
          );
        });

      await scenario('the ladder ends where unit 27 begins: retries, then exactly one delivered turn',
        async () => {
          // The composition the two units have to make together, driven through the real doors
          // only. v1.18 gives an ordinary failure back to the loop; the property unit 27 froze —
          // a settled failure the loop cannot move produces one reliably DELIVERED coordination
          // turn — has to survive that, or "the coordinator hears about failures" would have been
          // traded for "the coordinator retries them".
          const target = await world(services.db, 'retry-then-turn',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work');

          // Fail it the rest of the way, one real dispatch → real failure cycle at a time.
          for (let rung = 1; rung < MAX_AUTO_RUN_FAILURES; rung += 1) {
            await deliver(services, target.projectId, 'task.updated');
            await drainToIdle(services);
            const retry = await services.db.session.findFirst({
              where: { taskId: work, status: RunStatus.PENDING },
            });
            assert.ok(retry, `rung ${rung}: the loop must have retried by itself`);
            // What the runner reporting a failure writes, in the two writes production makes.
            await services.db.session.update({
              where: { id: retry!.id },
              data: { status: RunStatus.FAILED, error: `failure ${rung + 1}`, finishedAt: new Date() },
            });
            await services.db.task.update({
              where: { id: work }, data: { status: TaskStatus.FAILED } });
            // §9.5's rungs are 2/8/30/120 minutes and this scenario runs in seconds: age the runs
            // so the NEXT pass is past the backoff. It moves the one fact the rule reads.
            await services.db.session.updateMany({
              where: { taskId: work, status: RunStatus.FAILED },
              data: { createdAt: new Date(Date.now() - 24 * 60 * 60_000) },
            });
          }

          const failures = await services.db.session.count({
            where: { taskId: work, status: RunStatus.FAILED } });
          assert.equal(failures, MAX_AUTO_RUN_FAILURES, 'the ladder is spent, one rung at a time');

          await deliver(services, target.projectId, 'task.updated');
          await drainToIdle(services);

          // Unit 27's property, unchanged, at the end of unit 28's ladder.
          const turnActions = await services.db.projectAction.findMany({
            where: { projectId: target.projectId, type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED' },
          });
          assert.equal(turnActions.length, 1, 'exactly one turn for this episode');
          assert.equal(turnActions[0].reasonCode, 'TASK_FAILURE');

          const coordinatorSessionId = (await services.db.project.findUniqueOrThrow({
            where: { id: target.projectId }, select: { coordinatorSessionId: true },
          })).coordinatorSessionId;
          assert.ok(coordinatorSessionId, 'the loop opened a coordination run to deliver into');
          const delivered = await services.db.conversationTurn.findMany({
            where: { sessionId: coordinatorSessionId! }, orderBy: { seq: 'asc' },
          });
          assert.equal(delivered.length, 2, 'the opening prompt, then the failure turn');
          assert.equal(delivered[1].kind, 'message', 'an ordinary message, never a steer');
          assert.equal(delivered[1].clientTurnId, turnActions[0].idempotencyKey);
          assert.ok((delivered[1].content ?? '').includes('TASK_FAILURE'));
          const run = await services.db.session.findUniqueOrThrow({
            where: { id: coordinatorSessionId! }, select: { status: true } });
          assert.ok(run.status === RunStatus.PENDING || run.status === RunStatus.RUNNING,
            'the run is claimable, so the turn can actually be executed');

          // And the person-facing half is there too, on the same failure.
          const blockers = await blockersOf(services, target.projectId);
          assert.deepEqual(blockers.map((row) => row.kind), ['TEST_FAILED']);

          // Replay: the same world reconciled again opens no second turn (TR1/TR3 unchanged).
          await deliver(services, target.projectId, 'task.updated');
          await drainToIdle(services);
          assert.equal(
            await services.db.projectAction.count({
              where: { projectId: target.projectId, type: 'OPEN_COORDINATOR_TURN', status: 'APPLIED' },
            }),
            1,
            'one episode, one turn — the retries did not buy extra ones',
          );
        });

      await scenario('MANUAL does not retry silently: the refusal is a row a person can see',
        async () => {
          const target = await world(services.db, 'retry-manual',
            { policy: ProjectAutomationPolicy.MANUAL });
          const work = await failedTask(services, target, 'work');

          await deliver(services, target.projectId);
          await drainToIdle(services);

          const actions = await services.db.projectAction.findMany({
            where: { projectId: target.projectId, type: 'DISPATCH_TASK' },
          });
          assert.equal(actions.length, 1, 'the attempt is made, so the refusal is auditable');
          assert.equal(actions[0].status, 'REFUSED');
          assert.equal(actions[0].reasonCode, 'POLICY_REQUIRES_APPROVAL');
          assert.equal(
            (await services.db.task.findUniqueOrThrow({ where: { id: work } })).status,
            TaskStatus.FAILED,
            'MANUAL means nothing moved',
          );
          const blockers = await blockersOf(services, target.projectId);
          assert.ok(
            blockers.some((row) => row.kind === 'AWAITING_USER_APPROVAL'),
            'BL1: a refused dispatch is never silent',
          );
        });
    } finally {
      await services.dispose();
      await identity.end();
    }
  });

test('unit 28: the one-shot recovery scan re-arms a project nothing else would look at again',
  { skip, timeout: 900_000 },
  async (t) => {
    const identity = await connectIsolatedPg(URL);
    const services = servicesOn(URL!);
    const recovery = new ProjectFailureRecoveryService(services.db as unknown as PrismaService);

    const scenario = async (name: string, body: () => Promise<void>): Promise<void> => {
      await t.test(name, async () => {
        await emptyWorld(identity);
        await body();
      });
    };

    /** §10.4 N-null's one legal shape: no wake, and every open blocker escalated to a person. */
    async function stopItsOwnClock(target: World, taskId: string): Promise<void> {
      await services.db.projectRuntime.update({
        where: { projectId: target.projectId },
        data: { nextWakeAt: null, nextWakeReason: null, runState: 'AWAITING_HUMAN' },
      });
      // Raw SQL for the same reason every other pg spec seeds this table that way: the row has
      // database-side defaults and a partial unique index that the typed create would have to
      // restate, and what this scenario needs is the SHAPE §10.4 N-null describes.
      await services.db.$executeRaw(Prisma.sql`
        INSERT INTO "project_blocker" (
          "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
          "next_check_at", "subject_type", "subject_id", "dedupe_key", "lifecycle_generation",
          "condition_version", "first_seen_at", "last_seen_at", "escalated_at", "updated_at"
        ) VALUES (
          gen_random_uuid(), ${target.projectId}::uuid, 'TEST_FAILED', 'USER', 'HUMAN', 'CRITICAL',
          'look at it', CURRENT_TIMESTAMP + interval '1 hour', 'TASK', ${taskId}::text,
          ${`TEST_FAILED:TASK:${taskId}`}, 1, repeat('a', 64),
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `);
    }

    try {
      await scenario('PC-CX-66: a pre-v1.17 failure with no turn gets a wake, once',
        async () => {
          const target = await world(services.db, 'recover-null',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work', { times: MAX_AUTO_RUN_FAILURES });
          await stopItsOwnClock(target, work);

          const before = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.equal(before.nextWakeAt, null, 'nothing would look at this project again');

          const outcome = await recovery.scan();
          assert.deepEqual(outcome.rearmed.length, 1, 'the scan found the episode nobody answered');
          assert.deepEqual(outcome.deferred, []);

          const after = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.ok(after.nextWakeAt, 'and gave §10.2 W1 something to pick up');
          assert.ok(after.nextWakeAt!.getTime() <= Date.now() + 1_000);
          assert.match(after.nextWakeReason ?? '', /recovery/);

          // Idempotent, and in the strong sense: the second run performs NO WRITE. `updated_at` is
          // the witness — a scan that rewrote the same value would move it, and "wrote it again"
          // is a side effect however equal the value is.
          const second = await recovery.scan();
          assert.deepEqual(second, { rearmed: [], deferred: [] }, 'nothing left to do');
          const third = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.equal(third.nextWakeAt!.getTime(), after.nextWakeAt!.getTime(),
            'the scan only ever moves a wake earlier, and it is already now');
          assert.equal(third.updatedAt.getTime(), after.updatedAt.getTime(),
            'the second scan did not touch the row at all');
          assert.equal(
            await services.db.projectAction.count({ where: { projectId: target.projectId } }),
            0,
            'and it writes no action of its own — the loop still owns every key',
          );

          // …and the wake it wrote is a real one: the loop picks it up and answers the episode.
          await deliver(services, target.projectId);
          await drainToIdle(services);
          const turns = await services.db.projectAction.findMany({
            where: { projectId: target.projectId, type: 'OPEN_COORDINATOR_TURN' },
          });
          assert.ok(turns.length <= 1, 'I15: at most one turn came out of it');
        });

      await scenario('an episode a turn already names is not re-armed',
        async () => {
          const target = await world(services.db, 'recover-covered',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work', { times: MAX_AUTO_RUN_FAILURES });
          await stopItsOwnClock(target, work);

          // The ledger's own record that this episode was answered: TF6's `(taskId, attempt)`.
          const attempt = (await services.db.task.findUniqueOrThrow({
            where: { id: work }, select: { dispatchAttempt: true } })).dispatchAttempt;
          await services.db.$executeRaw(Prisma.sql`
            INSERT INTO "project_action" (
              "id", "project_id", "idempotency_key", "type", "status", "subject_type",
              "subject_id", "fencing_token", "reason_code", "detail", "updated_at"
            ) VALUES (
              gen_random_uuid(), ${target.projectId}::uuid,
              ${`pc:v1:${target.projectId}:turn:0:already`}, 'OPEN_COORDINATOR_TURN', 'APPLIED',
              'PROJECT', ${target.projectId}::uuid, 1, 'TASK_FAILURE',
              ${JSON.stringify({ v: 1, turnFacts: [`${uuidToBase62(work)}#${attempt}`] })}::jsonb,
              CURRENT_TIMESTAMP
            )
          `);

          assert.deepEqual(await recovery.scan(), { rearmed: [], deferred: [] },
            'the episode has an answer already');
          const after = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.equal(after.nextWakeAt, null, 'so nothing was touched');
        });

      await scenario('a leased project is DEFERRED, not dropped — the next scan picks it up',
        async () => {
          const target = await world(services.db, 'recover-leased',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await failedTask(services, target, 'work', { times: MAX_AUTO_RUN_FAILURES });
          await stopItsOwnClock(target, work);

          const once = new ProjectFailureRecoveryService(services.db as unknown as PrismaService);
          const lease = await services.reconciler.acquireLease(target.projectId);
          assert.ok(lease, 'the project under test must be leasable');

          const held = await once.recoverOnce();
          assert.deepEqual(held.rearmed, [], 'a holder publishes its own wake under a fencing '
            + 'token, so this write would be lost');
          assert.deepEqual(held.deferred, [uuidToBase62(target.projectId)],
            'and it is reported as deferred rather than silently dropped');
          assert.equal(
            (await services.db.projectRuntime.findUniqueOrThrow({
              where: { projectId: target.projectId } })).nextWakeAt,
            null,
            'nothing was written while the lease was held',
          );

          // The latch is the thing this scenario is really about: `recoverOnce` must not have
          // closed the door on a project it could not answer, or a lease held for one second would
          // cost this process every later chance to recover that project.
          await services.reconciler.releaseLease(lease!);
          const after = await once.recoverOnce();
          assert.deepEqual(after.rearmed, [uuidToBase62(target.projectId)],
            'the second call recovers what the first deferred');
          assert.deepEqual(after.deferred, []);
          const runtime = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.ok(runtime.nextWakeAt, '§10.2 W1 now has something to pick up');
          assert.match(runtime.nextWakeReason ?? '', /recovery/);

          // …and NOW the door is closed: nothing was left behind, so a third call is a no-op.
          assert.deepEqual(await once.recoverOnce(), { rearmed: [], deferred: [] });
        });

      await scenario('recoverOnce runs once when it answered everything', async () => {
        const target = await world(services.db, 'recover-once',
          { policy: ProjectAutomationPolicy.GUARDED_AUTO });
        const work = await failedTask(services, target, 'work', { times: MAX_AUTO_RUN_FAILURES });
        await stopItsOwnClock(target, work);

        const once = new ProjectFailureRecoveryService(services.db as unknown as PrismaService);
        assert.equal((await once.recoverOnce()).rearmed.length, 1);
        assert.deepEqual(await once.recoverOnce(), { rearmed: [], deferred: [] },
          'the second call is a no-op by construction');
      });

    } finally {
      await services.dispose();
      await identity.end();
    }
  });
