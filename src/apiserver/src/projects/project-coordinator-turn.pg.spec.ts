import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { Prisma, ProjectAutomationPolicy, RunStatus, TaskStatus } from '@prisma/client';
import type { Client } from 'pg';
import {
  E2eServices,
  World,
  connectIsolatedPg,
  deliver,
  drainToIdle,
  emptyWorld,
  failTask,
  publicId,
  servicesOn,
  task,
  world,
} from './project-e2e-harness';
import {
  createDecisionId,
  planProjectDecision,
  publicIdempotencyKey,
} from './project-decision.service';
import { PlannedCoordinatorTurn, coordinatorTurnGeneration } from './project-turn-reason';

/**
 * Unit 27 — §7.6's turn, delivered.
 *
 * Unit 26 froze the DECISION: which reason wins, what digest it carries, and whether §7.6's three
 * preconditions let it open. It stopped one step short on purpose — the plan it produced was an
 * action nobody claimed, so a project could commit a decision that said "wake the coordinator"
 * while the coordinator was never woken. This file is that step, and it is written the way unit 22
 * is: nothing here calls the executor to make a turn happen. Every scenario commits a signal and
 * drains it, exactly as a `task.*` producer and the orchestration timer do in production; if the
 * wiring between "the loop decided a turn" and "the coordinator received a message" were missing,
 * every assertion below would fail.
 *
 * Destructive. Runs only against the disposable server `coordinator-pg-test-safety` proves.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL ? 'set COORDINATOR_PG_URL to a disposable PostgreSQL' : false;

interface TurnRow {
  id: string;
  status: string;
  reason_code: string | null;
  detail: Record<string, unknown>;
  idempotency_key: string;
}

async function turnActions(client: Client, projectId: string): Promise<TurnRow[]> {
  const result = await client.query(
    `SELECT "id", "status"::text AS status, "reason_code", "detail", "idempotency_key"
       FROM "project_action"
      WHERE "project_id" = $1 AND "type" = 'OPEN_COORDINATOR_TURN'
      ORDER BY "created_at", "id"`,
    [projectId],
  );
  return result.rows as TurnRow[];
}

/** Only the turns §7.6 opened: the lazily seeded opening prompt is not one of them. */
function openedTurns<T extends { client_turn_id: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.client_turn_id.startsWith('pc:v1:'));
}

async function turns(client: Client, sessionId: string): Promise<Array<{
  id: string; seq: number; kind: string; status: string; content: string; client_turn_id: string;
}>> {
  const result = await client.query(
    `SELECT "id", "seq", "kind", "status", "content", "client_turn_id"
       FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`,
    [sessionId],
  );
  return result.rows;
}

/**
 * A project whose coordination run is live and whose only task has settled FAILED.
 *
 * The run is opened by the loop's own `ROTATE_COORDINATOR_SESSION` rather than written here, so
 * every scenario below starts from a coordination run production could actually have produced —
 * including the fact that it has never been claimed and therefore has no turn 1 yet.
 */
async function failedProjectWithLiveCoordinator(
  services: E2eServices,
): Promise<{ target: World; taskId: string; coordinatorSessionId: string }> {
  const target = await world(services.db, 'pcc27');
  const taskId = await task(services.db, target, 'the task that failed');
  await failTask(services.db, target, taskId, 1);
  await services.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.FAILED } });
  // Pass 1 has no live coordination run, so TU7 answers NO_LIVE_RUN and §7.5's rotation goes
  // first; pass 2 finds the run it opened and is the one that may open a turn.
  await deliver(services, target.projectId, 'task.updated');
  await drainToIdle(services);
  const project = await services.db.project.findUniqueOrThrow({
    where: { id: target.projectId }, select: { coordinatorSessionId: true },
  });
  assert.ok(project.coordinatorSessionId, 'the loop must have opened a coordination run first');
  return { target, taskId, coordinatorSessionId: project.coordinatorSessionId };
}

/**
 * Persist a decision that PROPOSES this exact turn key, so the ledger's `planned` gate can be
 * reached at all (§8.3 refuses an action no decision named). It is the same thing the rig's
 * `dispatch` helper does for §7.4, and for the same reason: the scenarios below are about what the
 * LEDGER does with a key, and TR3 deliberately stops the planner from naming a spent one twice.
 */
async function planTurnAction(
  services: E2eServices,
  target: World,
  idempotencyKey: string,
): Promise<string> {
  const decisionId = createDecisionId();
  await services.db.$transaction(async (tx) => {
    const captured = await services.decisions.capture(tx, target.projectId);
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: [{
        type: 'OPEN_COORDINATOR_TURN',
        idempotencyKey: publicIdempotencyKey(idempotencyKey),
        subject: { type: 'PROJECT', id: publicId(target.projectId) },
      }],
    });
    await services.decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return decisionId;
}

/** The plan the ledger row itself records, rebuilt from it. */
function plannedFrom(target: World, action: TurnRow): PlannedCoordinatorTurn {
  return {
    reasonCode: action.reason_code as PlannedCoordinatorTurn['reasonCode'],
    reasonDigest: action.detail.reasonDigest as string,
    turnFacts: action.detail.turnFacts,
    suppressed: [],
    verdict: 'OPEN',
    idempotencyKey:
      `pc:v1:${publicId(target.projectId)}:turn:0:${action.detail.reasonDigest as string}`,
    windowEndsAt: null,
    lastTurnSessionId: null,
  };
}

test('AC1/AC3: a settled task failure commits one action, one message turn and a runnable session together', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const { target, taskId, coordinatorSessionId } = await failedProjectWithLiveCoordinator(services);

    const actions = await turnActions(client, target.projectId);
    assert.equal(actions.length, 1, 'exactly one turn action');
    const action = actions[0];
    assert.equal(action.status, 'APPLIED');
    // TR2-a's window anchor. Without it `turnWindowsOf` finds no bucket for this reasonCode and
    // TR2 silently never rate-limits anything again.
    assert.equal(action.reason_code, 'TASK_FAILURE');
    assert.match(action.idempotency_key, new RegExp(`^pc:v1:${target.projectId}:turn:0:[0-9a-f]{64}$`));
    assert.equal(action.detail.coordinatorSessionId, publicId(coordinatorSessionId));
    assert.equal(action.detail.reasonCode, 'TASK_FAILURE');
    assert.deepEqual(action.detail.turnFacts, [`${publicId(taskId)}#0`]);

    const delivered = await turns(client, coordinatorSessionId);
    assert.equal(delivered.length, 2, 'the opening prompt is seeded, then the turn is appended');
    assert.equal(delivered[0].client_turn_id, `initial-${coordinatorSessionId}`);
    const turn = delivered[1];
    // The whole point of the unit: an ordinary message, answerable and completable on its own.
    assert.equal(turn.kind, 'message');
    assert.notEqual(turn.kind, 'steer');
    assert.equal(turn.status, 'PENDING');
    assert.equal(turn.seq, 2);
    // AC3: decision → action → reason → digest, all reachable from the turn itself.
    assert.equal(turn.client_turn_id, action.idempotency_key);
    assert.equal(action.detail.conversationTurnId, turn.id);
    assert.ok(turn.content.includes('TASK_FAILURE'));
    assert.ok(turn.content.includes(action.detail.reasonDigest as string));

    // The action's own lineage column, joined back to the decision that proposed it. Exactly one
    // decision ever verdicts `OPEN` on this episode; the passes after it re-plan the same reason
    // and record it, which is what TR3 reads, so `turnReason` alone would match several rows.
    const decision = await client.query(
      `SELECT d."id", d."outcome" FROM "project_decision" d
         JOIN "project_action" a ON a."decision_id" = d."id" AND a."project_id" = d."project_id"
        WHERE a."id" = $1`,
      [action.id],
    );
    assert.equal(decision.rowCount, 1, 'the action names the decision that authorised it');
    const outcome = decision.rows[0].outcome as {
      turnReason: string; turn: { verdict: string; idempotencyKey: string; reasonDigest: string };
    };
    assert.equal(outcome.turnReason, 'TASK_FAILURE');
    assert.equal(outcome.turn.verdict, 'OPEN');
    assert.equal(outcome.turn.reasonDigest, action.detail.reasonDigest);
    assert.equal(
      outcome.turn.idempotencyKey,
      `pc:v1:${publicId(target.projectId)}:turn:0:${action.detail.reasonDigest}`,
    );

    const run = await services.db.session.findUniqueOrThrow({
      where: { id: coordinatorSessionId }, select: { status: true, lastTurnAt: true },
    });
    assert.equal(run.status, RunStatus.PENDING, 'the run is claimable, so the turn can be executed');
    assert.ok(run.lastTurnAt);

    const events = await client.query(
      `SELECT count(*)::int n FROM "project_event"
        WHERE "project_id" = $1 AND "consumed_at" IS NULL`, [target.projectId]);
    assert.equal(events.rows[0].n, 0, 'the events that caused the turn were consumed in the same commit');
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('AC1: an idle coordination run becomes claimable; a busy one keeps its slot and queues behind', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const target = await world(services.db, 'pcc27-status');
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);
    const coordinatorSessionId = (await services.db.project.findUniqueOrThrow({
      where: { id: target.projectId }, select: { coordinatorSessionId: true },
    })).coordinatorSessionId!;

    // The state a coordination run spends most of its life in: it answered, and it is waiting.
    // A turn queued onto it is worth nothing unless the run also becomes claimable again.
    await services.db.session.update({
      where: { id: coordinatorSessionId },
      data: { status: RunStatus.AWAITING_INPUT, numTurns: 1 },
    });
    const idleTask = await task(services.db, target, 'failed while the coordinator was idle');
    await failTask(services.db, target, idleTask, 1);
    await services.db.task.update({ where: { id: idleTask }, data: { status: TaskStatus.FAILED } });
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);

    assert.equal(
      (await services.db.session.findUniqueOrThrow({ where: { id: coordinatorSessionId } })).status,
      RunStatus.PENDING,
      'AWAITING_INPUT → PENDING: the run needs a fresh slot to execute the turn',
    );
    const afterIdle = await turns(client, coordinatorSessionId);
    assert.equal(afterIdle.length, 1, 'a claimed run is not re-seeded; only the turn is appended');
    assert.equal(afterIdle[0].kind, 'message');

    // A minute later, on the committed clock TR2-a reads: the rate-limit window of
    // `(generation 0, TASK_FAILURE)` is anchored on that turn's own `created_at`, so without this
    // the next scenario would be measuring TR2 rather than what it is about.
    await client.query(
      `UPDATE "project_action" SET "created_at" = "created_at" - interval '61 seconds'
        WHERE "project_id" = $1 AND "type" = 'OPEN_COORDINATOR_TURN'`, [target.projectId]);

    // Now the same run is BUSY. A message sent to a busy engine is what `SessionsService` would
    // file as a `steer` — written into the turn already running, with no reply of its own. §7.6
    // must not do that: a coordination turn has to be answerable and completable on its own.
    await services.db.session.update({
      where: { id: coordinatorSessionId }, data: { status: RunStatus.RUNNING },
    });
    await client.query(
      `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT',
              "lease_deadline_at" = now() + interval '10 minutes' WHERE "session_id" = $1`,
      [coordinatorSessionId]);
    const busyTask = await task(services.db, target, 'failed while the coordinator was busy');
    await failTask(services.db, target, busyTask, 1);
    await services.db.task.update({ where: { id: busyTask }, data: { status: TaskStatus.FAILED } });
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);

    const afterBusy = await turns(client, coordinatorSessionId);
    assert.equal(afterBusy.length, 2);
    assert.equal(afterBusy[1].kind, 'message', 'never a steer, whatever the engine is doing');
    assert.equal(afterBusy[1].status, 'PENDING', 'it waits for the running turn to finish');
    assert.equal(
      (await services.db.session.findUniqueOrThrow({ where: { id: coordinatorSessionId } })).status,
      RunStatus.RUNNING,
      'a run that already holds a slot keeps it',
    );
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('§9.2 under MANUAL: no turn, and no permanent key spent on an answer only a person can change', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    // GUARDED_AUTO first, because a rotation is `COORDINATOR_ROUTINE` too: under MANUAL this
    // project would never get a coordination run at all, and the turn would answer TU7 rather than
    // §9.2. Tightening the policy afterwards is also the real path — somebody turns automation
    // down on a project that already has a live coordinator.
    const target = await world(services.db, 'pcc27-manual-policy', {
      policy: ProjectAutomationPolicy.GUARDED_AUTO,
    });
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);
    const coordinatorSessionId = (await services.db.project.findUniqueOrThrow({
      where: { id: target.projectId }, select: { coordinatorSessionId: true },
    })).coordinatorSessionId!;
    await services.db.project.update({
      where: { id: target.projectId },
      data: { automationPolicy: ProjectAutomationPolicy.MANUAL },
    });

    const taskId = await task(services.db, target, 'the task that failed');
    await failTask(services.db, target, taskId, 1);
    await services.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.FAILED } });
    await services.projects.triggerCoordinator(target.ownerId, target.projectId);
    await drainToIdle(services);

    assert.equal((await turnActions(client, target.projectId)).length, 0,
      'the turn key is NOT spent: its epoch is the generation, which a refusal never advances, so '
      + 'a project switched to GUARDED_AUTO later must still be able to open this same episode');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 0);
    const request = await client.query(
      `SELECT "consumed_at", "attempts" FROM "project_event"
        WHERE "project_id" = $1 AND "kind" = 'user.manual_trigger'`, [target.projectId]);
    assert.equal(request.rowCount, 1);
    assert.equal(request.rows[0].consumed_at, null,
      'TR2-c: an unanswered request is kept, never consumed');
    assert.equal(request.rows[0].attempts, 0);

    // The person acts: automation is turned back up. The SAME episode must still be openable.
    await services.db.project.update({
      where: { id: target.projectId },
      data: { automationPolicy: ProjectAutomationPolicy.GUARDED_AUTO },
    });
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);
    const opened = await turnActions(client, target.projectId);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].status, 'APPLIED');
    assert.equal(opened[0].reason_code, 'MANUAL', 'TU4: the person\'s request still outranks the failure');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 1);
    const answered = await client.query(
      `SELECT "consumed_at" FROM "project_event"
        WHERE "project_id" = $1 AND "kind" = 'user.manual_trigger'`, [target.projectId]);
    assert.ok(answered.rows[0].consumed_at, 'and only now is the request consumed');
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('AC2: repeated, out-of-order and post-restart deliveries of the same episode open one turn', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const { target, coordinatorSessionId } = await failedProjectWithLiveCoordinator(services);
    const first = await turnActions(client, target.projectId);
    assert.equal(first.length, 1);

    // The same world, seen again through four more deliveries — including one whose dedupe key
    // sorts before the one that already ran, which is what "out of order" means to the outbox.
    for (const kind of ['task.updated', 'session.ended', 'task.updated', 'aaa.replayed']) {
      await deliver(services, target.projectId, kind, `pcc27:${kind}:${randomUUID()}`);
    }
    await drainToIdle(services);

    // A whole second orchestration instance, with its own connection and its own registrations —
    // a restart, and a concurrent takeover, at the same time.
    const takeover = servicesOn(URL!);
    try {
      await deliver(takeover, target.projectId, 'task.updated', `pcc27:takeover:${randomUUID()}`);
      await drainToIdle(takeover);
    } finally {
      await takeover.dispose();
    }

    assert.deepEqual(
      (await turnActions(client, target.projectId)).map((row) => row.idempotency_key),
      [first[0].idempotency_key],
      'TR1/TR3 keep one episode to one turn across replay, reorder and restart',
    );
    const delivered = await turns(client, coordinatorSessionId);
    assert.equal(delivered.filter((row) => row.client_turn_id === first[0].idempotency_key).length, 1);
    assert.equal(delivered.length, 2);
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('AC2: a second claim of the same key is ALREADY_APPLIED and writes no second message', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const { target, coordinatorSessionId } = await failedProjectWithLiveCoordinator(services);
    const [action] = await turnActions(client, target.projectId);

    // The out-of-loop door, driven with the key the loop already spent: a recovery probe, or a
    // takeover that re-planned the same turn from the same facts. TR3 refuses to PLAN this one
    // again, which is the point — the question here is whether the LEDGER holds when the planner
    // is bypassed, so the replay is rebuilt from what the ledger itself recorded.
    const lease = await services.reconciler.acquireLease(target.projectId);
    assert.ok(lease);
    assert.equal(coordinatorTurnGeneration(action.idempotency_key), '0');
    const replay = await services.coordinatorTurns.open(lease, {
      decisionId: await planTurnAction(services, target, action.idempotency_key),
      planned: plannedFrom(target, action),
    });
    assert.equal(replay.action.status, 'ALREADY_APPLIED');
    assert.equal(replay.turnId, action.detail.conversationTurnId,
      'the replay names the turn that already answered this episode, and opens no other');

    assert.equal((await turnActions(client, target.projectId)).length, 1);
    assert.equal((await turns(client, coordinatorSessionId)).length, 2);
    assert.equal((await turnActions(client, target.projectId))[0].id, action.id);
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('AC4: a post-commit notification that throws leaves the turn durable and executable', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const target = await world(services.db, 'pcc27-notify');
    const taskId = await task(services.db, target, 'the task that failed');
    await failTask(services.db, target, taskId, 1);
    await services.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.FAILED } });
    // Every announcement this loop makes now fails, which is the whole scenario: §8.3 says a
    // notification is an accelerator, so losing one may cost latency and nothing else.
    let announcements = 0;
    services.coordinatorTurns.announce = () => {
      announcements += 1;
      throw new Error('pcc27 injected notification failure');
    };
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);

    const [action] = await turnActions(client, target.projectId);
    assert.equal(action.status, 'APPLIED', 'the commit is unaffected by what happens after it');
    assert.ok(announcements > 0, 'the failing notification really was attempted');
    const coordinatorSessionId = (await services.db.project.findUniqueOrThrow({
      where: { id: target.projectId }, select: { coordinatorSessionId: true },
    })).coordinatorSessionId!;
    const delivered = await turns(client, coordinatorSessionId);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].status, 'PENDING');

    // What the runner's own poll would find without ever having been told: a PENDING run on this
    // runner, carrying an executable PENDING turn.
    const claimable = await client.query(
      `SELECT count(*)::int n FROM "session" s
        WHERE s."id" = $1 AND s."status" = 'PENDING' AND s."assigned_runner_id" = $2
          AND EXISTS (SELECT 1 FROM "conversation_turn" t
                       WHERE t."session_id" = s."id" AND t."status" = 'PENDING'
                         AND t."kind" = 'message')`,
      [coordinatorSessionId, target.runnerId],
    );
    assert.equal(claimable.rows[0].n, 1, 'the durable turn is recoverable with no notification at all');
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('a world that moved under a planned turn is a STALE_SNAPSHOT audit row, never a message', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const { target, coordinatorSessionId } = await failedProjectWithLiveCoordinator(services);
    const [applied] = await turnActions(client, target.projectId);

    const lease = await services.reconciler.acquireLease(target.projectId);
    assert.ok(lease);
    // A DIFFERENT episode's key, so this is about the commit point and not about TR1 answering.
    const key = `pc:v1:${target.projectId}:turn:0:${'f'.repeat(64)}`;
    const decisionId = await planTurnAction(services, target, key);

    // The run ends AFTER the snapshot this plan was taken on. §7.7's gate re-captures the world
    // inside the ledger's transaction, and the coordination run's `runStatus` is in that hash — so
    // this is refused before the effect is ever reached.
    await services.db.session.update({
      where: { id: coordinatorSessionId },
      data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
    });
    const refused = await services.coordinatorTurns.open(lease, {
      decisionId,
      planned: {
        ...plannedFrom(target, applied),
        reasonDigest: 'f'.repeat(64),
        idempotencyKey: `pc:v1:${publicId(target.projectId)}:turn:0:${'f'.repeat(64)}`,
      },
    });
    assert.equal(refused.action.status, 'REFUSED');
    assert.equal((refused.action as { refusalCode?: string }).refusalCode, 'STALE_SNAPSHOT');
    assert.equal(refused.turnId, null);
    assert.equal(
      (await turns(client, coordinatorSessionId)).filter((row) => row.seq > 2).length, 0,
      'a refusal writes an audit row and no message',
    );
    const rows = await turnActions(client, target.projectId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, applied.id, 'the applied turn is untouched');
  } finally {
    await services.dispose();
    await client.end();
  }
});

test('TU7 at the commit point: an ended coordination run is a typed refusal with no message', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const { target, coordinatorSessionId } = await failedProjectWithLiveCoordinator(services);
    const [applied] = await turnActions(client, target.projectId);
    const lease = await services.reconciler.acquireLease(target.projectId);
    assert.ok(lease);
    const key = `pc:v1:${target.projectId}:turn:0:${'e'.repeat(64)}`;
    const decisionId = await planTurnAction(services, target, key);
    await services.db.session.update({
      where: { id: coordinatorSessionId },
      data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
    });

    // The effect's OWN guard, asked directly. §7.7's staleness gate normally answers first — the
    // scenario above proves it does — which is exactly why this one is worth asking separately:
    // the gate compares a hash taken before the row lock, so the window it cannot see is the one
    // between that re-capture and `FOR UPDATE`, and TU7 has to hold there too.
    const verdict = await services.db.$transaction(async (tx) => services.coordinatorTurns
      .openInTransaction(tx, lease, {
        decisionId,
        planned: {
          ...plannedFrom(target, applied),
          reasonDigest: 'e'.repeat(64),
          idempotencyKey: `pc:v1:${publicId(target.projectId)}:turn:0:${'e'.repeat(64)}`,
        },
      }, randomUUID(), new Date()));
    assert.ok(verdict, 'an ended run must refuse rather than deliver');
    assert.equal(verdict.status, 'REFUSED');
    assert.equal(verdict.reasonCode, 'COORDINATOR_SESSION_NOT_LIVE');
    assert.equal(
      (verdict.detail as { turnFailure: { retryable: boolean } }).turnFailure.retryable, true,
      'a rotation can give this project somewhere to land, so the reason is not terminal',
    );
    assert.equal((await turns(client, coordinatorSessionId)).length, 2, 'no message was written');
  } finally {
    await services.dispose();
    await client.end();
  }
});

/**
 * A child process that runs ONE real delivery and then stops dead, on the side of the commit the
 * caller names.
 *
 * The pass is the production one — the child wraps `ProjectReconcileService` rather than replacing
 * it, and the only thing it adds is where the process stops. `BEFORE_COMMIT` hangs inside the
 * delivery transaction, so `SIGKILL` there is PostgreSQL rolling the whole pass back, turn
 * included; `AFTER_COMMIT` hangs in `afterCommit`, which §8.3 defines as post-commit, so the same
 * `SIGKILL` proves the other half — what committed stayed, and the announcement it never made cost
 * nothing but latency. Borrowed verbatim in shape from unit 22's recovery suite.
 */
function spawnCrashingPass(mode: 'BEFORE_COMMIT' | 'AFTER_COMMIT'): ChildProcessWithoutNullStreams {
  const script = String.raw`
    const { servicesOn } = require('./build/projects/project-e2e-harness.js');
    (async () => {
      const services = servicesOn(process.env.PCC_CHILD_URL, { registerHandler: false });
      const reconciler = services.reconciler;
      services.events.registerHandler({
        handle: async (tx, id, events) => {
          const result = await reconciler.handle(tx, id, events);
          if (process.env.PCC_CHILD_MODE === 'BEFORE_COMMIT') {
            process.stdout.write('PASS_UNCOMMITTED\n');
            await new Promise(() => {});
          }
          return result;
        },
        deadLetter: (tx, id, events, error) => reconciler.deadLetter(tx, id, events, error),
        afterCommit: async (result) => {
          await reconciler.afterCommit(result);
          process.stdout.write('PASS_COMMITTED\n');
          await new Promise(() => {});
        },
      });
      await services.events.drainOnce();
      process.stdout.write('DRAIN_RETURNED\n');
      setInterval(() => {}, 1000);
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  return spawn(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, PCC_CHILD_URL: URL!, PCC_CHILD_MODE: mode },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Wait for a marker the child prints, or fail loudly rather than hanging the suite. */
async function waitForMarker(
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeoutMs = 60_000,
): Promise<void> {
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`child never printed ${marker}; stderr=${stderr}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited (${code}) before ${marker}; stderr=${stderr}`));
    });
  });
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
}

/** A project with a live coordination run and one settled failure that nothing has answered yet. */
async function armedFailure(
  services: E2eServices,
  label: string,
): Promise<{ target: World; coordinatorSessionId: string }> {
  const target = await world(services.db, label);
  await deliver(services, target.projectId, 'task.updated');
  await drainToIdle(services);
  const coordinatorSessionId = (await services.db.project.findUniqueOrThrow({
    where: { id: target.projectId }, select: { coordinatorSessionId: true },
  })).coordinatorSessionId!;
  const taskId = await task(services.db, target, 'the task that failed');
  await failTask(services.db, target, taskId, 1);
  await services.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.FAILED } });
  return { target, coordinatorSessionId };
}

test('AC2/AC5: a SIGKILL before the commit rolls the turn back; the takeover opens exactly one', {
  skip, timeout: 300_000,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await emptyWorld(client);
    const { target, coordinatorSessionId } = await armedFailure(services, 'pcc27-kill-before');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 0);
    await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
      projectId: target.projectId,
      kind: 'task.updated',
      source: { type: 'TASK', id: target.projectId },
      dedupeKey: 'pcc27:kill-before',
    });

    child = spawnCrashingPass('BEFORE_COMMIT');
    await waitForMarker(child, 'PASS_UNCOMMITTED');
    await kill(child);
    child = undefined;

    assert.equal((await turnActions(client, target.projectId)).length, 0,
      'PostgreSQL rolls the ledger key and the message back together');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 0);
    const pending = await services.db.projectEvent.findFirstOrThrow({
      where: { projectId: target.projectId, dedupeKey: 'pcc27:kill-before' } });
    assert.equal(pending.consumedAt, null, 'the signal is still there to be redone');

    await drainToIdle(services);
    const actions = await turnActions(client, target.projectId);
    assert.equal(actions.length, 1, 'the takeover redoes it, exactly once');
    assert.equal(actions[0].status, 'APPLIED');
    const delivered = openedTurns(await turns(client, coordinatorSessionId));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].client_turn_id, actions[0].idempotency_key);
    assert.equal(delivered[0].kind, 'message');
  } finally {
    if (child) await kill(child).catch(() => undefined);
    await services.dispose();
    await client.end();
  }
});

test('AC2/AC5: a SIGKILL after the commit keeps the turn, and the survivor does not repeat it', {
  skip, timeout: 300_000,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await emptyWorld(client);
    const { target, coordinatorSessionId } = await armedFailure(services, 'pcc27-kill-after');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 0);
    await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
      projectId: target.projectId,
      kind: 'task.updated',
      source: { type: 'TASK', id: target.projectId },
      dedupeKey: 'pcc27:kill-after',
    });

    child = spawnCrashingPass('AFTER_COMMIT');
    await waitForMarker(child, 'PASS_COMMITTED');
    await kill(child);
    child = undefined;

    const committed = await turnActions(client, target.projectId);
    assert.equal(committed.length, 1, 'what committed, committed');
    assert.equal(committed[0].status, 'APPLIED');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 1);
    const consumed = await services.db.projectEvent.findFirstOrThrow({
      where: { projectId: target.projectId, dedupeKey: 'pcc27:kill-after' } });
    assert.ok(consumed.consumedAt);

    await drainToIdle(services);
    assert.deepEqual(
      (await turnActions(client, target.projectId)).map((row) => row.idempotency_key),
      [committed[0].idempotency_key],
      'a process that died holding the notification cost latency, not a second turn',
    );
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 1);
  } finally {
    if (child) await kill(child).catch(() => undefined);
    await services.dispose();
    await client.end();
  }
});

test('TR2-c: a manual trigger held behind the rate-limit window stays unconsumed and keeps its attempts', {
  skip,
}, async () => {
  const client = await connectIsolatedPg(URL);
  const services = servicesOn(URL!);
  try {
    await emptyWorld(client);
    const target = await world(services.db, 'pcc27-manual');
    // A live coordination run, opened by §7.5 exactly as the other scenarios get one.
    await deliver(services, target.projectId, 'task.updated');
    await drainToIdle(services);
    const coordinatorSessionId = (await services.db.project.findUniqueOrThrow({
      where: { id: target.projectId }, select: { coordinatorSessionId: true },
    })).coordinatorSessionId!;

    await services.projects.triggerCoordinator(target.ownerId, target.projectId);
    await drainToIdle(services);
    const opened = await turnActions(client, target.projectId);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].reason_code, 'MANUAL');
    const answered = await client.query(
      `SELECT "consumed_at" FROM "project_event"
        WHERE "project_id" = $1 AND "kind" = 'user.manual_trigger'`, [target.projectId]);
    assert.equal(answered.rowCount, 1);
    assert.ok(answered.rows[0].consumed_at, 'the request that was answered is consumed');

    // A second, DIFFERENT request inside the same 60s window. TR2 rate-limits per reasonCode, so
    // this one may not open a turn — and TR2-c says it must not be consumed either.
    await services.projects.triggerCoordinator(target.ownerId, target.projectId);
    await drainToIdle(services);
    assert.equal((await turnActions(client, target.projectId)).length, 1, 'TR2 held the second turn');

    const held = await client.query(
      `SELECT "consumed_at", "attempts", "next_attempt_at" FROM "project_event"
        WHERE "project_id" = $1 AND "kind" = 'user.manual_trigger' AND "consumed_at" IS NULL`,
      [target.projectId]);
    assert.equal(held.rowCount, 1, 'the rate-limited request is still pending, not deleted');
    assert.equal(held.rows[0].attempts, 0, 'a rate limit is not a failed delivery');
    const anchor = await client.query(
      `SELECT "created_at" FROM "project_action" WHERE "id" = $1`, [opened[0].id]);
    assert.equal(
      (held.rows[0].next_attempt_at as Date).getTime(),
      (anchor.rows[0].created_at as Date).getTime() + 60_000,
      'TR2-b ③: it is pointed at the window boundary, which is a committed fact',
    );
    const runtime = await client.query(
      `SELECT "next_wake_at" FROM "project_runtime" WHERE "project_id" = $1`, [target.projectId]);
    assert.ok(
      (runtime.rows[0].next_wake_at as Date).getTime()
        <= (held.rows[0].next_attempt_at as Date).getTime() + 5_000,
      'TR2-d: the project wakes no later than the window boundary plus W3s floor',
    );
    assert.equal((await turns(client, coordinatorSessionId)).length, 2);

    // TR2-d: the window passes and the SAME held request is answered — by a delivery carrying some
    // unrelated event, which is the whole point. TF5 says one turn answers every request
    // outstanding at the time, so consuming only the batch that happened to arrive would leave
    // this one pending forever on a key the ledger has already spent.
    await client.query(
      `UPDATE "project_action" SET "created_at" = "created_at" - interval '61 seconds'
        WHERE "project_id" = $1 AND "type" = 'OPEN_COORDINATOR_TURN'`, [target.projectId]);
    await client.query(
      `UPDATE "project_event" SET "next_attempt_at" = NULL
        WHERE "project_id" = $1 AND "consumed_at" IS NULL`, [target.projectId]);
    await deliver(services, target.projectId, 'task.updated', `pcc27:unrelated:${randomUUID()}`);
    await drainToIdle(services);

    const second = await turnActions(client, target.projectId);
    assert.equal(second.length, 2, 'the window passed, so the held request finally gets its turn');
    assert.equal(second[1].reason_code, 'MANUAL');
    assert.notEqual(second[1].idempotency_key, second[0].idempotency_key,
      'a different pending set is a different digest, so it is a different key');
    const settled = await client.query(
      `SELECT count(*)::int n FROM "project_event"
        WHERE "project_id" = $1 AND "kind" = 'user.manual_trigger' AND "consumed_at" IS NULL`,
      [target.projectId]);
    assert.equal(settled.rows[0].n, 0, 'answered, and only now consumed');
    assert.equal(openedTurns(await turns(client, coordinatorSessionId)).length, 2);
  } finally {
    await services.dispose();
    await client.end();
  }
});
