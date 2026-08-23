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
  SessionDispatchOrigin,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { Deadline } from '../deadlock/pg-barrier';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';
import { taskRunDesiredSessionId, taskRunRequestKey, taskRunResumeTurnId } from './task-run-identity';
import { TASK_RUN_ACTION } from './task-run-receipt';

/**
 * H2F — a legacy run request is a COMMAND WITH A RECEIPT, on a real PostgreSQL, through the public
 * door.
 *
 * The unit began as "recover the winner of a lost execution claim by reading rather than guessing",
 * and independent review took it apart twice. Both times for the same reason: a name derived from
 * anything the database already knows is not a request identity, because the door re-runs its
 * mutable gates before it reaches the name. A delivery that arrives after the world moved answers
 * something the request never asked — a 400 where the first attempt returned a Session, a second
 * Session where it returned one, a second durable USER trigger on a Project the press never named.
 *
 * So the request carries its own name (`triggerId`, one per press or per tool invocation) and the
 * answer is recorded at the DOOR. Everything below drives `TasksService.execute` / `batchExecute` —
 * the methods the API controller, the runner's `task_start` and `orbit task start` all call — and
 * every replay is a SECOND CALL on a FRESH service over a FRESH pool, which is the only shape the
 * property has to hold in.
 *
 * Mechanisms under test, all of them the server's: `session_task_execution_claim_idx` (0130), the
 * PRIMARY KEY a derived id puts back in range, `conversation_turn (session_id, client_turn_id)`,
 * 0137's receipt with its `statement_timestamp()` lease and `attempt` fence, and the shape a
 * duplicate has by the time Prisma's driver adapter hands it to the classifier.
 *
 * Destructive: it seeds and contends rows, so it runs only against the disposable servers
 * `scripts/project-pg-matrix.sh` and `scripts/deadlock-barrier.sh` provision.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);
const TITLE = 'h2f run';

interface Fixture {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
  taskId: string;
}

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  /** The same instance the tasks service dispatches through — its own object, not a cast. */
  sessions: SessionsService;
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
  return { db, sessions, tasks: new TasksService(prisma, sessions, publishes) };
}

async function fixture(db: PrismaClient, label: string): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@h2f.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: label,
      // LEGACY dispatch authority, which is what puts these presses through `execute` rather than
      // through the Coordinator — the doors this unit is about.
      coordinatorEnabled: false, automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  await db.task.create({
    data: {
      id: taskId, ownerId, projectId, assigneeId: agentId, title: TITLE,
      creatorType: CreatorType.USER, creatorId: ownerId, provider: 'claude',
    },
  });
  return { ownerId, runnerId, agentId, projectId, taskId };
}

/** Run Now, through the method every legacy door calls, under a named press. */
async function runNow(services: Services, target: Fixture, triggerId: string): Promise<string> {
  const result = await services.tasks.execute(target.ownerId, target.taskId, undefined, triggerId);
  assert.ok(result.sessionId, `Run Now must answer with a Session, got ${JSON.stringify(result)}`);
  return result.sessionId;
}

/** The id that press names — computed HERE, from the token, with no help from the server. */
const desiredIdFor = (target: Fixture, triggerId: string) =>
  taskRunDesiredSessionId(taskRunRequestKey({ taskId: target.taskId, requestToken: triggerId }));

async function receiptRow(
  db: PrismaClient,
  target: Fixture,
  token: string,
  kind: string = TASK_RUN_ACTION.execute,
) {
  const [row] = await db.$queryRaw<Array<{
    status: string; target: unknown; result: unknown; attempt: number;
    leaseHolder: string | null; leaseExpiresAt: Date | null;
  }>>`
    SELECT "status", "target", "result", "attempt",
           "lease_holder" AS "leaseHolder", "lease_expires_at" AS "leaseExpiresAt"
      FROM "task_run_request"
     WHERE "owner_id" = ${target.ownerId}::uuid
       AND "action_kind" = ${kind} AND "request_token" = ${token}`;
  return row;
}

const TERMINAL = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

async function moveTo(db: PrismaClient, sessionId: string, status: RunStatus) {
  await db.session.update({
    where: { id: sessionId },
    data: {
      status,
      finishedAt: (TERMINAL as RunStatus[]).includes(status) ? new Date() : null,
    },
  });
}

/** The durable USER signals a press left behind, newest first. */
async function manualTriggers(db: PrismaClient, target: Fixture) {
  return db.projectEvent.findMany({
    where: { projectId: target.projectId, kind: 'user.manual_trigger' },
    select: { id: true, dedupeKey: true, occurrences: true, consumedAt: true },
    orderBy: { occurredAt: 'desc' },
  });
}

test('two Run Now presses racing under one token leave one Session and one answer',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const a = connect();
    const b = connect();
    try {
      const target = await fixture(a.db, 'race');
      const press = randomUUID();

      const answers = await Promise.allSettled([
        runNow(a, target, press),
        runNow(b, target, press),
      ]);

      assert.equal(await a.db.session.count({ where: { taskId: target.taskId } }), 1,
        'one press must not produce two runs');
      const started = answers.filter((r) => r.status === 'fulfilled');
      assert.ok(started.length >= 1, 'one of them must have answered');
      for (const answer of started) {
        assert.equal((answer as PromiseFulfilledResult<string>).value, desiredIdFor(target, press),
          'and it must be the Session the press already named');
      }
      // The other delivery is not allowed to evaluate a second time: it either read the answer or
      // was told the request is being answered. Both are structured; neither is a second run.
      for (const refused of answers) {
        if (refused.status !== 'rejected') continue;
        const error = refused.reason as Error & { status?: number; response?: { code?: string } };
        assert.equal(error.status, 409);
        assert.equal(error.response?.code, 'TASK_RUN_REQUEST_IN_PROGRESS');
      }
      assert.equal((await receiptRow(a.db, target, press))?.status, 'COMPLETED');
    } finally {
      await a.db.$disconnect();
      await b.db.$disconnect();
    }
  });

// The repair, in every state a winner can be in, through the public door, on a service built after
// the first one is gone. The receipt answers before a single mutable gate runs, which is what makes
// the seven states one rule rather than seven.
for (const status of [
  RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED,
  RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED,
]) {
  test(`the same press repeated after its answer was lost returns the ${status} winner`,
    { skip, timeout: 120_000 }, async () => {
      assertCoordinatorPgUrlIsIsolated(URL!);
      const first = connect();
      let target: Fixture;
      let winner: string;
      let firstSignal: { id: string };
      const press = randomUUID();
      try {
        target = await fixture(first.db, `winner-${status.toLowerCase()}`);
        winner = await runNow(first, target, press);
        assert.equal(winner, desiredIdFor(target, press));
        const opened = await manualTriggers(first.db, target);
        assert.equal(opened.length, 1, 'the press recorded its durable USER trigger');
        firstSignal = opened[0];
        await moveTo(first.db, winner, status);
      } finally {
        await first.db.$disconnect();
      }

      const retry = connect();
      try {
        const again = await runNow(retry, target, press);

        assert.equal(again, winner, `a ${status} winner must come back as the winner`);
        assert.equal(uuidToBase62(again), uuidToBase62(winner));
        assert.equal(await retry.db.session.count({ where: { taskId: target.taskId } }), 1,
          'a repeated press must not open a second run');
        const signals = await manualTriggers(retry.db, target);
        assert.equal(signals.length, 1, 'one press, one durable USER trigger');
        assert.equal(signals[0].id, firstSignal.id, 'and the same row, not a replacement');
      } finally {
        await retry.db.$disconnect();
      }
    });
}

for (const status of TERMINAL) {
  test(`a DIFFERENT press after a ${status} run is a new attempt, not a replay`,
    { skip, timeout: 120_000 }, async () => {
      // The other half of the name: a token that made every later press the same request would turn
      // Run Now on a finished task into a button that reports success and starts nothing.
      assertCoordinatorPgUrlIsIsolated(URL!);
      const services = connect();
      try {
        const target = await fixture(services.db, `next-${status.toLowerCase()}`);
        const first = await runNow(services, target, randomUUID());
        await moveTo(services.db, first, status);

        const secondPress = randomUUID();
        const second = await runNow(services, target, secondPress);

        assert.notEqual(second, first, 'a new press gets a Session of its own');
        assert.equal(second, desiredIdFor(target, secondPress));
        assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 2);
        assert.equal((await manualTriggers(services.db, target)).length, 2,
          'two presses, two durable USER triggers');
      } finally {
        await services.db.$disconnect();
      }
    });
}

test('one token cannot name two requests', { skip, timeout: 120_000 }, async () => {
  // A client that reuses a `triggerId` for a different task would otherwise be handed the first
  // task's Session and told its second request succeeded.
  assertCoordinatorPgUrlIsIsolated(URL!);
  const services = connect();
  try {
    const target = await fixture(services.db, 'mismatch');
    const other = await fixture(services.db, 'mismatch-other');
    await services.db.task.update({
      where: { id: other.taskId },
      data: { ownerId: target.ownerId, assigneeId: target.agentId, projectId: target.projectId },
    });
    const press = randomUUID();
    await runNow(services, target, press);

    await assert.rejects(
      () => services.tasks.execute(target.ownerId, other.taskId, undefined, press),
      (error: Error & { status?: number; response?: { code?: string } }) => {
        assert.equal(error.status, 409);
        assert.equal(error.response?.code, 'TASK_RUN_REQUEST_MISMATCH');
        return true;
      },
    );
    assert.equal(await services.db.session.count({ where: { taskId: other.taskId } }), 0,
      'and it starts nothing');
  } finally {
    await services.db.$disconnect();
  }
});

for (const status of [RunStatus.PENDING, RunStatus.RUNNING]) {
  test(`a ${status} run started by a DIFFERENT press is refused by name, never adopted`,
    { skip, timeout: 120_000 }, async () => {
      // Nothing doctored: a genuine `starts_task_work` run doing the task's work, started by one
      // press, and a second press arriving under its own token.
      assertCoordinatorPgUrlIsIsolated(URL!);
      const services = connect();
      try {
        const target = await fixture(services.db, `foreign-${status.toLowerCase()}`);
        const holder = await runNow(services, target, randomUUID());
        await moveTo(services.db, holder, status);
        const before = await manualTriggers(services.db, target);

        await assert.rejects(
          () => runNow(services, target, randomUUID()),
          (error: Error & { status?: number; response?: Record<string, unknown> }) => {
            assert.equal(error.status, 409, 'a 409 the caller can act on, not a 500');
            // The SAME shape the post-`P2002` path gives. Two doors onto one fact answered in two
            // shapes is how a client ends up parsing English to tell them apart.
            const shape = error.response ?? {};
            assert.equal(shape.code, 'TASK_ALREADY_RUNNING');
            assert.equal(shape.conflictingSessionId, uuidToBase62(holder));
            assert.equal(shape.taskId, uuidToBase62(target.taskId));
            assert.equal(shape.retryable, true);
            assert.doesNotMatch(JSON.stringify(shape), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
            assert.doesNotMatch(error.message, /Unique constraint|P2002/);
            return true;
          },
        );

        assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1);
        assert.deepEqual(
          (await manualTriggers(services.db, target)).map((row) => row.id),
          before.map((row) => row.id),
          'a refused press records no durable USER request either',
        );
      } finally {
        await services.db.$disconnect();
      }
    });
}

test('a press that woke a PAUSED run delivers one turn, however many times it is delivered',
  { skip, timeout: 120_000 }, async () => {
    // The resume door's durable result is the TURN, not a Session — the Session belongs to the press
    // that created it — and the key it is written under used to be derived from `numTurns`, which
    // the delivery itself advances. A repeat then read a higher count, derived a different key, and
    // put the task's brief in front of the agent a second time.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const opening = connect();
    let target: Fixture;
    let paused: string;
    let turnsAfterFirstDelivery: number;
    const press = randomUUID();
    try {
      target = await fixture(opening.db, 'resume-turn');
      paused = await runNow(opening, target, randomUUID());
      await moveTo(opening.db, paused, RunStatus.AWAITING_INPUT);

      assert.equal(await runNow(opening, target, press), paused);
      const delivered = await opening.db.conversationTurn.findMany({
        where: { sessionId: paused, clientTurnId: taskRunResumeTurnId(press, paused) },
        select: { id: true },
      });
      assert.equal(delivered.length, 1, 'one press, one turn, under the key the press names');
      turnsAfterFirstDelivery = await opening.db.conversationTurn.count({
        where: { sessionId: paused },
      });
      // The delivery woke the run, which is exactly the state a repeat arrives in — and the state
      // in which the Session's id belongs to a DIFFERENT press than the one repeating.
      const woken = await opening.db.session.findUniqueOrThrow({
        where: { id: paused }, select: { status: true },
      });
      assert.ok(([RunStatus.PENDING, RunStatus.RUNNING] as RunStatus[]).includes(woken.status));
    } finally {
      await opening.db.$disconnect();
    }

    const retry = connect();
    try {
      assert.equal(await runNow(retry, target, press), paused,
        'the repeat answers with the run it already spoke to, not a 409 about somebody else');
      assert.equal(
        await retry.db.conversationTurn.count({ where: { sessionId: paused } }),
        turnsAfterFirstDelivery,
        'and delivers no second prompt',
      );
      assert.equal(await retry.db.session.count({ where: { taskId: target.taskId } }), 1);
    } finally {
      await retry.db.$disconnect();
    }
  });

test('a press whose signal has already been ANSWERED still records nothing on replay',
  { skip, timeout: 120_000 }, async () => {
    // The gap a partial unique index cannot close: `project_event_open_dedupe_idx` is unique only
    // while `consumed_at IS NULL`, so once the Coordinator has answered the first signal the same
    // dedupe key inserts a SECOND event. 0137's permanent marker is what closes it.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const opening = connect();
    let target: Fixture;
    let winner: string;
    const press = randomUUID();
    try {
      target = await fixture(opening.db, 'consumed');
      winner = await runNow(opening, target, press);
      const [signal] = await manualTriggers(opening.db, target);
      await opening.db.projectEvent.update({
        where: { id: signal.id },
        data: { consumedAt: new Date(), disposition: 'RECONCILED' },
      });
      await moveTo(opening.db, winner, RunStatus.SUCCEEDED);
    } finally {
      await opening.db.$disconnect();
    }

    const retry = connect();
    try {
      assert.equal(await runNow(retry, target, press), winner);
      const signals = await manualTriggers(retry.db, target);
      assert.equal(signals.length, 1, 'no second signal behind the consumed one');
      assert.ok(signals[0].consumedAt, 'the one that exists is the answered one');
      assert.equal(
        await retry.db.taskRunManualTrigger.count({ where: { projectId: target.projectId } }), 1,
      );
    } finally {
      await retry.db.$disconnect();
    }
  });

test('the Session outlives the task it ran, and the request still finds it',
  { skip, timeout: 120_000 }, async () => {
    // `session_task_id_fkey` is `ON DELETE SET NULL`: deleting a task TOMBSTONES its runs. A
    // recovery that required `task_id` to still match would fail to find the Session THIS request
    // created, then try to create a second one against a task that no longer exists — for ever,
    // under a token that can never answer.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const opening = connect();
    let target: Fixture;
    let winner: string;
    const press = randomUUID();
    try {
      target = await fixture(opening.db, 'tombstone');
      winner = await runNow(opening, target, press);
      await moveTo(opening.db, winner, RunStatus.SUCCEEDED);
      // The receipt is deliberately rewound to BOUND so the replay has to RESOLVE the artifact
      // rather than read a frozen answer — the state a crash between the effect and the answer
      // leaves, which is the only state in which the tombstone matters.
      await opening.db.$executeRaw`
        UPDATE "task_run_request" SET "status" = 'BOUND', "result" = NULL
         WHERE "owner_id" = ${target.ownerId}::uuid AND "request_token" = ${press}`;
      await opening.db.task.delete({ where: { id: target.taskId } });
      const orphan = await opening.db.session.findUniqueOrThrow({
        where: { id: winner }, select: { taskId: true },
      });
      assert.equal(orphan.taskId, null, 'the run survives its task with a null task_id');
    } finally {
      await opening.db.$disconnect();
    }

    const retry = connect();
    try {
      // BOUND short-circuits before any task read, which is the whole point: the takeover carries
      // out the plan the receipt froze rather than re-deciding against a world that has moved. So
      // it resolves this request's own artifact — by its exact derived id, with `task_id` now
      // null — and answers with the Session it created, instead of failing to find it and trying
      // for ever to create a second one against a task that no longer exists.
      const result = await retry.tasks.execute(target.ownerId, target.taskId, undefined, press);

      assert.deepEqual(result, { ok: true, sessionId: winner },
        'the request answers with the run it made, tombstoned or not');
      assert.equal(await retry.db.session.count({ where: { id: winner } }), 1,
        'and no second Session was written');
      assert.equal((await receiptRow(retry.db, target, press))?.status, 'COMPLETED');
    } finally {
      await retry.db.$disconnect();
    }
  });

test('the lease is the SERVER\'s clock, not this process\'s', { skip, timeout: 120_000 }, async () => {
  // Two apiservers whose wall clocks differ by more than a lease would take each other's requests
  // over — the fast one declaring a live lease expired, the slow one extending one it has lost —
  // and "one evaluator at a time" would be a property of NTP. The lease predicate and its expiry
  // are both `statement_timestamp()`, so a process clock an hour ahead changes nothing.
  assertCoordinatorPgUrlIsIsolated(URL!);
  const services = connect();
  const realNow = Date.now;
  try {
    const target = await fixture(services.db, 'clock');
    const press = randomUUID();
    // Take the lease and leave it held, by binding a plan and never completing it.
    await services.db.$executeRaw`
      INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                      "status", "target", "bound_at", "lease_holder",
                                      "lease_expires_at", "attempt")
      VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${press},
              ${`task:${target.taskId}`}, 'BOUND', ${'{"v":1,"kind":"RUN"}'}::jsonb,
              statement_timestamp(), 'somebody-else',
              statement_timestamp() + make_interval(secs => 60), 1)`;

    Date.now = () => realNow() + 60 * 60_000;
    await assert.rejects(
      () => services.tasks.execute(target.ownerId, target.taskId, undefined, press),
      (error: Error & { response?: { code?: string } }) => {
        assert.equal(error.response?.code, 'TASK_RUN_REQUEST_IN_PROGRESS',
          'an hour of process-clock skew must not take a live lease over');
        return true;
      },
    );
    const held = await receiptRow(services.db, target, press);
    assert.equal(held?.leaseHolder, 'somebody-else', 'and the holder is untouched');
    assert.equal(held?.attempt, 1, 'and its fence did not move');
  } finally {
    Date.now = realNow;
    await services.db.$disconnect();
  }
});

test('an EXPIRED lease is taken over, and the holder it replaced can no longer answer',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'takeover');
      const press = randomUUID();
      // A holder that died mid-evaluation: BOUND, with a lease that has run out.
      const plan = {
        v: 1, kind: 'RUN', plan: { kind: 'CREATE', sessionId: desiredIdFor(target, press) },
        taskId: target.taskId, title: TITLE, prompt: 'do it', workspaceId: target.agentId,
        runnerId: target.runnerId, provider: 'claude', model: null, projectId: target.projectId,
        batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL', runAt: null,
        clearFailed: false, auto: false,
      };
      await services.db.$executeRaw`
        INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                        "status", "target", "bound_at", "lease_holder",
                                        "lease_expires_at", "attempt")
        VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${press},
                ${`task:${target.taskId}`}, 'BOUND', ${JSON.stringify(plan)}::jsonb,
                statement_timestamp(), 'dead-holder',
                statement_timestamp() - make_interval(secs => 1), 1)`;

      const answer = await runNow(services, target, press);

      // The takeover performed the plan it found — the Session the DEAD holder named — rather than
      // deciding again against a world that has moved since.
      assert.equal(answer, desiredIdFor(target, press));
      const row = await receiptRow(services.db, target, press);
      assert.equal(row?.status, 'COMPLETED');
      assert.equal(row?.attempt, 2, 'the takeover is a new attempt, and it fences the old one');
      // And the holder it replaced cannot answer with its own value: its attempt no longer matches,
      // so its compare-and-set writes nothing, and what it hands back is READ FROM THE ROW — the
      // takeover's answer, not the one it was about to invent.
      const stale = await (services.tasks as unknown as {
        completeRunReceipt: (claim: unknown, result: unknown) => Promise<unknown>;
      }).completeRunReceipt(
        {
          ownerId: target.ownerId, actionKind: TASK_RUN_ACTION.execute, requestToken: press,
          leaseHolder: 'dead-holder', attempt: 1,
        },
        { ok: true, sessionId: 'a-different-session' },
      );
      assert.deepEqual(stale, { ok: true, sessionId: answer },
        'a stale holder answers with the row, never with its own result');
      assert.deepEqual((await receiptRow(services.db, target, press))?.result,
        { ok: true, sessionId: answer }, 'and the row is the takeover\'s, unchanged');
    } finally {
      await services.db.$disconnect();
    }
  });

test('a plan this binary cannot read is refused, not guessed at', { skip, timeout: 120_000 }, async () => {
  // A `BOUND` row whose target names a kind or a version this code does not know was written by
  // something else — a newer replica mid-deploy. Guessing is how a takeover applies the wrong
  // effect; the replica that DOES understand it will take the lease when this one lets go.
  assertCoordinatorPgUrlIsIsolated(URL!);
  const services = connect();
  try {
    const target = await fixture(services.db, 'unreadable');
    for (const bogus of ['{"v":2,"kind":"RUN"}', '{"v":1,"kind":"SOMETHING_ELSE"}', '{}']) {
      const press = randomUUID();
      await services.db.$executeRaw`
        INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                        "status", "target", "bound_at")
        VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${press},
                ${`task:${target.taskId}`}, 'BOUND', ${bogus}::jsonb, statement_timestamp())`;

      await assert.rejects(
        () => services.tasks.execute(target.ownerId, target.taskId, undefined, press),
        (error: Error & { response?: { code?: string } }) => {
          assert.equal(error.response?.code, 'TASK_RUN_REQUEST_UNREADABLE', bogus);
          return true;
        },
      );
    }
    assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 0,
      'and nothing was written for any of them');
  } finally {
    await services.db.$disconnect();
  }
});

test('a plan whose task is deleted before it is written answers terminally, once',
  { skip, timeout: 120_000 }, async () => {
    // BOUND, then the task goes. The frozen CREATE names a row `session_task_id_fkey` will refuse
    // for ever, so leaving the receipt BOUND would make every future delivery re-attempt the same
    // doomed insert. It is answered instead — with a decided refusal and no Session.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'bind-then-delete');
      const press = randomUUID();
      const plan = {
        v: 1, kind: 'RUN', plan: { kind: 'CREATE', sessionId: desiredIdFor(target, press) },
        taskId: target.taskId, title: TITLE, prompt: 'do it', workspaceId: target.agentId,
        runnerId: target.runnerId, provider: 'claude', model: null, projectId: target.projectId,
        batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL', runAt: null,
        clearFailed: false, auto: false,
      };
      await services.db.$executeRaw`
        INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                        "status", "target", "bound_at")
        VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${press},
                ${`task:${target.taskId}`}, 'BOUND', ${JSON.stringify(plan)}::jsonb,
                statement_timestamp())`;
      await services.db.task.delete({ where: { id: target.taskId } });

      const answer = await services.tasks.execute(target.ownerId, target.taskId, undefined, press);

      assert.deepEqual(answer, { ok: false, skipped: 'target-tombstoned' });
      assert.equal(await services.db.session.count({ where: { id: plan.plan.sessionId } }), 0);
      const row = await receiptRow(services.db, target, press);
      assert.equal(row?.status, 'COMPLETED', 'and it is decided, not left to be re-attempted');

      // Every later delivery reads that answer rather than trying again.
      const again = connect();
      try {
        assert.deepEqual(
          await again.tasks.execute(target.ownerId, target.taskId, undefined, press),
          { ok: false, skipped: 'target-tombstoned' },
        );
      } finally {
        await again.db.$disconnect();
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('a bulk Run replayed under the same press answers the same batch, item for item',
  { skip, timeout: 180_000 }, async () => {
    // `batchExecute` is the third legacy door and it had two ways to answer a repeat differently
    // from the press it repeats: it classified its own live Sessions as "already running", and it
    // minted a fresh `batch.id` per call — a cap the caller could watch that governed nothing.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const opening = connect();
    let target: Fixture;
    let second: Fixture;
    let first: Awaited<ReturnType<TasksService['batchExecute']>>;
    const press = randomUUID();
    try {
      target = await fixture(opening.db, 'batch-a');
      second = await fixture(opening.db, 'batch-b');
      await opening.db.task.update({
        where: { id: second.taskId },
        data: { ownerId: target.ownerId, assigneeId: target.agentId, projectId: target.projectId },
      });

      first = await opening.tasks.batchExecute(
        target.ownerId, [target.taskId, second.taskId], 2, press,
      );
      assert.equal(first.dispatched, 2, 'both tasks started');
      assert.ok(first.batchId, 'and the press named a batch');
    } finally {
      await opening.db.$disconnect();
    }

    const retry = connect();
    try {
      const again = await retry.tasks.batchExecute(
        target.ownerId, [target.taskId, second.taskId], 2, press,
      );

      assert.deepEqual(again, first, 'a repeat of one press answers with the same bytes');
      const sessions = await retry.db.session.findMany({
        where: { taskId: { in: [target.taskId, second.taskId] } },
        select: { id: true, batchId: true },
      });
      assert.equal(sessions.length, 2, 'two tasks, two runs, however many deliveries');
      for (const row of sessions) {
        assert.equal(row.batchId, first.batchId, 'every Session is in the batch answered');
      }
      assert.equal((await manualTriggers(retry.db, target)).length, 1,
        'one press over one Project is one durable USER trigger');
    } finally {
      await retry.db.$disconnect();
    }

    // A DIFFERENT press over the same live runs is a different request: it starts nothing and says
    // which row is in the way, rather than adopting runs it did not start.
    const other = connect();
    try {
      const answer = await other.tasks.batchExecute(
        target.ownerId, [target.taskId, second.taskId], 2, randomUUID(),
      );
      assert.equal(answer.dispatched, 0);
      assert.equal(answer.skipped.length, 2);
      for (const item of answer.skipped) {
        assert.match(item.reason, /Already running or queued \(session /);
      }
      assert.equal(await other.db.session.count({
        where: { taskId: { in: [target.taskId, second.taskId] } },
      }), 2, 'and starts nothing');
    } finally {
      await other.db.$disconnect();
    }
  });

test('a real server restart does not change which Session a press answers with',
  { skip: skip || !process.env.COORDINATOR_PG_RESTART_COMMAND, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const before = connect();
    let target: Fixture;
    let winner: string;
    const press = randomUUID();
    try {
      target = await fixture(before.db, 'restart');
      winner = await runNow(before, target, press);
      await moveTo(before.db, winner, RunStatus.SUCCEEDED);
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
      assert.equal(await runNow(after, target, press), winner,
        'the same press, the same winner, a new server');
      assert.equal(await after.db.session.count({ where: { taskId: target.taskId } }), 1);
      assert.equal((await manualTriggers(after.db, target)).length, 1);
    } finally {
      await after.db.$disconnect();
    }
  });

/**
 * The two duplicates the Session insert can actually reach, FORCED — and forced by construction
 * rather than by timing.
 *
 * A race would be the obvious way to reach them and it is the worse one: two deliveries of one
 * token are short-circuited by the receipt's lease before either reaches an insert, and two
 * deliveries of DIFFERENT tokens are only sometimes interleaved the way a test needs. So the state
 * each conflict needs is COMMITTED first, and then one call is made — no sleep, no polling, no
 * "usually". What is being proven is the same thing either way: the real index, the real primary
 * key, the shape Prisma 7's pg adapter gives the classifier, and the exact read that answers.
 */
test('a real live-claim duplicate is classified and answered structurally',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'real-claim-p2002');
      // A row that HOLDS the claim index but is invisible to both pre-insert reads: the index
      // covers four statuses and says nothing about `starts_task_work`, while the mid-flight dedup
      // wants PENDING/RUNNING work and the resume candidate wants a paused WORK run. A paused
      // CONVERSATION is neither — so the door goes all the way to the INSERT and meets the index.
      const holder = await services.db.session.create({
        data: {
          id: randomUUID(), ownerId: target.ownerId, creatorId: target.ownerId,
          taskId: target.taskId, workspaceId: target.agentId, assignedRunnerId: target.runnerId,
          title: 'a conversation', prompt: 'about the task', provider: 'claude',
          status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: false,
        },
      });

      const refusal = await runNow(services, target, randomUUID()).catch((e: Error) => e);

      const body = (refusal as { response?: Record<string, unknown> }).response ?? {};
      assert.equal((refusal as { status?: number }).status, 409,
        'a real P2002 on the claim index must not reach the caller as a 500');
      assert.equal(body.code, 'TASK_ALREADY_RUNNING');
      assert.equal(body.conflictingSessionId, uuidToBase62(holder.id),
        'the row in the way is named, as a public id');
      assert.equal(body.taskId, uuidToBase62(target.taskId));
      assert.equal(body.retryable, true);
      assert.ok(typeof body.requiredAction === 'string' && body.requiredAction.length > 0);
      // ...and no UUID anywhere in the body a client is expected to read.
      assert.doesNotMatch(JSON.stringify(body), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
        'a refusal must not leak raw uuids');
      assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 1,
        'and it started nothing');
    } finally {
      await services.db.$disconnect();
    }
  });

test('a real primary-key duplicate on the derived id is classified, and never adopted',
  { skip, timeout: 120_000 }, async () => {
    // The collision a derived id introduces. Something already carries the id this request names —
    // here a row belonging to a DIFFERENT owner, which is the only way it can happen at all — so
    // the insert meets `session_pkey` rather than the claim index, and the answer must be a refusal
    // rather than somebody else's Session handed over as this caller's run.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'real-pk-p2002');
      const stranger = await fixture(services.db, 'real-pk-stranger');
      const press = randomUUID();
      await services.db.session.create({
        data: {
          id: desiredIdFor(target, press), ownerId: stranger.ownerId, creatorId: stranger.ownerId,
          taskId: stranger.taskId, workspaceId: stranger.agentId,
          assignedRunnerId: stranger.runnerId, title: 'not yours', prompt: 'not yours',
          provider: 'claude', status: RunStatus.SUCCEEDED, finishedAt: new Date(),
          dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
        },
      });

      const refusal = await runNow(services, target, press).catch((e: Error) => e);

      assert.equal((refusal as { status?: number }).status, 409,
        'a real P2002 on the primary key must not reach the caller as a 500');
      assert.match((refusal as Error).message, /nothing of it is running/);
      assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), 0,
        'and nothing was started for this task');
      // The row at that id is untouched and still the stranger's.
      const intruder = await services.db.session.findUniqueOrThrow({
        where: { id: desiredIdFor(target, press) }, select: { ownerId: true },
      });
      assert.equal(intruder.ownerId, stranger.ownerId);
    } finally {
      await services.db.$disconnect();
    }
  });

for (const status of [RunStatus.RUNNING, RunStatus.SUCCEEDED]) {
  test(`a BOUND takeover whose Session already exists at ${status} reads it back exactly`,
    { skip, timeout: 120_000 }, async () => {
      // The insert path's own recovery, reached for real: the plan is bound, its Session is already
      // committed at the derived id, and the takeover's insert therefore meets a duplicate. What it
      // must do is read that exact row and answer with it — whatever status it has reached.
      assertCoordinatorPgUrlIsIsolated(URL!);
      const services = connect();
      try {
        const target = await fixture(services.db, `readback-${status.toLowerCase()}`);
        const press = randomUUID();
        const winner = await runNow(services, target, press);
        await moveTo(services.db, winner, status);
        // Rewound to BOUND: the state a crash between the effect and the answer leaves, and the
        // only one in which the takeover has to resolve the artifact rather than read a result.
        await services.db.$executeRaw`
          UPDATE "task_run_request" SET "status" = 'BOUND', "result" = NULL
           WHERE "owner_id" = ${target.ownerId}::uuid AND "request_token" = ${press}`;

        const again = connect();
        try {
          assert.deepEqual(
            await again.tasks.execute(target.ownerId, target.taskId, undefined, press),
            { ok: true, sessionId: winner },
          );
          assert.equal(await again.db.session.count({ where: { taskId: target.taskId } }), 1);
        } finally {
          await again.db.$disconnect();
        }
      } finally {
        await services.db.$disconnect();
      }
    });
}

test('the duplicate shapes the unit tests construct are the ones this server produces',
  { skip, timeout: 120_000 }, async () => {
    // The unit tests classify errors they build by hand. This pins those fixtures to reality: the
    // same two conflicts, provoked against a real server through the same Prisma client the API
    // uses, and asserted to carry what the classifier reads — `meta.driverAdapterError.cause`,
    // which `meta.target` (all the classifier used to look at) is NOT.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const target = await fixture(services.db, 'adapter-shape');
      const row = (id: string, status: RunStatus) => ({
        id, ownerId: target.ownerId, creatorId: target.ownerId, taskId: target.taskId,
        workspaceId: target.agentId, assignedRunnerId: target.runnerId, title: 's', prompt: 'p',
        provider: 'claude', status, dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
        finishedAt: (TERMINAL as RunStatus[]).includes(status) ? new Date() : null,
      });
      const first = randomUUID();
      await services.db.session.create({ data: row(first, RunStatus.PENDING) });

      const claim = await services.db.session.create({ data: row(randomUUID(), RunStatus.PENDING) })
        .catch((e: unknown) => e) as { code?: string; meta?: Record<string, unknown> };
      await services.db.session.update({
        where: { id: first }, data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      const pkey = await services.db.session.create({ data: row(first, RunStatus.PENDING) })
        .catch((e: unknown) => e) as { code?: string; meta?: Record<string, unknown> };

      for (const [name, error, constraint, field] of [
        ['claim index', claim, 'session_task_execution_claim_idx', 'task_id'],
        ['primary key', pkey, 'session_pkey', 'id'],
      ] as const) {
        assert.equal(error.code, 'P2002', name);
        assert.equal(error.meta?.target, undefined,
          `${name}: \`meta.target\` is what the classifier used to read, and this adapter does not set it`);
        const cause = (error.meta as {
          driverAdapterError?: { cause?: { originalMessage?: string; constraint?: { fields?: string[] } } };
        }).driverAdapterError?.cause;
        assert.match(String(cause?.originalMessage), new RegExp(constraint), name);
        assert.deepEqual(cause?.constraint?.fields, [field], name);
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('one bulk-run token cannot name two different selections, and one selection has one name',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    try {
      const a = await fixture(services.db, 'batch-print-a');
      const b = await fixture(services.db, 'batch-print-b');
      for (const other of [b]) {
        await services.db.task.update({
          where: { id: other.taskId },
          data: { ownerId: a.ownerId, assigneeId: a.agentId, projectId: a.projectId },
        });
      }
      const press = randomUUID();
      const first = await services.tasks.batchExecute(a.ownerId, [a.taskId, b.taskId], 2, press);

      // The SAME selection, spelled differently — reordered and with a duplicate — is the same
      // request: `batchExecute` collapses duplicates and order decides nothing about what runs.
      const restated = await services.tasks.batchExecute(
        a.ownerId, [b.taskId, a.taskId, b.taskId], 2, press,
      );
      assert.deepEqual(restated, first, 'a selection restated is the same request');

      // A different selection under the same token is not.
      for (const [why, ids, cap] of [
        ['a task removed', [a.taskId], 2],
        ['a different cap', [a.taskId, b.taskId], 3],
      ] as const) {
        await assert.rejects(
          () => services.tasks.batchExecute(a.ownerId, [...ids], cap, press),
          (error: Error & { response?: { code?: string } }) => {
            assert.equal(error.response?.code, 'TASK_RUN_REQUEST_MISMATCH', why);
            return true;
          },
        );
      }
    } finally {
      await services.db.$disconnect();
    }
  });

test('a delivery that lost its lease cannot write the effect, and a takeover cannot overtake one that is writing',
  { skip, timeout: 180_000 }, async (t) => {
    // THE FENCE, on both sides, and observed rather than timed.
    //
    // The lease decides who may bind a plan and who may freeze an answer. On its own that does not
    // decide who may WRITE: a holder whose lease expired while it was inside `session.create` would
    // still commit a Session that a takeover has already answered for, and the receipt would only
    // notice afterwards — a report, not a prevention. So the write takes the receipt row `FOR
    // UPDATE` inside its own transaction and proves the claim there.
    //
    // Both halves are proven with a lock rather than a sleep: a competitor holds the receipt row,
    // and `pg_blocking_pids` says the takeover is waiting on exactly it.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    const competitor = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    await competitor.connect();
    await verifyCoordinatorPgIdentity(competitor);
    const competitorPid = (await competitor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;
    // A THIRD connection to watch with. The competitor sits `idle in transaction` holding the row,
    // and a watcher has to be free to ask the server who is waiting on it without being one of the
    // two parties it is describing.
    const observer = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    await observer.connect();
    await verifyCoordinatorPgIdentity(observer);
    t.after(async () => {
      await competitor.query('ROLLBACK').catch(() => undefined);
      await competitor.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      await services.db.$disconnect();
    });

    const target = await fixture(services.db, 'effect-fence');
    const press = randomUUID();
    const winner = await runNow(services, target, press);
    // Rewound to BOUND under a holder that is no longer this process, with the lease already
    // expired: the state a crash mid-effect leaves.
    await services.db.$executeRaw`
      UPDATE "task_run_request"
         SET "status" = 'BOUND', "result" = NULL, "lease_holder" = 'dead-holder', "attempt" = 1,
             "lease_expires_at" = statement_timestamp() - make_interval(secs => 1)
       WHERE "owner_id" = ${target.ownerId}::uuid AND "request_token" = ${press}`;

    const rewound = await receiptRow(services.db, target, press);
    assert.equal(rewound?.status, 'BOUND', 'the fixture must actually leave a bound receipt');
    assert.equal(rewound?.leaseHolder, 'dead-holder');

    // 1. THE STALE HOLDER CANNOT WRITE. Its claim names an attempt the row no longer carries, so
    // the write fails inside its own transaction and nothing reaches the Session table.
    const before = await services.db.session.count({ where: { taskId: target.taskId } });
    await assert.rejects(
      () => services.sessions.create(
        target.ownerId,
        { prompt: 'p', workspaceId: target.agentId, taskId: target.taskId, title: 'stale' } as never,
        {
          id: randomUUID(),
          startsTaskWork: true,
          fence: {
            ownerId: target.ownerId, actionKind: TASK_RUN_ACTION.execute, requestToken: press,
            leaseHolder: 'dead-holder', attempt: 99,
          },
        },
      ),
      (error: Error) => {
        assert.equal(error.name, 'TaskRunFenceLost');
        return true;
      },
    );
    assert.equal(await services.db.session.count({ where: { taskId: target.taskId } }), before,
      'a delivery that lost the fence writes nothing at all');

    // 2. AND THE WRITE ITSELF SERIALIZES ON THE RECEIPT. A holder that is legitimately mid-effect
    // holds that row, so nothing can take its lease out from under it — the takeover's own lease
    // statement is the same row, and it WAITS. Proven by holding the row from another backend and
    // asking the server who is blocked on it, rather than by timing anything.
    await services.db.$executeRaw`
      UPDATE "task_run_request" SET "lease_holder" = 'live-holder', "attempt" = 7,
             "lease_expires_at" = statement_timestamp() + make_interval(secs => 60)
       WHERE "owner_id" = ${target.ownerId}::uuid AND "request_token" = ${press}`;
    await competitor.query('BEGIN');
    await competitor.query(
      `SELECT 1 FROM "task_run_request"
        WHERE "owner_id" = $1::uuid AND "action_kind" = $2 AND "request_token" = $3 FOR UPDATE`,
      [target.ownerId, TASK_RUN_ACTION.execute, press],
    );

    const second = randomUUID();
    const writer = connect();
    let settled: unknown;
    const writing = writer.sessions.create(
      target.ownerId,
      { prompt: 'p', workspaceId: target.agentId, title: 'fenced' } as never,
      {
        id: second,
        fence: {
          ownerId: target.ownerId, actionKind: TASK_RUN_ACTION.execute, requestToken: press,
          leaseHolder: 'live-holder', attempt: 7,
        },
      },
    ).then((v) => { settled = v; return v; }, (e) => { settled = e; throw e; });
    writing.catch(() => undefined);

    const deadline = new Deadline(20_000);
    let blockedPid: number | undefined;
    while (blockedPid === undefined) {
      if (deadline.remaining() <= 0) {
        throw new Error(`the fenced write never waited on the receipt row (settled=${
          settled instanceof Error ? settled.message : JSON.stringify(settled)})`);
      }
      const { rows } = await observer.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [competitorPid],
      );
      blockedPid = rows[0]?.pid;
      if (blockedPid === undefined) await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(blockedPid,
      'a write under a fence WAITS for whoever holds the receipt row, rather than passing it');
    assert.equal(settled, undefined, 'and it has written nothing while it waits');

    await competitor.query('ROLLBACK');
    try {
      await writing;
      assert.equal(
        await writer.db.session.count({ where: { id: second } }), 1,
        'and when the row is free, the write it was fencing lands exactly once',
      );
    } finally {
      await writer.db.$disconnect();
    }
  });

test('a LIVE paused run is fenced too — the path a task resume actually takes',
  { skip, timeout: 180_000 }, async (t) => {
    // `AWAITING_INPUT` and `INTERRUPTED` are both LIVE, so a task resume goes through the fast turn
    // path rather than the revive transaction. A fence applied only to the revive would be a fence
    // on the branch nobody uses: a delivery whose lease was taken over would still commit the turn.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    const competitor = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    const observer = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    await competitor.connect();
    await observer.connect();
    await verifyCoordinatorPgIdentity(competitor);
    await verifyCoordinatorPgIdentity(observer);
    const competitorPid = (await competitor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;
    t.after(async () => {
      await competitor.query('ROLLBACK').catch(() => undefined);
      await competitor.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      await services.db.$disconnect();
    });

    for (const parked of [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED]) {
      const target = await fixture(services.db, `live-fence-${parked.toLowerCase()}`);
      const paused = await runNow(services, target, randomUUID());
      await moveTo(services.db, paused, parked);

      const press = randomUUID();
      const plan = {
        v: 1, kind: 'RUN',
        plan: { kind: 'RESUME', sessionId: paused, turnId: taskRunResumeTurnId(press, paused) },
        taskId: target.taskId, title: TITLE, prompt: 'do it', workspaceId: target.agentId,
        runnerId: target.runnerId, provider: 'claude', model: null, projectId: target.projectId,
        batch: null, dispatchOrigin: 'USER', runSource: 'MANUAL', runAt: null,
        clearFailed: false, auto: false,
      };
      await services.db.$executeRaw`
        INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                        "status", "target", "bound_at", "lease_holder",
                                        "lease_expires_at", "attempt")
        VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${press},
                ${`task:${target.taskId}`}, 'BOUND', ${JSON.stringify(plan)}::jsonb,
                statement_timestamp(), 'live-holder',
                statement_timestamp() + make_interval(secs => 60), 3)`;

      // 1. A delivery whose lease was taken over cannot land the turn.
      const turnsBefore = await services.db.conversationTurn.count({ where: { sessionId: paused } });
      await assert.rejects(
        () => services.sessions.resume(
          target.ownerId,
          paused,
          { clientTurnId: taskRunResumeTurnId(press, paused), content: 'do it' } as never,
          {
            startsTaskWork: true,
            fence: {
              ownerId: target.ownerId, actionKind: TASK_RUN_ACTION.execute, requestToken: press,
              leaseHolder: 'live-holder', attempt: 99,
            },
          },
        ),
        (error: Error) => {
          assert.equal(error.name, 'TaskRunFenceLost', `${parked}: a stale delivery must not write`);
          return true;
        },
      );
      assert.equal(
        await services.db.conversationTurn.count({ where: { sessionId: paused } }), turnsBefore,
        `${parked}: and it wrote no turn`,
      );

      // 2. THE PUBLIC DOOR delivers it, and the claim travels all the way to the turn: `execute`
      // plans a RESUME, binds it, and `applyWorkspaceRun` hands `sessions.resume` the claim, which
      // `createTurn` proves inside the transaction that writes the turn. The evidence is the turn's
      // own key — derived from the press, which only that path produces — and the fact that a
      // second delivery of the same press adds none.
      // Its own press, planned by the door rather than seeded: this is the ordinary path a person
      // takes, and the one that has to carry the claim from `execute` to the turn.
      const doorPress = randomUUID();
      const viaDoor = await runNow(services, target, doorPress);
      assert.equal(viaDoor, paused, `${parked}: the press answers with the run it woke`);
      const delivered = await services.db.conversationTurn.findMany({
        where: { sessionId: paused, clientTurnId: taskRunResumeTurnId(doorPress, paused) },
        select: { id: true },
      });
      assert.equal(delivered.length, 1, `${parked}: one press, one turn, under the press's own key`);
      const afterFirst = await services.db.conversationTurn.count({ where: { sessionId: paused } });
      const replayed = connect();
      try {
        assert.equal(await runNow(replayed, target, doorPress), paused);
        assert.equal(
          await replayed.db.conversationTurn.count({ where: { sessionId: paused } }),
          afterFirst,
          `${parked}: and a repeat of that press delivers no second prompt`,
        );
        assert.equal(
          (await receiptRow(replayed.db, target, doorPress))?.status, 'COMPLETED',
          `${parked}: the press is answered, so the repeat reads rather than re-delivers`,
        );
      } finally {
        await replayed.db.$disconnect();
      }

      // 3. And the delivery that holds the claim serializes on the receipt: while another backend
      // holds that row, the turn cannot be written — observed, not timed.
      await moveTo(services.db, paused, parked);
      const second = randomUUID();
      const secondPlan = {
        ...plan,
        plan: { kind: 'RESUME', sessionId: paused, turnId: taskRunResumeTurnId(second, paused) },
      };
      await services.db.$executeRaw`
        INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                        "status", "target", "bound_at", "lease_holder",
                                        "lease_expires_at", "attempt")
        VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.execute}, ${second},
                ${`task:${target.taskId}`}, 'BOUND', ${JSON.stringify(secondPlan)}::jsonb,
                statement_timestamp(), 'live-holder',
                statement_timestamp() + make_interval(secs => 60), 3)`;
      await competitor.query('BEGIN');
      await competitor.query(
        `SELECT 1 FROM "task_run_request"
          WHERE "owner_id" = $1::uuid AND "action_kind" = $2 AND "request_token" = $3 FOR UPDATE`,
        [target.ownerId, TASK_RUN_ACTION.execute, second],
      );
      const writer = connect();
      let settled: unknown;
      const writing = writer.sessions.resume(
        target.ownerId,
        paused,
        { clientTurnId: taskRunResumeTurnId(second, paused), content: 'do it' } as never,
        {
          startsTaskWork: true,
          fence: {
            ownerId: target.ownerId, actionKind: TASK_RUN_ACTION.execute, requestToken: second,
            leaseHolder: 'live-holder', attempt: 3,
          },
        },
      ).then((v) => { settled = v; return v; }, (e) => { settled = e; throw e; });
      writing.catch(() => undefined);

      const deadline = new Deadline(20_000);
      let blockedPid: number | undefined;
      while (blockedPid === undefined) {
        if (deadline.remaining() <= 0) {
          throw new Error(`${parked}: the fenced turn never waited on the receipt row (settled=${
            settled instanceof Error ? settled.message : JSON.stringify(settled)})`);
        }
        const { rows } = await observer.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [competitorPid],
        );
        blockedPid = rows[0]?.pid;
        if (blockedPid === undefined) await new Promise((resolve) => setTimeout(resolve, 2));
      }
      assert.equal(settled, undefined, `${parked}: nothing is written while it waits`);

      await competitor.query('ROLLBACK');
      try {
        await writing;
        assert.equal(
          await writer.db.conversationTurn.count({
            where: { sessionId: paused, clientTurnId: taskRunResumeTurnId(second, paused) },
          }),
          1,
          `${parked}: and exactly one turn lands when the row is free`,
        );
      } finally {
        await writer.db.$disconnect();
      }
    }
  });

test('a bulk item that fails uncertainly leaves the press retryable, then settles once it can',
  { skip, timeout: 180_000 }, async () => {
    // The rule the tally lives by, proven through the whole lifecycle rather than at one instant:
    // an item that fails for a reason which says NOTHING about the row cannot enter a frozen
    // answer, the receipt must stay unfrozen so the press can be asked again, and when the world
    // allows the work the same token must settle exactly once.
    //
    // Deterministic without a hook: the press is planned and BOUND first, and only then is the
    // workspace taken away — so the failure lands at the effect, which is the only place it says
    // nothing about the row. A pre-planning skip would be a different (and much weaker) test.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const opening = connect();
    let target: Fixture;
    const press = randomUUID();
    try {
      target = await fixture(opening.db, 'uncertain-item');
      const plan = {
        v: 1,
        kind: 'BATCH',
        batchId: null,
        maxConcurrent: null,
        skipped: [],
        runnerIds: [target.runnerId],
        items: [{
          kind: 'CREATE',
          sessionId: taskRunDesiredSessionId(taskRunRequestKey({
            taskId: target.taskId,
            requestToken: `batch:${press}:${target.taskId}`,
          })),
          taskId: target.taskId,
          title: TITLE,
          prompt: 'do it',
          workspaceId: target.agentId,
          runnerId: target.runnerId,
          provider: 'claude',
          model: null,
          runAt: null,
          clearFailed: false,
          projectId: target.projectId,
        }],
      };
      await opening.db.$executeRaw`
        INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint",
                                        "status", "target", "bound_at")
        VALUES (${target.ownerId}::uuid, ${TASK_RUN_ACTION.batchExecute}, ${press},
                ${`tasks:${target.taskId}|max:`}, 'BOUND', ${JSON.stringify(plan)}::jsonb,
                statement_timestamp())`;
      // The runner goes away AFTER the plan is frozen: the effect now fails for a reason that is
      // about the world, not about this task's row.
      await opening.db.workspace.update({
        where: { id: target.agentId }, data: { runnerId: null, enabled: false },
      });
    } finally {
      await opening.db.$disconnect();
    }

    const first = connect();
    try {
      await assert.rejects(
        () => first.tasks.batchExecute(target.ownerId, [target.taskId], undefined, press),
        (error: Error & { status?: number }) => {
          const shape = (error as unknown as { getResponse: () => Record<string, unknown> })
            .getResponse();
          assert.equal(error.status, 409);
          assert.equal(shape.code, 'TASK_RUN_REQUEST_UNSETTLED');
          assert.equal(shape.retryable, true);
          assert.ok(Number(shape.retryAfterSeconds) > 0, 'and it says when to come back');
          assert.deepEqual(shape.pendingTaskIds, [uuidToBase62(target.taskId)],
            'naming what did not settle, as a public id');
          return true;
        },
      );
      const held = await receiptRow(first.db, target, press, TASK_RUN_ACTION.batchExecute);
      assert.equal(held?.status, 'BOUND', 'nothing was frozen, and the plan is still in force');
      assert.equal(held?.result, null);
      assert.equal(await first.db.session.count({ where: { taskId: target.taskId } }), 0,
        'and nothing was started');
    } finally {
      await first.db.$disconnect();
    }

    // The world allows it again. The SAME press, on a fresh service, settles — once.
    const repair = connect();
    try {
      await repair.db.workspace.update({
        where: { id: target.agentId }, data: { runnerId: target.runnerId, enabled: true },
      });
    } finally {
      await repair.db.$disconnect();
    }

    const settling = connect();
    let answer: Awaited<ReturnType<TasksService['batchExecute']>>;
    try {
      answer = await settling.tasks.batchExecute(target.ownerId, [target.taskId], undefined, press);
      assert.equal(answer.dispatched, 1, 'the press it repeats is the press that runs');
      assert.equal(answer.results[0].sessionId, plan_sessionId(target, press));
      const done = await receiptRow(settling.db, target, press, TASK_RUN_ACTION.batchExecute);
      assert.equal(done?.status, 'COMPLETED');
      assert.equal(await settling.db.session.count({ where: { taskId: target.taskId } }), 1);
    } finally {
      await settling.db.$disconnect();
    }

    // ...and every later delivery is that same answer, byte for byte.
    const again = connect();
    try {
      assert.deepEqual(
        await again.tasks.batchExecute(target.ownerId, [target.taskId], undefined, press),
        answer,
      );
      assert.equal(await again.db.session.count({ where: { taskId: target.taskId } }), 1);
    } finally {
      await again.db.$disconnect();
    }
  });

/** The Session one press names for one task inside a bulk Run. */
function plan_sessionId(target: Fixture, press: string): string {
  return taskRunDesiredSessionId(taskRunRequestKey({
    taskId: target.taskId, requestToken: `batch:${press}:${target.taskId}`,
  }));
}

test('the claim travels from execute() all the way into the turn transaction, and is held there',
  { skip, timeout: 180_000 }, async (t) => {
    // THE HANDOFF, bitten.
    //
    // The barriers above prove the fence works when it is handed one. What they cannot prove is
    // that the PUBLIC chain hands it one: `execute` -> `applyExecuteTarget` -> `applyWorkspaceRun`
    // -> `sessions.resume` -> `createTurn`. Delete the argument anywhere along that chain and every
    // one of them still passes, because each supplies the fence itself.
    //
    // So this one supplies nothing. It enters through `execute`, blocks the turn write on something
    // ELSE — the session row — and then asks whether the receipt row is locked. It can only be
    // locked by the fence, and the fence can only be there if the claim came down the chain.
    assertCoordinatorPgUrlIsIsolated(URL!);
    const services = connect();
    const holder = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    const prober = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    const observer = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
    for (const client of [holder, prober, observer]) {
      await client.connect();
      await verifyCoordinatorPgIdentity(client);
    }
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
      .rows[0].pid;
    t.after(async () => {
      for (const client of [holder, prober]) await client.query('ROLLBACK').catch(() => undefined);
      for (const client of [holder, prober, observer]) await client.end().catch(() => undefined);
      await services.db.$disconnect();
    });

    const target = await fixture(services.db, 'fence-handoff');
    const paused = await runNow(services, target, randomUUID());
    await moveTo(services.db, paused, RunStatus.AWAITING_INPUT);
    // The turn write's SECOND lock — the session row — taken by somebody else, so the transaction
    // that writes the turn stops after its fence and before its effect.
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM "session" WHERE "id" = $1::uuid FOR UPDATE', [paused]);

    const press = randomUUID();
    const door = connect();
    let settled: unknown;
    const running = door.tasks.execute(target.ownerId, target.taskId, undefined, press)
      .then((v) => { settled = v; return v; }, (e) => { settled = e; throw e; });
    running.catch(() => undefined);

    // Wait — observably — for the door's turn transaction to be parked on the session row.
    const deadline = new Deadline(20_000);
    while (true) {
      if (deadline.remaining() <= 0) {
        throw new Error(`execute() never reached the turn write (settled=${
          settled instanceof Error ? settled.message : JSON.stringify(settled)})`);
      }
      const { rows } = await observer.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
        [holderPid],
      );
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    // THE ASSERTION. That transaction is holding the receipt row, and the only thing that takes it
    // is the fence — which only exists there if `execute` passed the claim down the whole chain.
    await prober.query('BEGIN');
    const lockedOut = await prober.query(
      `SELECT 1 FROM "task_run_request"
        WHERE "owner_id" = $1::uuid AND "action_kind" = $2 AND "request_token" = $3
        FOR UPDATE NOWAIT`,
      [target.ownerId, TASK_RUN_ACTION.execute, press],
    ).catch((e: Error & { code?: string }) => e);
    assert.ok(lockedOut instanceof Error, 'the receipt row must be held by the turn transaction');
    assert.equal((lockedOut as { code?: string }).code, '55P03',
      'and held as a lock, which is what `lock_not_available` says');
    await prober.query('ROLLBACK');
    assert.equal(settled, undefined, 'and nothing has been answered yet');

    // Released, the turn lands — once — and the press is answered with the run it woke.
    await holder.query('ROLLBACK');
    const answer = await running;
    assert.deepEqual(answer, { ok: true, sessionId: paused });
    assert.equal(
      await services.db.conversationTurn.count({
        where: { sessionId: paused, clientTurnId: taskRunResumeTurnId(press, paused) },
      }),
      1,
      'exactly one turn, under the press this door carried all the way down',
    );
    // ...and no OTHER run-request turn: the session's own opening turn is not one of these, so the
    // claim is counted by the keys only a task run writes.
    assert.equal(
      await services.db.conversationTurn.count({
        where: { sessionId: paused, clientTurnId: { startsWith: 'task-run:' } },
      }),
      1,
      'and no other run-request turn on that session',
    );
    await door.db.$disconnect();
  });
