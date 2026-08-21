import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectAutomationPolicy, RunStatus, RunnerStatus, TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import {
  E2eServices,
  TaskOptions,
  World,
  connectIsolatedPg,
  deliver,
  dispatch,
  drainToIdle,
  emptyWorld,
  servicesOn,
  task,
  world,
} from './project-e2e-harness';
import { PROJECT_RUNNER_OFFLINE_AFTER_MS } from './project-availability-reaper.service';
import { PROJECT_DISPATCH_RETRY_WINDOW_MS } from './project-dispatch-pass';

/**
 * §7.8 — the control loop starting the next task by itself, on a real PostgreSQL.
 *
 * This is the regression for the defect the unit exists to fix. Before it, a project could be OPEN,
 * coordinator-enabled, un-blocked, with a ready task, an online runner and free concurrency, and
 * take twenty-three consecutive decisions with `dispatch_attempt` stuck at zero: everything a
 * dispatch needs was built and tested, and nothing in production ever called it. The distinguishing
 * property of every scenario here is therefore **what nobody did** — no `POST /tasks/:id/execute`,
 * no `autoRunWhenReady` sweep, no direct call to `ProjectTaskDispatcherService`. The only doors
 * touched are the ones a signal, a timer or an operator would touch.
 *
 * `servicesOn` wires §7.8's pass exactly as `ProjectsModule` does, so `deliver` — one committed
 * event, drained through the real consumer — is the whole trigger.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface DispatchRecord {
  status: string;
  refusalCode: string | null;
  reasonCode: string | null;
  idempotencyKey: string;
  resultSessionId: string | null;
  subjectId: string | null;
}

async function dispatchActions(
  services: E2eServices,
  projectId: string,
): Promise<DispatchRecord[]> {
  const rows = await services.db.projectAction.findMany({
    where: { projectId, type: 'DISPATCH_TASK' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      status: true, refusalCode: true, reasonCode: true, idempotencyKey: true,
      resultSessionId: true, subjectId: true,
    },
  });
  return rows as DispatchRecord[];
}

/**
 * Move this project's refused dispatches into the past, so the next pass is outside
 * `PROJECT_DISPATCH_RETRY_WINDOW_MS`.
 *
 * The window is a wall-clock rule read off `world.actions[].createdAt`, and a scenario that runs in
 * three seconds cannot wait it out. Ageing the row is the honest way to say "a minute passed": it
 * moves the one fact the rule reads, and leaves every other gate answering for itself.
 */
async function ageRefusals(services: E2eServices, projectId: string): Promise<void> {
  await services.db.projectAction.updateMany({
    where: { projectId, type: 'DISPATCH_TASK', status: 'REFUSED' },
    data: { createdAt: new Date(Date.now() - PROJECT_DISPATCH_RETRY_WINDOW_MS - 1_000) },
  });
}

async function attemptOf(services: E2eServices, taskId: string): Promise<bigint> {
  const row = await services.db.task.findUniqueOrThrow({
    where: { id: taskId }, select: { dispatchAttempt: true } });
  return row.dispatchAttempt;
}

/** A ready task: OPEN, assigned to the project's agent, on its online runner, nothing owed. */
async function readyTask(
  services: E2eServices,
  target: World,
  title: string,
  options: TaskOptions = {},
): Promise<string> {
  return task(services.db, target, title, { autoRunWhenReady: true, ...options });
}

test('unit 25D: the control loop dispatches the next task by itself', { skip, timeout: 900_000 },
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
      await scenario('AC3: a GUARDED_AUTO project starts its own ready task, and tells the runner',
        async () => {
          const target = await world(services.db, 'pass-ac3',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await readyTask(services, target, 'work');
          assert.equal(await attemptOf(services, work), 0n);

          const before = services.announced.sessions.length;
          // The ONLY thing done to this project. Nothing calls execute, nothing calls the
          // dispatcher, and no legacy sweep runs in this process.
          await deliver(services, target.projectId);
          await drainToIdle(services);

          const actions = await dispatchActions(services, target.projectId);
          assert.equal(actions.length, 1, 'exactly one dispatch was proposed and claimed');
          const [action] = actions;
          assert.equal(action.status, 'APPLIED', 'AC3: and it went through');
          assert.equal(action.refusalCode, null);
          assert.equal(action.subjectId, work);
          // §8.2: the permanent key names the project, the task and the attempt it was minted for.
          assert.equal(action.idempotencyKey, `pc:v1:${target.projectId}:dispatch:${work}:0`);

          assert.ok(action.resultSessionId, 'AC3: the action names the Session it created');
          const created = await services.db.session.findUniqueOrThrow({
            where: { id: action.resultSessionId! } });
          assert.equal(created.taskId, work);
          assert.equal(created.status, RunStatus.PENDING);
          assert.equal(created.dispatchOrigin, 'PROJECT_COORDINATOR',
            'the Session records that the control loop started it, not a person');
          assert.equal(created.projectActionId, action.resultSessionId ? created.projectActionId : null);
          assert.equal(created.assignedRunnerId, target.runnerId);
          assert.equal(created.workspaceId, target.agentId);

          // §8.2 GE1: the attempt belongs to the claimed key and advanced exactly once.
          assert.equal(await attemptOf(services, work), 1n);
          const still = await services.db.task.findUniqueOrThrow({ where: { id: work } });
          assert.equal(still.status, TaskStatus.OPEN,
            'the task stays OPEN — a dispatch starts work, it does not finish it');

          // §8.3: the runner is told post-commit. A Session nobody announced is only slower, but
          // "the loop started it" is not provable without this.
          assert.ok(services.announced.sessions.length > before);
          assert.ok(services.announced.sessions.includes(action.resultSessionId!));
        });

      await scenario('AC3: it keeps going — the next task starts when the first one is done',
        async () => {
          const target = await world(services.db, 'pass-chain',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const first = await readyTask(services, target, 'first');
          const second = await readyTask(services, target, 'second', { dependsOn: [first] });

          await deliver(services, target.projectId);
          await drainToIdle(services);
          let actions = await dispatchActions(services, target.projectId);
          assert.deepEqual(actions.map((row) => row.subjectId), [first],
            '§7.4 precondition 3: the dependent task is not a next step yet');

          // Finish the first the way a runner would, then let the loop see it.
          const session = await services.db.session.findFirstOrThrow({ where: { taskId: first } });
          await services.db.session.update({
            where: { id: session.id },
            data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
          await services.db.task.update({
            where: { id: first }, data: { status: TaskStatus.DONE } });
          await deliver(services, target.projectId, 'task.status_changed');
          await drainToIdle(services);

          actions = await dispatchActions(services, target.projectId);
          assert.deepEqual(actions.map((row) => row.subjectId), [first, second],
            'AC3: and the loop moved on by itself');
          assert.equal(actions[1].status, 'APPLIED');
        });

      await scenario('§12.3 D4: autoRunWhenReady is the legacy switch and does not stop the loop',
        async () => {
          const target = await world(services.db, 'pass-d4',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await task(services.db, target, 'work', { autoRunWhenReady: false });
          await deliver(services, target.projectId);
          await drainToIdle(services);

          const actions = await dispatchActions(services, target.projectId);
          assert.equal(actions.length, 1);
          assert.equal(actions[0].status, 'APPLIED');
          assert.equal(actions[0].subjectId, work);
        });

      await scenario('§8.3: replaying the key the pass minted is ALREADY_APPLIED, not a second run',
        async () => {
          const target = await world(services.db, 'pass-replay',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await readyTask(services, target, 'work');
          await deliver(services, target.projectId);
          await drainToIdle(services);
          const first = await dispatchActions(services, target.projectId);
          assert.equal(first.length, 1);
          assert.equal(first[0].status, 'APPLIED');

          // Every further wake: the pass runs again and finds nothing to do, because the task now
          // holds a live Session (§7.4 precondition 4).
          for (let i = 0; i < 3; i += 1) {
            await deliver(services, target.projectId, 'task.updated', `replay-${i}`);
            await drainToIdle(services);
          }
          assert.deepEqual(await dispatchActions(services, target.projectId), first,
            'AC3: repeated wakes do not re-dispatch a running task');
          assert.equal(await attemptOf(services, work), 1n, 'and they do not burn attempts');
          assert.equal(await services.db.session.count({ where: { taskId: work } }), 1);

          // And the key itself: an out-of-loop holder replaying attempt 0 lands on the SAME row.
          const replay = await dispatch(services, target, work, 0);
          assert.equal(replay.applyStatus, 'ALREADY_APPLIED',
            '§8.3: one permanent key, one effect, however many times it is presented');
          assert.equal(replay.actionId, (await services.db.projectAction.findFirstOrThrow({
            where: { idempotencyKey: `pc:v1:${target.projectId}:dispatch:${work}:0` } })).id);
          assert.equal(await services.db.session.count({ where: { taskId: work } }), 1);
        });

      await scenario('§9.4: the pass fills the free slots and no more, without burning attempts',
        async () => {
          const target = await world(services.db, 'pass-cap',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO, maxConcurrentTasks: 1 });
          const first = await readyTask(services, target, 'aaa-first');
          const second = await readyTask(services, target, 'zzz-second');

          await deliver(services, target.projectId);
          await drainToIdle(services);

          const live = await services.db.session.findMany({
            where: { task: { projectId: target.projectId }, status: RunStatus.PENDING } });
          assert.equal(live.length, 1, '§9.4: one slot, one Session');
          const started = live[0].taskId!;
          assert.ok(started, 'the Session the loop created belongs to a task');
          const parked = started === first ? second : first;
          // The one it did not choose was not attempted at all: over-cap dispatches are refused
          // without ever becoming a blocker, so proposing them would mint a permanent key per wake
          // forever. The snapshot's free-slot count is what stops that.
          assert.equal(await attemptOf(services, parked), 0n);
          const actions = await dispatchActions(services, target.projectId);
          assert.deepEqual(actions.map((row) => row.subjectId), [started]);

          // The cap itself is still the dispatcher's, and it is queryable when something does ask.
          const refused = await dispatch(services, target, parked, 0);
          assert.equal(refused.status, 'REFUSED');
          assert.equal(refused.refusalCode, 'PROJECT_CONCURRENCY_LIMIT');
          assert.equal(refused.reasonCode, 'PROJECT_CONCURRENCY_LIMIT');
          assert.equal(refused.sessionId, null);

          // And when the slot frees, the loop takes it on its own — one window after the refusal
          // above, which is the only thing standing between the parked task and its turn.
          await ageRefusals(services, target.projectId);
          await services.db.session.update({
            where: { id: live[0].id },
            data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() } });
          await services.db.task.update({
            where: { id: started }, data: { status: TaskStatus.DONE } });
          await deliver(services, target.projectId, 'session.ended');
          await drainToIdle(services);
          assert.equal(
            await services.db.session.count({ where: { taskId: parked, status: RunStatus.PENDING } }),
            1, 'AC3: the freed slot is filled by the loop, not by a person');
        });

      await scenario('§11 BL1: an open PROJECT blocker stops the pass proposing anything',
        async () => {
          const target = await world(services.db, 'pass-blocked',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          // A dependency cycle: §11.2's `DEPENDENCY_CYCLE`, subject PROJECT, raised by the loop
          // itself rather than written here — the blocker under test has to be a real one.
          const a = await readyTask(services, target, 'aaa-cycle-a');
          const b = await readyTask(services, target, 'zzz-cycle-b', { dependsOn: [a] });
          await services.db.taskDependency.create({ data: { taskId: a, dependsOnTaskId: b } });

          await deliver(services, target.projectId);
          await drainToIdle(services);

          const open = await services.db.projectBlocker.findMany({
            where: { projectId: target.projectId, resolvedAt: null } });
          assert.equal(open.length, 1);
          assert.equal(open[0].kind, 'DEPENDENCY_CYCLE');
          assert.equal(open[0].subjectType, 'PROJECT');
          assert.deepEqual(await dispatchActions(services, target.projectId), [],
            '§11 BL1: a project that is KNOWN not to be able to go forward proposes nothing');
          assert.equal(await attemptOf(services, a), 0n);
          assert.equal(await attemptOf(services, b), 0n);

          // And the gate is the dispatcher's too, with its own code, for anything that does ask.
          const refused = await dispatch(services, target, a, 0);
          assert.equal(refused.status, 'REFUSED');
          assert.equal(refused.refusalCode, 'PROJECT_BLOCKED');
        });

      await scenario('§9.3: a MANUAL project asks once and never acts for the person',
        async () => {
          const target = await world(services.db, 'pass-manual',
            { policy: ProjectAutomationPolicy.MANUAL });
          const work = await readyTask(services, target, 'work');

          for (let i = 0; i < 3; i += 1) {
            await deliver(services, target.projectId, 'task.updated', `manual-${i}`);
            await drainToIdle(services);
          }

          assert.equal(
            await services.db.session.count({ where: { taskId: work } }), 0,
            '§9.2: MANUAL never dispatches without a person');
          const actions = await dispatchActions(services, target.projectId);
          assert.ok(actions.every((row) => row.status === 'REFUSED'),
            'anything it did propose was refused, in the audit, with a reason');
          assert.ok(actions.every((row) => row.refusalCode === 'POLICY_REQUIRES_APPROVAL'));
          // §11.2's `POLICY_MANUAL_HOLD` is a PROJECT-subject row, so the FIRST refusal opens it
          // and the pass proposes nothing after that. Three wakes, at most one proposal.
          assert.ok(actions.length <= 1,
            `a MANUAL project must not mint one action per wake (got ${actions.length})`);
          const hold = await services.db.projectBlocker.findFirstOrThrow({
            where: { projectId: target.projectId, resolvedAt: null, kind: 'POLICY_MANUAL_HOLD' } });
          assert.equal(hold.subjectType, 'PROJECT');
          assert.equal(hold.owner, 'USER', '§10.3 (c): and a person can see it is theirs');
        });

      await scenario('§4.2: a project awaiting verification still starts the work it is waiting on',
        async () => {
          const target = await world(services.db, 'pass-verify',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const subject = await readyTask(services, target, 'aaa-subject');
          const check = await readyTask(services, target, 'zzz-check',
            { verifiesTaskId: subject, dependsOn: [subject] });

          await deliver(services, target.projectId);
          await drainToIdle(services);

          // `runStateOf` reads AWAITING_VERIFICATION from the instant the check exists — before
          // anything has been verified. If the pass read that summary as a gate, the subject would
          // never run, the check would never run, and nothing could ever clear the state.
          const runtime = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.equal(runtime.runState, 'EXECUTING',
            'a dispatched subject is EXECUTING — which it only is because the pass ran');
          const actions = await dispatchActions(services, target.projectId);
          assert.deepEqual(actions.map((row) => row.subjectId), [subject]);
          assert.equal(actions[0].status, 'APPLIED');
          assert.equal(await attemptOf(services, check), 0n,
            '§7.4 precondition 3: a check does not run before the thing it checks is DONE');
        });

      await scenario('§11.4: a refused dispatch is retried, and the attempt that works clears it',
        async () => {
          const target = await world(services.db, 'pass-recover',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const work = await readyTask(services, target, 'work');
          await services.db.runner.update({
            where: { id: target.runnerId },
            data: { lastHeartbeatAt: new Date(Date.now() - PROJECT_RUNNER_OFFLINE_AFTER_MS - 60_000) },
          });
          assert.equal(await services.reaper.reapOnce(), 1);

          await deliver(services, target.projectId);
          await drainToIdle(services);
          const refused = await dispatchActions(services, target.projectId);
          // One attempt, not one per wake. `dispatch_attempt` is a scalar write on `task`, so
          // migration 0117 turns every attempt into a `task.updated` signal that wakes the pass
          // again; without the window this drain would mint a key per drain until the limit.
          assert.equal(refused.length, 1,
            `a refusal must not feed itself another attempt (got ${refused.length})`);
          assert.equal(refused[0].status, 'REFUSED');
          assert.equal(refused[0].refusalCode, 'NO_MATCHING_RUNNER',
            'the pass proposes; the dispatcher decides, and says why in the ledger');
          assert.equal(await services.db.session.count({ where: { taskId: work } }), 0);
          const blocker = await services.db.projectBlocker.findFirstOrThrow({
            where: { projectId: target.projectId, resolvedAt: null, kind: 'NO_MATCHING_RUNNER' } });
          assert.ok(blocker.nextCheckAt, '§10.4: and it keeps a clock');

          // §11.4 clears a resolution-chain row only by letting an attempt through and watching it
          // NOT be refused — so the pass must keep proposing this one.
          await services.db.runner.update({
            where: { id: target.runnerId },
            data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() } });
          await ageRefusals(services, target.projectId);
          await deliver(services, target.projectId, 'runner.status_changed');
          await drainToIdle(services);

          const after = await dispatchActions(services, target.projectId);
          assert.ok(after.length > 1, 'the refusal did not park the task for good');
          assert.equal(after.at(-1)!.status, 'APPLIED', 'AC3: the work resumes when the machine does');
          assert.equal(await services.db.session.count({
            where: { taskId: work, status: RunStatus.PENDING } }), 1);
          assert.equal(await services.db.projectBlocker.count({
            where: { projectId: target.projectId, resolvedAt: null } }), 0);
        });

      await scenario('§12.3 D1: a LEGACY-authority task is not the control loop’s to start',
        async () => {
          const target = await world(services.db, 'pass-legacy',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO, coordinatorEnabled: false });
          const work = await readyTask(services, target, 'work');
          const row = await services.db.task.findUniqueOrThrow({ where: { id: work } });
          assert.equal(row.dispatchAuthority, 'LEGACY',
            'migration 0119 derives the column; a coordinator-less project owns none of its tasks');

          await deliver(services, target.projectId);
          await drainToIdle(services);
          assert.deepEqual(await dispatchActions(services, target.projectId), []);
          assert.equal(await services.db.session.count({ where: { taskId: work } }), 0);
          assert.equal(await attemptOf(services, work), 0n);
        });

      await scenario('§7.4: a held task, a future task and an unassigned task are all left alone',
        async () => {
          const target = await world(services.db, 'pass-preconditions',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          const held = await readyTask(services, target, 'aaa-held', { dispatchHold: true });
          const later = await readyTask(services, target, 'mmm-later');
          const nobody = await readyTask(services, target, 'zzz-nobody', { assigneeId: null });
          await services.db.task.update({
            where: { id: later }, data: { runAt: new Date(Date.now() + 60 * 60_000) } });

          await deliver(services, target.projectId);
          await drainToIdle(services);

          assert.deepEqual(await dispatchActions(services, target.projectId), []);
          for (const id of [held, later, nobody]) {
            assert.equal(await attemptOf(services, id), 0n);
            assert.equal(await services.db.session.count({ where: { taskId: id } }), 0);
          }
          // And they are visible as waiting rather than silently gone: §10.3 (d) still holds.
          const runtime = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.ok(runtime.nextWakeAt, 'AC3: a project with nothing to start still keeps a clock');
        });

      await scenario('§8.1: the pass takes the lease and gives it back, every time',
        async () => {
          const target = await world(services.db, 'pass-lease',
            { policy: ProjectAutomationPolicy.GUARDED_AUTO });
          await readyTask(services, target, 'work');
          await deliver(services, target.projectId);
          await drainToIdle(services);

          const runtime = await services.db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId } });
          assert.equal(runtime.leaseHolder, null, 'a pass that finished holds nothing');
          assert.equal(runtime.leaseExpiresAt, null);
          // And the project is immediately leasable again, which is what makes the next wake work.
          const lease = await services.reconciler.acquireLease(target.projectId);
          assert.ok(lease, '§8.1: the fence advanced and the row is free');
          await services.reconciler.releaseLease(lease!);
        });

      await scenario('AC3: an idling project is a query that comes back empty', async () => {
        const target = await world(services.db, 'pass-liveness',
          { policy: ProjectAutomationPolicy.GUARDED_AUTO });
        const work = await readyTask(services, target, 'work');
        await deliver(services, target.projectId);
        await drainToIdle(services);

        // §10.3 clause (a), the shape that was unreachable before this unit: a LIVE Session for a
        // task of this project, attributable to an APPLIED DISPATCH_TASK.
        const rows = await services.db.$queryRawUnsafe<Array<{ ok: boolean }>>(`
          SELECT EXISTS (
            SELECT 1 FROM "session" s
              JOIN "task" t ON t."id" = s."task_id"
              JOIN "project_action" a ON a."id" = s."project_action_id"
             WHERE t."project_id" = '${target.projectId}'::uuid
               AND s."deleted_at" IS NULL AND s."status" IN ('PENDING', 'RUNNING')
               AND a."type" = 'DISPATCH_TASK' AND a."status" = 'APPLIED'
          ) AS ok
        `);
        assert.equal(rows[0].ok, true, 'AC3 clause (a) holds, and the loop is what made it hold');
        assert.equal(uuidToBase62(work).length > 0, true);
      });
    } finally {
      await services.dispose();
      await identity.end();
    }
  });
