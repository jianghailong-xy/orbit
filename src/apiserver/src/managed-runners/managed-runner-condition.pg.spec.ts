/**
 * An active condition keeps an Orbit Cloud workspace awake (docs/condition-triggers-design.md §4.2, owner 2026-11-17;
 * docs/managed-runner-design.md, "Provisioning retry wake and sleep" 5 to 8): the manager against the in-memory
 * Kubernetes namespace of `test-support/fake-kube-client.ts` (managed-runner-world.ts), over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, with conditions written through the product's own doors —
 * SchedulesService for a WHEN rule, TasksService.create for a startWhen — and the demand hook wired as the app wires it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-condition.pg.spec.ts
 *
 *   active-condition-forbids-sleep         an ACTIVE WHEN schedule's condition, or an OPEN startWhen task's, is work
 *                                          the runner holds: idle past the interval it does not drain; a drain already
 *                                          under way is called off, whether the create's hook recorded demand or only
 *                                          the records show the condition; the instance's acceptance is refused
 *   active-condition-wakes-sleeping-runner a schedule created, or resumed, and a startWhen task created while the runner
 *                                          sleeps wake it (the hook); one the hook missed is woken by the sweep; it
 *                                          comes back READY on the same runner
 *   ended-condition-releases-runner        the task cancelled, the task started, the condition ended, the schedule ended
 *                                          or deleted: the condition is no longer work, the sweep wakes nothing, and an
 *                                          idle runner sleeps by the ordinary rule
 *   paused-schedule-releases-runner        a PAUSED and a HELD schedule release the runner: it drains and sleeps, and
 *                                          stays asleep through the sweep; resuming wakes it again
 *   create-cards-stays-awake-line          the schedule create card and the task create card carry "Keeps this cloud
 *                                          workspace awake while it waits." under the check line, and the condition's
 *                                          read says keepsWorkspaceAwake, for a workspace on Orbit Cloud only; with the
 *                                          switch off, neither
 *   asleep-reason-only-while-coming-up     silence on a runner still coming up is RUNNER_ASLEEP, not notified; on one
 *                                          that cannot come back by itself (FAILED), RUNNER_OFFLINE, notified
 *   self-managed-untouched                 a condition on a self-managed runner: no mapping is written, the hook answers
 *                                          not managed; with the switch off the hook records nothing for a managed one
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CONDITION_KEEPS_AWAKE_LINE, type TaskStartWhenInput } from '@orbit/shared';
import { PermissionMode } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin, TaskStatus, type ManagedRunner } from '@prisma/client';
import { Client } from 'pg';

import { ConditionsService } from '../conditions/conditions.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ScheduleReadsService } from '../schedules/schedule-reads.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from '../schedules/schedules.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { IDLE, managedRunnerWorld, type ManagedRunnerWorld } from '../test-support/managed-runner-world';
import { ManagedRunnerDemandService } from './managed-runner-demand';
import { MANAGED_RUNNERS_OFF, type ManagedRunnerGate } from './managed-runner-gate';
import { managedRunnerHeartbeat } from './managed-runner-sleep';
import { managedRunnerWork } from './managed-runner-work';

const URL = process.env.COORDINATOR_PG_URL;
const ON = { enabled: true, problem: null } as const;

test('an active condition keeps an Orbit Cloud workspace awake', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.DATABASE_URL ??= url;
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, publishes);
  const notified: string[] = [];

  /**
   * The services as the app wires them for one world: the demand hook over the world's runtime and the gate, in the
   * conditions service (a startWhen's create) and the schedules service (a WHEN rule's create, resume and change).
   * `hook: false` plays a replica whose hook was missed: only the records and the sweep know.
   */
  function services(w: ManagedRunnerWorld | null, opts: { hook?: boolean; gate?: ManagedRunnerGate } = {}) {
    const gate: ManagedRunnerGate = opts.gate ?? ON;
    const demand = w && opts.hook !== false ? new ManagedRunnerDemandService(prisma, gate, w.runtime) : undefined;
    const conditions = new ConditionsService(prisma, { notify: async (a) => void notified.push(a.conditionId) }, () => new Date(), gate, demand);
    const schedules = new SchedulesService(prisma, () => new Date(), undefined, undefined, demand);
    const reads = new ScheduleReadsService(prisma, gate);
    // TasksService's positional constructor: ConditionsService is its last parameter; the rest are not exercised here.
    const args: unknown[] = new Array(17).fill(undefined);
    args[0] = prisma;
    args[1] = sessions;
    args[2] = publishes;
    args[16] = conditions;
    const tasks = new (TasksService as unknown as new (...a: unknown[]) => TasksService)(...args);
    return { conditions, schedules, reads, tasks, demand };
  }

  /** A workspace of the managed runner, with a directory: where its conditions' probes run. */
  async function cloudWorkspace(m: ManagedRunner, label: string): Promise<{ workspaceId: string; sessionId: string }> {
    const workspace = await db.workspace.create({
      data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: `${label}-ws`, workDir: `/srv/${label}`, enabled: true },
    });
    const session = await db.session.create({
      data: {
        ownerId: m.ownerId, creatorId: m.ownerId, workspaceId: workspace.id, title: 'chat', prompt: 'p', provider: 'claude',
        engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode: PermissionMode.DEFAULT,
        turnState: null, finishedAt: new Date(), 
      },
    });
    return { workspaceId: workspace.id, sessionId: session.id };
  }

  const guard = (workspaceId: string): ScheduleCreateInput => ({
    intent: 'Tell me when Ceph is above 90% and look at what can be cleared',
    title: 'Ceph capacity guard',
    prompt: 'Look at what is using the space and propose what to clear.',
    rule: {
      kind: 'WHEN',
      runsPerWeek: 3,
      condition: {
        text: 'Raw used above 90%', command: 'ceph df -f json | jq .stats.total_used_raw_ratio', compare: { op: 'GT', value: 90 },
        rearm: { op: 'LT', value: 85 }, unit: '%',
      },
    },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    workspaceId,
    baseline: { key: 'below-90', summary: 'Raw used is 6.9%. Nothing to report.' },
  } as unknown as ScheduleCreateInput);

  const OSDS: TaskStartWhenInput = {
    text: '3 or more OSDs are in',
    command: 'ceph osd stat -f json | jq .num_in_osds',
    compare: { op: 'GTE', value: 3 },
    intervalSeconds: 300,
    unit: 'in',
    baseline: { value: 2 },
  };

  async function startWhenTask(s: ReturnType<typeof services>, ownerId: string, workspaceId: string) {
    return s.tasks.create(ownerId, {
      title: 'Set the kubernetes pool to 3 copies',
      assigneeId: workspaceId,
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
      provider: 'claude',
      autoRunWhenReady: false,
      startWhen: OSDS,
    } as never);
  }

  const owner = (ownerId: string): ScheduleActor => ({ kind: 'OWNER', ownerId });
  async function schedule(s: ReturnType<typeof services>, ownerId: string, workspaceId: string) {
    const created = await s.schedules.create(owner(ownerId), guard(workspaceId));
    assert.equal(created.outcome, 'CREATED', 'the owner\'s create applies at once');
    return (created as { schedule: { id: string } }).schedule;
  }

  const work = (m: ManagedRunner) => managedRunnerWork(prisma, m.runnerId);
  /** Idle past the interval, by the clock and by the instance's report. */
  async function idle(w: ManagedRunnerWorld, m: ManagedRunner) {
    w.advance(w.profile.lifecycle.idleSeconds * 1000 + 1_000);
    await w.heartbeat(m.runnerId, { idleSeconds: w.profile.lifecycle.idleSeconds + 1 });
  }
  /** Ready, it does not drain: the reconcile pass leaves it READY. */
  async function staysAwake(w: ManagedRunnerWorld, m: ManagedRunner, why: string) {
    await idle(w, m);
    assert.equal(await w.primary.reconcile(m.id), 'READY', `${why}: it does not drain`);
    assert.equal((await w.mappingOf(m.ownerId)).managementState, 'READY', why);
  }
  /** Asleep, the sweep leaves it asleep: nothing it holds can wake it. */
  async function staysAsleep(w: ManagedRunnerWorld, m: ManagedRunner, why: string) {
    await w.primary.sweepDemand();
    const after = await w.mappingOf(m.ownerId);
    assert.equal(after.managementState, 'SLEEPING', why);
    assert.equal(after.desiredState, 'SLEEPING', `${why}: no wake asked`);
  }
  /** Woken: RUNNING desired and demand recorded past the sleeping mapping's; then up again, READY, same runner. */
  async function woken(w: ManagedRunnerWorld, asleep: ManagedRunner, why: string) {
    const m = await w.mappingOf(asleep.ownerId);
    assert.equal(m.desiredState, 'RUNNING', `${why}: RUNNING is desired again`);
    assert.ok(m.demandRevision > asleep.demandRevision, `${why}: the demand is recorded`);
    assert.equal((await w.drive(asleep.ownerId)).at(-1), 'READY', `${why}: it comes back`);
    const up = await w.mappingOf(asleep.ownerId);
    assert.equal(up.runnerId, asleep.runnerId, `${why}: the same runner`);
    // Sleep retires the stopped generation; the wake starts the one the sleeping mapping already names.
    assert.equal(up.generation, asleep.generation, `${why}: the generation sleep made ready, now running`);
    assert.ok(up.podUid && up.podUid !== asleep.podUid, `${why}: a new instance`);
  }

  await t.test('active-condition-forbids-sleep', async () => {
    // A WHEN schedule that is ACTIVE.
    {
      const w = managedRunnerWorld(db);
      const s = services(w);
      const { ownerId, mapping } = await w.readyRunner('forbids-when');
      const { workspaceId } = await cloudWorkspace(mapping, 'forbids-when');
      assert.deepEqual(await work(mapping), [], 'before: nothing');
      await schedule(s, ownerId, workspaceId);
      assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION'], 'an ACTIVE schedule\'s condition is work');
      await staysAwake(w, mapping, 'an ACTIVE WHEN schedule');
    }
    // A startWhen task that is OPEN and waiting.
    {
      const w = managedRunnerWorld(db);
      const s = services(w);
      const { ownerId, mapping } = await w.readyRunner('forbids-task');
      const { workspaceId } = await cloudWorkspace(mapping, 'forbids-task');
      await startWhenTask(s, ownerId, workspaceId);
      assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION'], 'an OPEN startWhen task\'s condition is work');
      await staysAwake(w, mapping, 'an OPEN startWhen task');
    }
    // A drain under way when the condition is created: the hook's demand calls it off.
    {
      const w = managedRunnerWorld(db);
      const s = services(w);
      const { ownerId, mapping } = await w.readyRunner('forbids-drain-hook');
      const { workspaceId } = await cloudWorkspace(mapping, 'forbids-drain-hook');
      await idle(w, mapping);
      assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING', 'idle: it drains');
      await schedule(s, ownerId, workspaceId);
      assert.equal((await w.mappingOf(ownerId)).desiredState, 'RUNNING', 'the create asked it to stay');
      assert.equal(await w.primary.reconcile(mapping.id), 'READY', 'the drain is called off');
    }
    // …and with no hook (another replica's create): the records alone call it off and refuse the acceptance.
    {
      const w = managedRunnerWorld(db);
      const s = services(w, { hook: false });
      const { ownerId, mapping } = await w.readyRunner('forbids-drain-records');
      const { workspaceId } = await cloudWorkspace(mapping, 'forbids-drain-records');
      await idle(w, mapping);
      assert.equal(await w.primary.reconcile(mapping.id), 'DRAINING');
      await startWhenTask(s, ownerId, workspaceId);
      const draining = await w.mappingOf(ownerId);
      assert.equal(draining.desiredState, 'SLEEPING', 'no demand was recorded: only the records know');
      const answer = await managedRunnerHeartbeat(
        prisma,
        { mappingId: draining.id, generation: draining.generation, podUid: draining.podUid! },
        { ...IDLE, sleepReady: draining.stopRequestedAt!.toISOString() },
        w.now(),
      );
      assert.notEqual(answer.sleep?.confirmed, true, 'the instance\'s acceptance is refused while the condition is active');
      assert.equal((await w.mappingOf(ownerId)).stopAcknowledgedAt, null, 'nothing accepted');
      assert.equal(await w.primary.reconcile(mapping.id), 'READY', 'the drain is called off for the work');
    }
  });

  await t.test('active-condition-wakes-sleeping-runner', async () => {
    // A schedule created while it sleeps.
    {
      const w = managedRunnerWorld(db);
      const s = services(w);
      const { ownerId, mapping } = await w.readyRunner('wakes-when');
      const { workspaceId } = await cloudWorkspace(mapping, 'wakes-when');
      const asleep = await w.putToSleep(ownerId);
      await schedule(s, ownerId, workspaceId);
      await woken(w, asleep, 'a WHEN schedule created');
    }
    // A startWhen task created while it sleeps.
    {
      const w = managedRunnerWorld(db);
      const s = services(w);
      const { ownerId, mapping } = await w.readyRunner('wakes-task');
      const { workspaceId } = await cloudWorkspace(mapping, 'wakes-task');
      const asleep = await w.putToSleep(ownerId);
      await startWhenTask(s, ownerId, workspaceId);
      await woken(w, asleep, 'a startWhen task created');
    }
    // A schedule resumed while it sleeps.
    {
      const w = managedRunnerWorld(db);
      const s = services(w);
      const { ownerId, mapping } = await w.readyRunner('wakes-resume');
      const { workspaceId } = await cloudWorkspace(mapping, 'wakes-resume');
      const created = await schedule(s, ownerId, workspaceId);
      await s.schedules.pause(owner(ownerId), created.id);
      const asleep = await w.putToSleep(ownerId);
      await staysAsleep(w, asleep, 'paused');
      await s.schedules.resume(owner(ownerId), created.id);
      await woken(w, asleep, 'a WHEN schedule resumed');
    }
    // A hook missed: the sweep finds the active condition and wakes it.
    {
      const w = managedRunnerWorld(db);
      const s = services(w, { hook: false });
      const { ownerId, mapping } = await w.readyRunner('wakes-sweep');
      const { workspaceId } = await cloudWorkspace(mapping, 'wakes-sweep');
      const asleep = await w.putToSleep(ownerId);
      await startWhenTask(s, ownerId, workspaceId);
      assert.equal((await w.mappingOf(ownerId)).desiredState, 'SLEEPING', 'no hook: nothing asked yet');
      await w.primary.sweepDemand();
      await woken(w, asleep, 'the sweep');
    }
  });

  await t.test('ended-condition-releases-runner', async () => {
    const w = managedRunnerWorld(db);
    const s = services(w);
    const { ownerId, mapping } = await w.readyRunner('released');
    const { workspaceId } = await cloudWorkspace(mapping, 'released');

    // The task cancelled.
    const cancelled = await startWhenTask(s, ownerId, workspaceId);
    assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION']);
    await db.task.update({ where: { id: cancelled.id }, data: { status: TaskStatus.CANCELLED } });
    assert.deepEqual(await work(mapping), [], 'a cancelled task holds nothing');

    // The condition ended (the owner's Stop on the 30-day question ends it and leaves the task OPEN).
    const stopped = await startWhenTask(s, ownerId, workspaceId);
    assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION']);
    await db.condition.updateMany({ where: { taskId: stopped.id }, data: { state: 'ENDED', endedAt: new Date() } });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: stopped.id } })).status, 'OPEN', 'the task is still OPEN');
    assert.deepEqual(await work(mapping), [], 'an ENDED condition holds nothing');

    // The task started: its run is work of its own, its condition no longer is.
    const started = await startWhenTask(s, ownerId, workspaceId);
    assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION']);
    await s.tasks.execute(ownerId, started.id);
    assert.equal((await db.condition.findFirstOrThrow({ where: { taskId: started.id } })).state, 'ENDED', 'the start ended it');
    assert.ok(!(await work(mapping)).includes('ACTIVE_CONDITION'), 'a started task\'s condition holds nothing');
    await db.session.deleteMany({ where: { taskId: started.id } });

    // The schedule ended, and another deleted.
    const ended = await schedule(s, ownerId, workspaceId);
    assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION']);
    await s.schedules.end(owner(ownerId), ended.id);
    assert.deepEqual(await work(mapping), [], 'an ended schedule holds nothing');
    const deleted = await schedule(s, ownerId, workspaceId);
    assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION']);
    await s.schedules.remove(owner(ownerId), deleted.id);
    assert.deepEqual(await work(mapping), [], 'a deleted schedule holds nothing');

    // Released, the runner sleeps by the ordinary idle rule, and the sweep leaves it asleep.
    const remaining = await work(mapping);
    assert.deepEqual(remaining, [], `nothing left: ${remaining.join(', ')}`);
    const asleep = await w.putToSleep(ownerId);
    await staysAsleep(w, asleep, 'every condition released');
  });

  await t.test('paused-schedule-releases-runner', async () => {
    const w = managedRunnerWorld(db);
    const s = services(w);
    const { ownerId, mapping } = await w.readyRunner('paused');
    const { workspaceId } = await cloudWorkspace(mapping, 'paused');
    const paused = await schedule(s, ownerId, workspaceId);
    const held = await schedule(s, ownerId, workspaceId);
    await staysAwake(w, mapping, 'two ACTIVE schedules');

    await s.schedules.pause(owner(ownerId), paused.id);
    assert.deepEqual(await work(mapping), ['ACTIVE_CONDITION'], 'the other is still ACTIVE');
    // HELD (a start check failed): its condition stays live, and still releases the runner.
    await db.schedule.update({ where: { id: held.id }, data: { state: 'HELD', heldReason: 'WORKSPACE_GONE' } as never });
    assert.notEqual((await db.condition.findFirstOrThrow({ where: { scheduleId: held.id } })).state, 'ENDED', 'a HELD schedule\'s condition is live');
    assert.deepEqual(await work(mapping), [], 'a PAUSED and a HELD schedule hold nothing');

    const asleep = await w.putToSleep(ownerId);
    await staysAsleep(w, asleep, 'paused and held');
    await s.schedules.resume(owner(ownerId), paused.id);
    await woken(w, asleep, 'resumed');
  });

  await t.test('create-cards-stays-awake-line', async () => {
    const w = managedRunnerWorld(db);
    const s = services(w);
    const { ownerId, mapping } = await w.readyRunner('cards');
    const { workspaceId: cloudId, sessionId: cloudSession } = await cloudWorkspace(mapping, 'cards');
    // A self-managed runner of the same owner, and its workspace.
    const selfRunner = await db.runner.create({
      data: { ownerId, name: 'workstation-gpu', tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [] },
    });
    const selfWs = await db.workspace.create({ data: { ownerId, runnerId: selfRunner.id, name: 'self-ws', workDir: '/srv/self', enabled: true } });
    const selfSession = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, workspaceId: selfWs.id, title: 'chat', prompt: 'p', provider: 'claude', engine: 'claude',
        providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode: PermissionMode.DEFAULT, turnState: null, finishedAt: new Date(), 
      },
    });

    // The schedule create card, as a session asks for it.
    const askCard = async (sessionId: string, gate: ManagedRunnerGate) => {
      const asked = await s.schedules.create({ kind: 'SESSION', ownerId, sessionId }, guard('ignored'));
      assert.equal(asked.outcome, 'PENDING');
      const card = await new ScheduleReadsService(prisma, gate).request(ownerId, (asked as { request: { id: string } }).request.id);
      return (card.when as { condition: { awake: string | null; detail: string } }).condition;
    };
    const cloudCard = await askCard(cloudSession, ON);
    assert.equal(cloudCard.awake, CONDITION_KEEPS_AWAKE_LINE, 'the schedule card on Orbit Cloud says it keeps the workspace awake');
    assert.equal(cloudCard.awake, 'Keeps this cloud workspace awake while it waits.');
    assert.match(cloudCard.detail, /Checked every/, 'under the check line');
    assert.equal((await askCard(selfSession.id, ON)).awake, null, 'a self-managed runner: no line');
    assert.equal((await askCard(cloudSession, MANAGED_RUNNERS_OFF)).awake, null, 'the switch off: no line');

    // The task create card (task_create's preview, single and batch).
    const preview = async (svc: ReturnType<typeof services>, workspaceId: string) => {
      const body = await svc.tasks.previewCreateMany(ownerId, {
        tasks: [{ title: 'Set the pool to 3 copies', assigneeId: workspaceId, provider: 'claude', autoRunWhenReady: false, startWhen: OSDS }],
      } as never);
      return (body.tasks[0] as { startWhen?: { awake: string | null; checked: string } }).startWhen!;
    };
    const cloudTask = await preview(s, cloudId);
    assert.equal(cloudTask.awake, CONDITION_KEEPS_AWAKE_LINE, 'the task card on Orbit Cloud says it keeps the workspace awake');
    assert.match(cloudTask.checked, /Checked every/);
    assert.equal((await preview(s, selfWs.id)).awake, null, 'a self-managed runner: no line');
    assert.equal((await preview(services(null, { gate: MANAGED_RUNNERS_OFF }), cloudId)).awake, null, 'the switch off: no line');

    // The condition's read (the inspector's How it checks block).
    const onCloud = await startWhenTask(s, ownerId, cloudId);
    const onSelf = await startWhenTask(s, ownerId, selfWs.id);
    const conditionOf = async (taskId: string) => (await db.condition.findFirstOrThrow({ where: { taskId } })).id;
    assert.equal((await s.conditions.get(ownerId, await conditionOf(onCloud.id))).keepsWorkspaceAwake, true);
    assert.equal((await s.conditions.get(ownerId, await conditionOf(onSelf.id))).keepsWorkspaceAwake, false);
    const off = services(null, { gate: MANAGED_RUNNERS_OFF });
    assert.equal((await off.conditions.get(ownerId, await conditionOf(onCloud.id))).keepsWorkspaceAwake, false, 'the switch off');
  });

  await t.test('asleep-reason-only-while-coming-up', async () => {
    const w = managedRunnerWorld(db);
    const s = services(w);
    const { ownerId, mapping } = await w.readyRunner('reason');
    const { workspaceId } = await cloudWorkspace(mapping, 'reason');
    const task = await startWhenTask(s, ownerId, workspaceId);
    const conditionId = (await db.condition.findFirstOrThrow({ where: { taskId: task.id } })).id;
    const silent = async (state: string) => {
      await db.managedRunner.update({ where: { id: mapping.id }, data: { managementState: state as never } });
      await db.condition.update({
        where: { id: conditionId },
        data: { state: 'WAITING', unknownSince: null, unknownReason: null, lastSampleAt: new Date(Date.now() - 3_600_000), approvedAt: new Date(Date.now() - 3_600_000) },
      });
      await s.conditions.sweep();
      return db.condition.findUniqueOrThrow({ where: { id: conditionId } });
    };
    for (const state of ['WAITING_CAPACITY', 'STARTING']) {
      const before = notified.length;
      const c = await silent(state);
      assert.equal(c.unknownReason, 'RUNNER_ASLEEP', `${state}: still coming up`);
      assert.equal(notified.length, before, `${state}: not notified`);
    }
    const before = notified.length;
    const failed = await silent('FAILED');
    assert.equal(failed.unknownReason, 'RUNNER_OFFLINE', 'FAILED cannot come back by itself: the ordinary can\'t-read path');
    assert.equal(notified.length, before + 1, 'and it is notified');
  });

  await t.test('self-managed-untouched', async () => {
    const userId = (await db.user.create({ data: { email: `self-${randomUUID()}@example.invalid`, name: 'self' } })).id;
    const runner = await db.runner.create({
      data: { ownerId: userId, name: 'self-runner', tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [] },
    });
    const ws = await db.workspace.create({ data: { ownerId: userId, runnerId: runner.id, name: 'self-ws', workDir: '/srv/self', enabled: true } });
    const w = managedRunnerWorld(db);
    const s = services(w);
    await startWhenTask(s, userId, ws.id);
    await schedule(s, userId, ws.id);
    assert.equal(await db.managedRunner.count({ where: { ownerId: userId } }), 0, 'no managed row for a self-managed runner');
    assert.deepEqual(await s.demand!.requested(runner.id, 'condition'), { managed: false, comingBack: false }, 'the hook: not managed');

    // The switch off: the hook records nothing for a managed runner either.
    const { ownerId, mapping } = await w.readyRunner('switch-off');
    const { workspaceId } = await cloudWorkspace(mapping, 'switch-off');
    const asleep = await w.putToSleep(ownerId);
    const off = services(w, { gate: MANAGED_RUNNERS_OFF });
    await startWhenTask(off, ownerId, workspaceId);
    await off.schedules.create(owner(ownerId), guard(workspaceId)).catch(() => undefined);
    const after = await w.mappingOf(ownerId);
    assert.equal(after.demandRevision, asleep.demandRevision, 'the switch off: no demand recorded');
    assert.equal(after.desiredState, 'SLEEPING');
  });
});
