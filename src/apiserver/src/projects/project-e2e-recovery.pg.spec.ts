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
      const services = servicesOn(process.env.PCC_CHILD_URL, { registerHandler: false });
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
    const services = servicesOn(URL!);

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
          const target = await world(services.db, 'ac2-dead');
          await task(services.db, target, 'work');
          await drainToIdle(services);
          await services.db.projectEvent.deleteMany({ where: { projectId: target.projectId } });

          const failing = servicesOn(URL!, { registerHandler: false });
          failing.events.registerHandler({
            handle: async () => { throw new Error('pcc22 permanent delivery failure'); },
            deadLetter: (tx, id, events, error) =>
              failing.reconciler.deadLetter(tx, id, events, error),
          });
          try {
            await failing.events.enqueue(failing.db as unknown as Prisma.TransactionClient, {
              projectId: target.projectId, kind: 'task.updated',
              source: { type: 'TASK', id: target.projectId }, dedupeKey: 'ac2-dead' });
            let last = await failing.events.drainOnce();
            for (let attempt = 0; attempt < 12 && last.status !== 'DEAD'; attempt += 1) {
              await failing.db.projectEvent.updateMany({
                where: { projectId: target.projectId, dedupeKey: 'ac2-dead' },
                data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
              last = await failing.events.drainOnce();
            }
            assert.equal(last.status, 'DEAD', 'AC2: a batch that cannot be delivered ends, loudly');
          } finally {
            await failing.dispose();
          }

          const dead = await services.db.projectEvent.findFirstOrThrow({
            where: { projectId: target.projectId, dedupeKey: 'ac2-dead' } });
          assert.equal(dead.disposition, 'DEAD', 'AC2: the batch ends in a recorded terminal state');
          assert.equal(dead.attempts, 10, '§5.4: after the tenth attempt, not silently before it');

          // What `ProjectReconcileService.deadLetter` persists today is the RECOVERY, not a
          // blocker: PLANNING plus a wake whose reason names the dead letter. That keeps AC3 (the
          // project is not silent and a person reading the runtime row learns why), and it is
          // deliberately asserted as what it is — `ProjectEventHandler.deadLetter`'s own doc
          // comment promises "the fail-closed UNKNOWN_FAILURE state supplied by the blocker unit",
          // which unit 17 added after unit 05 and which this path never grew. Recorded in
          // docs/project-e2e-validation-22.md as F-22-02 rather than asserted away.
          const state = await runtimeRow(services, target.projectId);
          assert.equal(state.runState, 'PLANNING');
          assert.ok(state.nextWakeAt && state.nextWakeAt.getTime() > Date.now(),
            'AC3: a dead-lettered batch still leaves a clock');
          assert.match(state.nextWakeReason ?? '', /dead letter/i,
            'AC2: and the reason a reader sees names the dead letter');
          assert.equal(await services.db.projectBlocker.count({
            where: { projectId: target.projectId, resolvedAt: null } }), 0,
            'F-22-02: today this path raises no blocker — change this assertion when it does');
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
        const other = servicesOn(URL!);
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
