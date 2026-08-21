import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  Prisma,
  ProjectAutomationPolicy,
  RunStatus,
  RunnerStatus,
} from '@prisma/client';
import type { Client } from 'pg';
import {
  E2eServices,
  World,
  connectIsolatedPg,
  deliver,
  dispatch,
  drainToIdle,
  emptyWorld,
  servicesOn,
  publicId,
  session,
  task,
  world,
} from './project-e2e-harness';
import { PROJECT_RUNNER_OFFLINE_AFTER_MS } from './project-availability-reaper.service';

/**
 * Unit 22 — delivery reliability, the liveness SLO, and recovery, for project criteria 2, 3 and 9.
 *
 * Its sibling `project-e2e-acceptance.pg.spec.ts` walks what the loop DOES. This one breaks things
 * while it is doing them: duplicate and out-of-order signals, a delivery that throws, a real
 * `SIGKILL` on either side of the commit, a real PostgreSQL stop/start, a second service instance
 * taking a project over, a runner going offline, and a binary that does not know the loop exists.
 *
 * Every scenario ends by proving the SAME property, which is the one AC3 states: whatever was
 * injected, the project converged to executing, awaiting verification, a named blocker, waiting on
 * a person, or a state with a clock — never to silence. `scripts/project-liveness-audit.sql` is
 * that sentence as a query, and it is run here against the world each scenario leaves behind.
 *
 * Destructive, and it kills processes and stops a container: it runs only against the disposable
 * server `coordinator-pg-test-safety` proves, and only with `COORDINATOR_PG_CONTAINER` naming a
 * container this suite may restart.
 */

const URL = process.env.COORDINATOR_PG_URL;
const CONTAINER = process.env.COORDINATOR_PG_CONTAINER;
const skip = !URL;
const run = promisify(execFile);

const LIVENESS_SQL = readFileSync(
  path.resolve(__dirname, '../../../../scripts/project-liveness-audit.sql'), 'utf8');

interface LivenessViolation {
  project_id: string;
  title: string;
  run_state: string;
  clause_a_live_session: boolean;
  clause_b_turn_in_flight: boolean;
  clause_c_actionable_blocker: boolean;
  clause_d_future_wake: boolean;
}

/** §10.3 as a query, run exactly as an operator would run it on a snapshot. */
async function livenessViolations(client: Client): Promise<LivenessViolation[]> {
  const result = await client.query<LivenessViolation>(LIVENESS_SQL);
  return result.rows;
}

async function runtimeRow(services: E2eServices, projectId: string) {
  return services.db.projectRuntime.findUniqueOrThrow({ where: { projectId } });
}

/** One pass, then rest — the shape "and then the loop ran normally" takes everywhere here. */
async function settle(services: E2eServices, projectId: string): Promise<void> {
  await deliver(services, projectId);
  await drainToIdle(services);
}

/** A signal §5.4 can never deliver, driven through the real consumer until it is DEAD. */
async function killABatch(projectId: string, dedupeKey: string): Promise<string> {
  const failing = servicesOn(URL!, { registerHandler: false });
  failing.events.registerHandler({
    handle: async () => { throw new Error('pcc22 permanent delivery failure'); },
    deadLetter: (tx, id, events, error) => failing.reconciler.deadLetter(tx, id, events, error),
  });
  try {
    await failing.events.enqueue(failing.db as unknown as Prisma.TransactionClient, {
      projectId, kind: 'task.updated', source: { type: 'TASK', id: projectId }, dedupeKey });
    let last = await failing.events.drainOnce();
    for (let attempt = 0; attempt < 12 && last.status !== 'DEAD'; attempt += 1) {
      await failing.db.projectEvent.updateMany({
        where: { projectId, dedupeKey },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
      last = await failing.events.drainOnce();
    }
    assert.equal(last.status, 'DEAD', 'AC2: a batch that cannot be delivered ends, loudly');
    return last.eventIds[0];
  } finally {
    await failing.dispose();
  }
}

/**
 * A child process that runs ONE real delivery and then stops dead, on the side of the commit the
 * caller names.
 *
 * The pass itself is the production one — the child registers a handler that delegates every
 * callback to `ProjectReconcileService` and only adds the hang. `BEFORE_COMMIT` hangs inside the
 * delivery transaction, so a `SIGKILL` there is PostgreSQL rolling the whole pass back;
 * `AFTER_COMMIT` hangs in `afterCommit`, which the contract defines as post-commit, so the same
 * `SIGKILL` proves the opposite half — everything stayed.
 */
function spawnCrashingPass(
  mode: 'BEFORE_COMMIT' | 'AFTER_COMMIT',
  projectId: string,
): ChildProcessWithoutNullStreams {
  const script = String.raw`
    const { servicesOn } = require('./build/projects/project-e2e-harness.js');
    (async () => {
      const services = servicesOn(process.env.PCC_CHILD_URL, { registerHandler: false, registerDispatchPass: false });
      const reconciler = services.reconciler;
      // The production handler, wrapped rather than replaced: the pass runs in full and the only
      // thing added is where the process stops.
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
    env: { ...process.env, PCC_CHILD_URL: URL!, PCC_CHILD_MODE: mode, PCC_CHILD_PROJECT: projectId },
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

/** Idempotent: 'exit' fires once, so a second `await once(child, 'exit')` would wait forever. */
async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('unit 22: the project control loop under injected faults', { skip, timeout: 900_000 },
  async (t) => {
    let identity = await connectIsolatedPg(URL);
    // Every scenario below drives dispatch itself — by hand, at a chosen attempt number, and often
    // against a world it has just broken on purpose — and several count the passes and decisions a
    // single delivery produces. §7.8's pass would add a second dispatcher to that, so it is left
    // out here and proved in `project-dispatch-pass.pg.spec.ts` instead, on the same rig. The rest
    // of the production graph is wired exactly as `ProjectsModule` wires it.
    const services = servicesOn(URL!, { registerDispatchPass: false });

    const scenario = async (name: string, body: () => Promise<void>): Promise<void> => {
      await t.test(name, async () => {
        await emptyWorld(identity);
        await body();
        // Every scenario in this file ends the same way, and this is AC3 stated once: whatever was
        // injected, no project may be left silently idle.
        const violations = await livenessViolations(identity);
        assert.deepEqual(violations, [],
          `AC3: the injected fault left a silently idle project: ${JSON.stringify(violations)}`);
      });
    };

    try {
      // --------------------------------------------------------------------------------------
      // AC2 — the outbox: duplicates, order, failure, dead letters.
      // --------------------------------------------------------------------------------------

      await scenario('AC2: a duplicate signal is one row and one pass', async () => {
        const target = await world(services.db, 'ac2-dupe');
        await task(services.db, target, 'work');
        await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

        const dedupeKey = 'user.manual_trigger:pcc22';
        for (let i = 0; i < 3; i += 1) {
          await services.events.enqueue(
            services.db as unknown as Prisma.TransactionClient,
            { projectId: target.projectId, kind: 'user.manual_trigger',
              source: { type: 'USER', id: target.ownerId }, dedupeKey });
        }
        const pending = await services.db.projectEvent.findMany({
          where: { projectId: target.projectId, consumedAt: null } });
        assert.equal(pending.length, 1, 'AC2/§5.4: three deliveries of one signal are one row');
        assert.equal(pending[0].occurrences, 3, 'and the repeats are counted rather than dropped');

        const before = await services.db.projectDecision.count({
          where: { projectId: target.projectId } });
        const drained = await services.events.drainOnce();
        assert.equal(drained.status, 'CONSUMED');
        assert.equal(await services.db.projectDecision.count({
          where: { projectId: target.projectId } }), before + 1,
          'AC2: one coalesced signal is one pass, not three');
      });

      await scenario('AC2: an out-of-order signal does not resurrect an older world', async () => {
        const target = await world(services.db, 'ac2-order', { policy: ProjectAutomationPolicy.AUTO });
        const work = await task(services.db, target, 'work');
        await drainToIdle(services);

        // Newest first, then an OLDER one under the same key — the shape a redelivery takes when
        // two producers race. §5.1: an event is a signal, so the pass must read the world, not the
        // payload, and the row must keep the newest envelope.
        const dedupeKey = 'task.updated:out-of-order';
        const newest = new Date();
        const older = new Date(newest.getTime() - 60_000);
        await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
          projectId: target.projectId, kind: 'task.updated',
          source: { type: 'TASK', id: work }, dedupeKey, occurredAt: newest,
          payload: { status: 'newest' },
        });
        await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
          projectId: target.projectId, kind: 'task.updated',
          source: { type: 'TASK', id: work }, dedupeKey, occurredAt: older,
          payload: { status: 'stale' },
        });
        const [row] = await services.db.projectEvent.findMany({
          where: { projectId: target.projectId, dedupeKey, consumedAt: null } });
        assert.ok(row);
        assert.equal((row.payload as { status?: string }).status, 'newest',
          'AC2: a late arrival must not overwrite the newest envelope');
        assert.equal(row.lastAt.getTime() >= newest.getTime(), true);

        // The pass that consumes it reads the CURRENT task, which was deleted after both signals
        // were written. A pass that trusted the payload would still be reconciling a task that no
        // longer exists.
        await services.db.task.delete({ where: { id: work } });
        assert.equal((await services.events.drainOnce()).status, 'CONSUMED');
        const decision = await services.db.projectDecision.findFirstOrThrow({
          where: { projectId: target.projectId }, orderBy: { createdAt: 'desc' } });
        const input = decision.decisionInput as { world: { tasks: unknown[] } };
        assert.deepEqual(input.world.tasks, [],
          'AC2/§5.1: the decision is made from current facts, not from the signal');
      });

      await scenario('AC2: a delivery that throws retries with backoff and consumes nothing',
        async () => {
          const target = await world(services.db, 'ac2-retry');
          await task(services.db, target, 'work');
          await drainToIdle(services);
          await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

          const failing = servicesOn(URL!, { registerHandler: false });
          let attempts = 0;
          failing.events.registerHandler({
            handle: async () => { attempts += 1; throw new Error('pcc22 injected delivery failure'); },
            deadLetter: async () => undefined,
          });
          try {
            await failing.events.enqueue(failing.db as unknown as Prisma.TransactionClient, {
              projectId: target.projectId, kind: 'task.updated',
              source: { type: 'TASK', id: target.projectId }, dedupeKey: 'ac2-retry' });
            const result = await failing.events.drainOnce();
            assert.equal(result.status, 'RETRY_SCHEDULED', 'AC2: a failure is a retry, not a loss');
            assert.equal(attempts, 1);
            const row = await failing.db.projectEvent.findFirstOrThrow({
              where: { projectId: target.projectId, dedupeKey: 'ac2-retry' } });
            assert.equal(row.consumedAt, null, 'AC2: nothing is consumed by a failed delivery');
            assert.equal(row.attempts, 1);
            assert.ok(row.nextAttemptAt, 'AC2: and the retry has a definite instant');
            assert.ok(row.nextAttemptAt!.getTime() > Date.now(), 'in the future');

            // Not before then: a drain that ignored the backoff would be the busy loop §10.2 W1
            // exists to forbid.
            assert.equal((await failing.events.drainOnce()).status, 'IDLE');
            assert.equal(attempts, 1, 'AC2: the backoff is honoured');
          } finally {
            await failing.dispose();
          }

          // The healthy service then recovers it — the failure was the handler, not the row.
          await services.db.projectEvent.updateMany({
            where: { projectId: target.projectId, dedupeKey: 'ac2-retry' },
            data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
          assert.equal((await services.events.drainOnce()).status, 'CONSUMED');
        });

      await scenario('AC2: a batch that never succeeds dead-letters into a named blocker',
        async () => {
          const target = await world(services.db, 'ac2-dead', { policy: ProjectAutomationPolicy.AUTO });
          const work = await task(services.db, target, 'work');
          await drainToIdle(services);
          await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

          // A production dedupe key, uuid and all (§5.3 N3), because the blocker `detail` this
          // ends up in is asserted by AC1 to name rows in the spelling a person can paste.
          const deadKey = `task.updated:${target.projectId}`;
          const eventId = await killABatch(target.projectId, deadKey);

          const dead = await services.db.projectEvent.findFirstOrThrow({
            where: { projectId: target.projectId, dedupeKey: deadKey } });
          assert.equal(dead.disposition, 'DEAD', 'AC2: the batch ends in a recorded terminal state');
          assert.equal(dead.attempts, 10, '§5.4: after the tenth attempt, not silently before it');

          // §5.4 F22 / §11.2 BL2: what a permanently discarded signal costs is not recoverable, so
          // the same transaction that discards it has to leave a row somebody can act on.
          const open = await services.db.projectBlocker.findMany({
            where: { projectId: target.projectId, resolvedAt: null } });
          assert.equal(open.length, 1, 'F22: a dead letter opens exactly one blocker');
          const blocker = open[0];
          assert.equal(blocker.kind, 'UNKNOWN_FAILURE');
          assert.equal(blocker.subjectType, 'PROJECT',
            'F22: a lost signal is not a fact about one task — it stops the project');
          assert.equal(blocker.subjectId, target.projectId);
          assert.equal(blocker.dedupeKey, `UNKNOWN_FAILURE:PROJECT:${target.projectId}`);
          assert.equal(blocker.lifecycleGeneration, 1n);
          assert.equal(blocker.occurrences, 1);
          // §11.1's five questions, all five present — which is also what §10.3 clause (c) reads.
          assert.equal(blocker.owner, 'USER');
          assert.equal(blocker.recovery, 'HUMAN');
          assert.equal(blocker.severity, 'CRITICAL');
          assert.ok(blocker.requiredAction.length > 0);
          assert.equal(blocker.nextCheckAt.getTime(),
            blocker.firstSeenAt.getTime() + 30 * 60_000,
            'BL5: a HUMAN row\'s clock is its escalation alarm');
          assert.equal(blocker.escalatedAt, null, 'a row cannot escalate in the pass that opened it');
          assert.deepEqual(
            (blocker.detail as { deadEvents?: Array<{ eventId: string; dedupeKey: string }> })
              .deadEvents,
            [{
              eventId: publicId(eventId),
              kind: 'task.updated',
              dedupeKey: `task.updated:${publicId(target.projectId)}`,
              attempts: 10,
            }],
            'AC1/§8.2: it names the signal that was lost, in the spelling a person can paste',
          );

          // §11.3 BE3: the raise key and the row are one-to-one, so the ledger says which action
          // opened it. There was no decision to cite — this pass never captured a snapshot — and
          // migration 0120 left the column nullable for exactly that.
          const raise = await services.db.projectAction.findFirstOrThrow({
            where: { projectId: target.projectId, type: 'RAISE_BLOCKER' } });
          assert.equal(raise.idempotencyKey,
            `pc:v1:${target.projectId}:blocker:UNKNOWN_FAILURE:${target.projectId}:1`);
          assert.equal(raise.status, 'APPLIED');
          assert.equal(raise.decisionId, null);
          assert.match((raise.detail as { lastError?: string }).lastError ?? '',
            /pcc22 permanent delivery failure/,
            'the exception text lands in the append-only ledger, not in a column §11.3 rewrites');

          // §4.2 guard 2: an open USER blocker IS `AWAITING_HUMAN`, and TS4 makes persisting any
          // other value an illegal transition. The clock stays: it is the recompute this path
          // schedules, and it is earlier than the escalation alarm, so nothing is missed.
          const state = await runtimeRow(services, target.projectId);
          assert.equal(state.runState, 'AWAITING_HUMAN');
          assert.ok(state.nextWakeAt && state.nextWakeAt.getTime() > Date.now(),
            'AC3: a dead-lettered batch still leaves a clock');
          assert.match(state.nextWakeReason ?? '', /dead letter/i,
            'AC2: and the reason a reader sees names the dead letter');

          // AC10: it is on the face the control plane serves, not only in a table.
          const served = await services.projects.blockers(target.ownerId, target.projectId);
          assert.equal(served.blockers.length, 1);
          assert.equal(served.blockers[0].kind, 'UNKNOWN_FAILURE');
          assert.equal(served.blockers[0].raisedByActionId, raise.id,
            'AC10: and "which action opened this" is answered rather than inferred');

          // The point of all of it: automatic dispatch STOPS. Asserted through the production
          // authorization path, not by reading the blocker table a second time.
          const refused = await dispatch(services, target, work);
          assert.equal(refused.status, 'REFUSED');
          assert.equal(refused.refusalCode, 'PROJECT_BLOCKED',
            'F22: an event discarded for good must not be followed by an automatic dispatch');
          assert.equal(await services.db.session.count({ where: { taskId: work } }), 0);

          // And it stays stopped. §11.4 clears whatever it no longer observes, so a healthy pass
          // right afterwards is the moment this could silently recover — the recomputation has to
          // keep seeing the unacknowledged dead letter instead.
          await settle(services, target.projectId);
          const after = await services.db.projectBlocker.findMany({
            where: { projectId: target.projectId, resolvedAt: null } });
          assert.equal(after.length, 1, 'F22: a healthy pass does not clear it on the project\'s behalf');
          assert.equal(after[0].id, blocker.id, 'and it is the same episode, not a fresh one');
          assert.equal(after[0].lifecycleGeneration, 1n);
          assert.ok(after[0].occurrences > blocker.occurrences,
            '§11.3: the recomputation touches it — two display columns and nothing else');
          // …and the pass that recomputed it agrees about the state, so the `AWAITING_HUMAN` the
          // dead letter wrote is what §4.2's guards produce and not a value only this path holds.
          assert.equal((await runtimeRow(services, target.projectId)).runState, 'AWAITING_HUMAN');
          const stillRefused = await dispatch(services, target, work, 2);
          assert.equal(stillRefused.refusalCode, 'PROJECT_BLOCKED');

          // …until somebody deals with it. That is the whole of `recovery = HUMAN`: the condition
          // stops being carried once a person resolves the row, and only then does the loop move.
          await services.db.projectBlocker.update({
            where: { id: blocker.id },
            data: { resolvedAt: new Date(), resolvedBy: 'USER' },
          });
          await settle(services, target.projectId);
          assert.deepEqual(await services.db.projectBlocker.findMany({
            where: { projectId: target.projectId, resolvedAt: null } }), [],
            'F22: an acknowledged dead letter does not re-raise itself on the next pass');
          const allowed = await dispatch(services, target, work, 3);
          assert.equal(allowed.status, 'APPLIED', 'and the project may run again');
        });

      await scenario('AC2: repeated, concurrent and post-restart dead letters are one episode',
        async () => {
          const target = await world(services.db, 'ac2-dead-dedupe');
          await task(services.db, target, 'work');
          await drainToIdle(services);
          await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

          await killABatch(target.projectId, 'ac2-dead-1');
          const first = await services.db.projectBlocker.findFirstOrThrow({
            where: { projectId: target.projectId, resolvedAt: null } });

          // A second loss, through a service that has never run before — a restart, as far as the
          // database can tell: new instance id, new lease holder, same key.
          await killABatch(target.projectId, 'ac2-dead-2');

          // …and two dead letters committing at once. The lease serialises them (§8.1 F1) and the
          // partial unique index is the backstop under it (§11.3 BE2), so whichever way this lands
          // there is one episode.
          const envelopes = await services.db.projectEvent.findMany({
            where: { projectId: target.projectId } });
          const racers = [servicesOn(URL!, { registerHandler: false }),
            servicesOn(URL!, { registerHandler: false })];
          try {
            const outcomes = await Promise.allSettled(racers.map((racer) => racer.db.$transaction(
              (tx) => racer.reconciler.deadLetter(
                tx as unknown as Prisma.TransactionClient, target.projectId,
                envelopes.map((row) => ({
                  v: row.v, id: row.id, projectId: row.projectId, kind: row.kind,
                  occurredAt: row.occurredAt,
                  source: { type: row.sourceType as 'TASK', id: row.sourceId },
                  dedupeKey: row.dedupeKey, payload: row.payload, occurrences: row.occurrences,
                  lastAt: row.lastAt, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt,
                })),
                'pcc24 concurrent dead letter'),
              { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
            )));
            assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'),
              'one of two concurrent dead letters has to be the one that records it');
          } finally {
            await Promise.all(racers.map((racer) => racer.dispose()));
          }

          const open = await services.db.projectBlocker.findMany({
            where: { projectId: target.projectId, resolvedAt: null } });
          assert.equal(open.length, 1, '§11.3: the same cause never opens a second episode');
          assert.equal(open[0].id, first.id);
          assert.equal(open[0].lifecycleGeneration, 1n, 'BE1: and the generation does not advance');
          assert.equal(await services.db.projectAction.count({
            where: { projectId: target.projectId, type: 'RAISE_BLOCKER' } }), 1,
            'BE3: one row, one permanent key, one ledger entry');
          assert.equal(open[0].firstSeenAt.getTime(), first.firstSeenAt.getTime(),
            'ES5: the age escalation is measured from does not restart');
          assert.equal(open[0].nextCheckAt.getTime(), first.nextCheckAt.getTime(),
            'ES5: and a HUMAN row\'s clock does not move with redelivery');
          assert.ok(open[0].occurrences >= 2, 'BL7: only the display columns move');

          // §11.5 ES4: the one thing that escalates it is its own age. Aged by hand rather than by
          // waiting thirty minutes; the pass, the compare-and-set and the notification are real.
          await services.db.projectBlocker.update({
            where: { id: first.id },
            data: {
              firstSeenAt: new Date(Date.now() - 31 * 60_000),
              nextCheckAt: new Date(Date.now() - 60_000),
            },
          });
          await settle(services, target.projectId);
          const escalated = await services.db.projectBlocker.findUniqueOrThrow(
            { where: { id: first.id } });
          assert.ok(escalated.escalatedAt, '§11.5: an episode this old has been handed to a person');
          assert.equal(escalated.owner, 'USER', 'ES3: escalation goes to USER, once');
          assert.equal(escalated.recovery, 'HUMAN', 'ES1: and leaves recovery alone');
          assert.equal(await services.db.projectEvent.count({
            where: { projectId: target.projectId, kind: 'blocker.escalated' } }), 1,
            '§11.5: at most one notification per lifecycle');
          await settle(services, target.projectId);
          assert.equal((await services.db.projectBlocker.findUniqueOrThrow(
            { where: { id: first.id } })).escalatedAt!.getTime(), escalated.escalatedAt!.getTime(),
            'and a second pass does not escalate it again');
        });

      await scenario('AC2: a dead letter that cannot record its blocker discards nothing',
        async () => {
          const target = await world(services.db, 'ac2-dead-atomic');
          await task(services.db, target, 'work');
          await drainToIdle(services);
          await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

          // The delivery transaction fails AFTER the reconciler has written its blocker. If that
          // write lived anywhere but this transaction it would survive; the events service says it
          // must not, and that no event may become DEAD without it.
          const failing = servicesOn(URL!, { registerHandler: false });
          failing.events.registerHandler({
            handle: async () => { throw new Error('pcc24 permanent delivery failure'); },
            deadLetter: async (tx, id, events, error) => {
              await failing.reconciler.deadLetter(tx, id, events, error);
              throw new Error('pcc24 injected failure after the blocker was written');
            },
          });
          try {
            await failing.events.enqueue(failing.db as unknown as Prisma.TransactionClient, {
              projectId: target.projectId, kind: 'task.updated',
              source: { type: 'TASK', id: target.projectId }, dedupeKey: 'ac2-dead-atomic' });
            await failing.db.projectEvent.updateMany({
              where: { projectId: target.projectId, dedupeKey: 'ac2-dead-atomic' },
              data: { attempts: 9 } });
            await assert.rejects(() => failing.events.drainOnce(),
              /pcc24 injected failure/,
              '§5.4: a dead letter that cannot be recorded fails the whole delivery');
          } finally {
            await failing.dispose();
          }

          assert.deepEqual(await services.db.projectBlocker.findMany({
            where: { projectId: target.projectId } }), [],
            'F22: the blocker rolled back with the transaction it was written in');
          const row = await services.db.projectEvent.findFirstOrThrow({
            where: { projectId: target.projectId, dedupeKey: 'ac2-dead-atomic' } });
          assert.equal(row.consumedAt, null, 'and the event is still live, so nothing was lost');
          assert.equal(row.disposition, null);
          assert.equal(row.attempts, 9, '§5.4: the attempt that could not be recorded did not count');

          // The same batch, delivered by a service that is not sabotaged: now both happen.
          await killABatch(target.projectId, 'ac2-dead-atomic');
          assert.equal((await services.db.projectEvent.findFirstOrThrow({
            where: { projectId: target.projectId, dedupeKey: 'ac2-dead-atomic' } })).disposition,
            'DEAD');
          assert.equal(await services.db.projectBlocker.count({
            where: { projectId: target.projectId, resolvedAt: null } }), 1,
            'F22: DEAD and the blocker are one commit, in both directions');
        });

      // --------------------------------------------------------------------------------------
      // AC2 / AC9 — real crashes on either side of the commit.
      // --------------------------------------------------------------------------------------

      await scenario('AC2: SIGKILL before the commit rolls the whole pass back', async () => {
        const target = await world(services.db, 'ac2-crash-before',
          { policy: ProjectAutomationPolicy.AUTO });
        await task(services.db, target, 'work');
        await drainToIdle(services);
        const settled = await runtimeRow(services, target.projectId);
        const decisionsBefore = await services.db.projectDecision.count({
          where: { projectId: target.projectId } });
        const actionsBefore = await services.db.projectAction.count({
          where: { projectId: target.projectId } });

        await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
          projectId: target.projectId, kind: 'task.updated',
          source: { type: 'TASK', id: target.projectId }, dedupeKey: 'ac2-crash-before' });

        const child = spawnCrashingPass('BEFORE_COMMIT', target.projectId);
        try {
          await waitForMarker(child, 'PASS_UNCOMMITTED');
          await kill(child);
        } finally {
          if (child.exitCode === null) await kill(child);
        }

        // The lease, the decision, the runtime publish and `consumed_at` were one transaction, so
        // a process that died inside it left none of them.
        assert.equal(await services.db.projectDecision.count({
          where: { projectId: target.projectId } }), decisionsBefore,
          'AC2/§8.3: a pass that did not commit wrote no decision');
        assert.equal(await services.db.projectAction.count({
          where: { projectId: target.projectId } }), actionsBefore);
        const pending = await services.db.projectEvent.findFirstOrThrow({
          where: { projectId: target.projectId, dedupeKey: 'ac2-crash-before' } });
        assert.equal(pending.consumedAt, null, 'AC2: and the signal is still there to be redone');
        const after = await runtimeRow(services, target.projectId);
        assert.equal(after.leaseHolder, null, 'the dead holder\'s lease died with its transaction');
        assert.equal(after.updatedAt.getTime(), settled.updatedAt.getTime());

        // A takeover redoes it, exactly once.
        assert.equal((await services.events.drainOnce()).status, 'CONSUMED');
        assert.equal(await services.db.projectDecision.count({
          where: { projectId: target.projectId } }), decisionsBefore + 1,
          'AC9: the survivor completes the pass the dead process started, once');
      });

      await scenario('AC2: SIGKILL after the commit does not replay it', async () => {
        const target = await world(services.db, 'ac2-crash-after',
          { policy: ProjectAutomationPolicy.AUTO });
        await task(services.db, target, 'work');
        await drainToIdle(services);
        const decisionsBefore = await services.db.projectDecision.count({
          where: { projectId: target.projectId } });

        await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
          projectId: target.projectId, kind: 'task.updated',
          source: { type: 'TASK', id: target.projectId }, dedupeKey: 'ac2-crash-after' });

        const child = spawnCrashingPass('AFTER_COMMIT', target.projectId);
        try {
          await waitForMarker(child, 'PASS_COMMITTED');
          await kill(child);
        } finally {
          if (child.exitCode === null) await kill(child);
        }

        const consumed = await services.db.projectEvent.findFirstOrThrow({
          where: { projectId: target.projectId, dedupeKey: 'ac2-crash-after' } });
        assert.ok(consumed.consumedAt, 'AC2: what committed, committed');
        assert.equal(consumed.disposition, 'RECONCILED');
        assert.equal(await services.db.projectDecision.count({
          where: { projectId: target.projectId } }), decisionsBefore + 1);

        // The survivor finds nothing to redo — the post-commit announcement the dead process never
        // made is latency, not correctness (§8.3).
        assert.equal((await services.events.drainOnce()).status, 'IDLE',
          'AC2: a committed pass is not replayed by the process that takes over');
        assert.equal(await services.db.projectDecision.count({
          where: { projectId: target.projectId } }), decisionsBefore + 1);
        const state = await runtimeRow(services, target.projectId);
        assert.equal(state.leaseHolder, null);
        assert.ok(state.nextWakeAt, 'AC3: and the recovered project still has a clock');
      });

      // --------------------------------------------------------------------------------------
      // AC9 — takeover, fencing, restart, offline runners, mixed versions.
      // --------------------------------------------------------------------------------------

      await scenario('AC9: two instances contend and exactly one holds the project', async () => {
        const target = await world(services.db, 'ac9-lease');
        await task(services.db, target, 'work');
        const other = servicesOn(URL!, { registerDispatchPass: false });
        try {
          const now = new Date();
          const [a, b] = await Promise.all([
            services.reconciler.acquireLease(target.projectId, now),
            other.reconciler.acquireLease(target.projectId, now),
          ]);
          const holders = [a, b].filter(Boolean);
          assert.equal(holders.length, 1, 'AC9/§8.1: a project is held by at most one instance');
          const holder = holders[0]!;

          // The loser takes over once the lease expires, and the fence advances.
          const later = new Date(now.getTime() + 10 * 60_000);
          const taken = await other.reconciler.acquireLease(target.projectId, later)
            ?? await services.reconciler.acquireLease(target.projectId, later);
          assert.ok(taken, 'AC9: an expired lease is takeable');
          assert.ok(taken!.fencingToken > holder.fencingToken,
            'AC9/§8.1: the fencing token never goes back');

          // And the evicted holder may not commit anything under its dead token.
          await assert.rejects(
            () => services.reconciler.applyAction(holder, {
              type: 'OPEN_COORDINATOR_TURN',
              idempotencyKey: `pc:v1:${target.projectId}:turn:0:evicted`,
              subject: { type: 'PROJECT', id: target.projectId },
            }, async () => { throw new Error('the effect of an evicted holder must never run'); },
            later),
            /lease/i,
            'AC9: a stale fence is refused before its effect');
          await other.reconciler.releaseLease(taken!);
        } finally {
          await other.dispose();
        }
        await drainToIdle(services);
      });

      await scenario('AC9: a runner going offline is a blocker, and its heartbeat clears it',
        async () => {
          const target = await world(services.db, 'ac9-runner',
            { policy: ProjectAutomationPolicy.AUTO });
          const work = await task(services.db, target, 'work');
          await drainToIdle(services);

          // The edge a trigger cannot see: a heartbeat going stale writes no row. The reaper is
          // the one guarded write that materializes it, and migration 0118 fans the signal out.
          await services.db.runner.update({
            where: { id: target.runnerId },
            data: {
              lastHeartbeatAt: new Date(Date.now() - PROJECT_RUNNER_OFFLINE_AFTER_MS - 60_000),
            },
          });
          const reaped = await services.reaper.reapOnce();
          assert.equal(reaped, 1, 'AC9: a runner nobody heard from is marked offline');
          const signalled = await services.db.projectEvent.count({
            where: { projectId: target.projectId, kind: { startsWith: 'runner.' } } });
          assert.ok(signalled > 0, 'AC9: and the projects that care are told');

          await dispatch(services, target, work);
          await drainToIdle(services);
          const blocker = await services.db.projectBlocker.findFirstOrThrow({
            where: { projectId: target.projectId, resolvedAt: null, kind: 'NO_MATCHING_RUNNER' } });
          assert.ok(blocker.nextCheckAt, 'AC3: a recoverable blocker keeps a clock');

          await services.db.runner.update({
            where: { id: target.runnerId },
            data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() } });
          const recovered = await dispatch(services, target, work, 2);
          assert.equal(recovered.status, 'APPLIED', 'AC9: the work resumes when the machine does');
          await drainToIdle(services);
          assert.equal(await services.db.projectBlocker.count({
            where: { projectId: target.projectId, resolvedAt: null } }), 0);
        });

      await scenario('AC9: a coordination run that ended is replaced without losing the graph',
        async () => {
          const target = await world(services.db, 'ac9-coordinator',
            { policy: ProjectAutomationPolicy.AUTO });
          const work = await task(services.db, target, 'work');
          const opened = await services.projects.coordinator(
            target.ownerId, target.projectId, target.agentId);
          await drainToIdle(services);
          const dispatched = await dispatch(services, target, work);
          assert.equal(dispatched.status, 'APPLIED');

          // The coordination run dies — the process hosting it was killed, so it is FAILED rather
          // than finished. §7.5 says the conversation is replaceable; the work is not.
          await services.db.session.update({
            where: { id: opened.sessionId },
            data: { status: RunStatus.FAILED, finishedAt: new Date(), error: 'pcc22 host died' } });
          await deliver(services, target.projectId, 'session.ended');
          await drainToIdle(services);

          const after = await services.db.project.findUniqueOrThrow({
            where: { id: target.projectId }, include: { runtime: true, members: true } });
          assert.notEqual(after.coordinatorSessionId, opened.sessionId);
          assert.equal(String(after.runtime!.coordinatorGeneration), '1');
          assert.deepEqual(after.members.map((member) => member.agentId), [target.agentId],
            'AC9: WHO is not re-elected by a crash');
          assert.equal(await services.db.task.count({ where: { projectId: target.projectId } }), 1,
            'AC9: no task is lost');
          assert.equal(await services.db.session.count({ where: { taskId: work } }), 1,
            'AC9: and none is started twice');
        });

      await scenario('AC9: a binary that does not know the loop exists cannot double-dispatch',
        async () => {
          const target = await world(services.db, 'ac9-mixed',
            { policy: ProjectAutomationPolicy.AUTO });
          const work = await task(services.db, target, 'work');
          const dispatched = await dispatch(services, target, work);
          assert.equal(dispatched.status, 'APPLIED');
          assert.ok(dispatched.sessionId);

          // An old apiserver's sweep: raw SQL, no project awareness, `dispatch_origin` left at its
          // database default. §7.7 D6 is what stops it, and D5 is what stops a second live session
          // even if it had claimed one.
          await assert.rejects(
            () => identity.query(
              `INSERT INTO "session" (id, owner_id, creator_id, task_id, workspace_id,
                                      assigned_runner_id, title, prompt, provider, status, updated_at)
               VALUES ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                       'legacy sweep', 'x', 'claude', 'PENDING', now())`,
              [randomUUID(), target.ownerId, work, target.agentId, target.runnerId]),
            /DISPATCH_AUTHORITY_VIOLATION/,
            'AC9/§12.3 D6: a coordinator-authority task refuses a dispatch with no authority');

          // Even WITH the user's explicit origin — the one D6 lets through — D5's unique index
          // refuses a second live session for the same task.
          await assert.rejects(
            () => identity.query(
              `INSERT INTO "session" (id, owner_id, creator_id, task_id, workspace_id,
                                      assigned_runner_id, title, prompt, provider, status,
                                      dispatch_origin, updated_at)
               VALUES ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                       'second live', 'x', 'claude', 'PENDING', 'USER', now())`,
              [randomUUID(), target.ownerId, work, target.agentId, target.runnerId]),
            /duplicate key|unique/i,
            'AC9/§7.7 D5: one task holds at most one live session, whoever asks');

          assert.equal(await services.db.session.count({
            where: { taskId: work, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } } }), 1);
          await drainToIdle(services);
        });

      // --------------------------------------------------------------------------------------
      // AC3 — the liveness SLO itself, including the proof that the audit can fail.
      // --------------------------------------------------------------------------------------

      await scenario('AC3: every legal shape passes the §10.3 audit', async () => {
        // (a) a live session a person started — a human's action is evidence, not a hole.
        const executing = await world(services.db, 'ac3-a', { policy: ProjectAutomationPolicy.AUTO });
        const running = await task(services.db, executing, 'work');
        await session(services.db, executing,
          { taskId: running, status: RunStatus.RUNNING, finishedAt: null });
        await drainToIdle(services);

        // (c) a blocker with all five fields, on a project waiting for a person.
        const blocked = await world(services.db, 'ac3-c', { policy: ProjectAutomationPolicy.AUTO });
        const held = await task(services.db, blocked, 'work', { assigneeId: null });
        await dispatch(services, blocked, held);
        await drainToIdle(services);

        // (d) plain planning: nothing in flight, so all it has is a clock — and that is enough.
        const planning = await world(services.db, 'ac3-d');
        await task(services.db, planning, 'work');
        await drainToIdle(services);

        const violations = await livenessViolations(identity);
        assert.deepEqual(violations, [], 'AC3: none of these three is idling');

        const shapes = await services.db.projectRuntime.findMany({
          where: { projectId: { in: [executing.projectId, blocked.projectId, planning.projectId] } },
        });
        assert.equal(shapes.length, 3);
        for (const shape of shapes) {
          assert.ok(shape.runState !== 'SETTLED');
        }
      });

      await scenario('AC3: the audit FAILS for a project that stopped its own clock', async () => {
        const target = await world(services.db, 'ac3-violation');
        await task(services.db, target, 'work');
        await drainToIdle(services);
        assert.deepEqual(await livenessViolations(identity), []);

        // The defect §10.2 W4 clause (iii) calls P0, injected directly: an OPEN project, switched
        // on, no blocker, nothing in flight, and no wake. An audit that cannot go red here proves
        // nothing when it is green.
        await services.db.projectRuntime.update({
          where: { projectId: target.projectId },
          data: { nextWakeAt: null, nextWakeReason: null } });
        const violations = await livenessViolations(identity);
        assert.equal(violations.length, 1, 'AC3: the audit must be falsifiable');
        assert.equal(violations[0].project_id, target.projectId);
        assert.equal(violations[0].clause_a_live_session, false);
        assert.equal(violations[0].clause_b_turn_in_flight, false);
        assert.equal(violations[0].clause_c_actionable_blocker, false);
        assert.equal(violations[0].clause_d_future_wake, false);

        // And the loop repairs it on its own: the backstop finds the stopped clock and one pass
        // gives it back. This is the recovery §10.2 promises, measured rather than assumed.
        const started = Date.now();
        await services.reconciler.tick(new Date(Date.now() + 10 * 60_000));
        await drainToIdle(services);
        const elapsed = Date.now() - started;
        assert.deepEqual(await livenessViolations(identity), [],
          'AC3: one backstop cycle must restore a decidable state');
        assert.ok(elapsed < 30_000, `AC3: recovery took ${elapsed}ms, over the 30s p99 target`);
        assert.ok(services.reconciler.backstopHits > 0,
          'AC3/§10.2 W2: and it is reported as the missed-event bug it is');
      });

      await scenario('AC3: a project waiting on an escalated person is not reported as stalled',
        async () => {
          const target = await world(services.db, 'ac3-human', {
            policy: ProjectAutomationPolicy.AUTO });
          // The assignee, not the coordinator: a disabled coordinator is a different §11.2 row.
          const worker = await services.db.workspace.create({
            data: {
              ownerId: target.ownerId, runnerId: target.runnerId, name: 'ac3-human-worker',
              enabled: true,
            },
          });
          await services.db.projectMember.create({
            data: { projectId: target.projectId, agentId: worker.id, role: 'MEMBER' } });
          const work = await task(services.db, target, 'work', { assigneeId: worker.id });
          await services.db.workspace.update({ where: { id: worker.id }, data: { enabled: false } });
          await dispatch(services, target, work);
          await drainToIdle(services);

          const blocker = await services.db.projectBlocker.findFirstOrThrow({
            where: { projectId: target.projectId, resolvedAt: null } });
          assert.equal(blocker.recovery, 'HUMAN');
          await services.db.projectBlocker.update({
            where: { id: blocker.id },
            data: { firstSeenAt: new Date(Date.now() - 4 * 60 * 60_000) } });
          await deliver(services, target.projectId, 'task.updated');
          await drainToIdle(services);

          const escalated = await services.db.projectBlocker.findUniqueOrThrow({
            where: { id: blocker.id } });
          assert.ok(escalated.escalatedAt, 'the alarm must have gone off for this to be the shape');
          const state = await runtimeRow(services, target.projectId);
          assert.equal(state.runState, 'AWAITING_HUMAN');
          assert.equal(state.nextWakeAt, null,
            '§10.4 N-null: this is the ONE shape allowed to stop its own clock');

          // §10.2 W4 (ii)/(iii), and `PC-CX-05` behind them: a predicate that hit every NULL wake
          // would report this project as stalled once a minute for as long as the person takes,
          // and W2 makes every hit a WARN. An alarm that is permanently true is not an alarm.
          const hitsBefore = services.reconciler.backstopHits;
          await services.reconciler.tick(new Date(Date.now() + 10 * 60_000));
          await services.reconciler.tick(new Date(Date.now() + 20 * 60_000));
          assert.equal(services.reconciler.backstopHits, hitsBefore,
            'AC3: waiting on a person is not a missed-event bug');
          assert.equal(await services.db.projectEvent.count({
            where: { projectId: target.projectId, kind: 'timer.backstop' } }), 0);

          // But the moment that stops being the reason — the blocker resolves and the clock is
          // still stopped — the backstop must find it. The alarm has to remain falsifiable.
          await services.db.projectBlocker.updateMany({
            where: { projectId: target.projectId, resolvedAt: null },
            data: { resolvedAt: new Date(), resolvedBy: 'AUTO' } });
          await services.reconciler.tick(new Date(Date.now() + 30 * 60_000));
          assert.ok(services.reconciler.backstopHits > hitsBefore,
            'AC3: a stopped clock with nothing open IS the silent-idling defect');
          await drainToIdle(services);
        });

      await scenario('AC3: a state change converges inside the bound', async () => {
        const target = await world(services.db, 'ac3-latency', {
          policy: ProjectAutomationPolicy.AUTO });
        const work = await task(services.db, target, 'work');
        await drainToIdle(services);
        const before = await runtimeRow(services, target.projectId);

        // The state change a user makes, through the door they make it through.
        const started = Date.now();
        await services.projects.triggerCoordinator(target.ownerId, target.projectId, {});
        await drainToIdle(services);
        const elapsed = Date.now() - started;

        const after = await runtimeRow(services, target.projectId);
        assert.ok(after.updatedAt.getTime() >= before.updatedAt.getTime(),
          'AC3: the change was published');
        assert.ok(after.nextWakeAt, 'AC3: with a clock for whatever comes next');
        assert.ok(elapsed < 5_000,
          `AC3/§10.2: the event path took ${elapsed}ms, over the 5s p95 target`);
        void work;
      });

      if (CONTAINER) {
        await scenario('AC9: a real database restart resumes the pending work', async () => {
          const target = await world(services.db, 'ac9-restart',
            { policy: ProjectAutomationPolicy.AUTO });
          await task(services.db, target, 'work');
          await drainToIdle(services);
          await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
            projectId: target.projectId, kind: 'task.updated',
            source: { type: 'TASK', id: target.projectId }, dedupeKey: 'ac9-restart' });
          const wakeBefore = (await runtimeRow(services, target.projectId)).nextWakeAt;
          assert.ok(wakeBefore, 'the project must have a persisted clock to recover');

          // Close every connection this process owns FIRST. A socket the server terminates under
          // an idle client is an error nobody asked for; a restart the client knew about is the
          // fault being injected, which is the server going away, not a dropped socket.
          await identity.end().catch(() => undefined);
          await services.db.$disconnect();

          await run('docker', ['stop', CONTAINER]);
          await run('docker', ['start', CONTAINER]);
          for (let attempt = 0; attempt < 60; attempt += 1) {
            try {
              await run('docker', ['exec', CONTAINER, 'pg_isready', '-q']);
              break;
            } catch {
              await new Promise((resolve) => { setTimeout(resolve, 500); });
            }
          }

          identity = await connectIsolatedPg(URL);

          // A brand-new service graph, as a restarted process has: nothing carried in memory.
          const restarted = servicesOn(URL!);
          try {
            const wakeAfter = (await restarted.db.projectRuntime
              .findUniqueOrThrow({ where: { projectId: target.projectId } })).nextWakeAt;
            assert.equal(wakeAfter?.getTime(), wakeBefore!.getTime(),
              'AC9: the clock is a committed fact, not process state');
            const drained = await restarted.events.drainOnce();
            assert.equal(drained.status, 'CONSUMED',
              'AC9: and the signal that was in the queue is still delivered');
          } finally {
            await restarted.dispose();
          }
          await drainToIdle(services);
        });
      }
    } finally {
      await services.dispose();
      await identity.end();
    }
  });
