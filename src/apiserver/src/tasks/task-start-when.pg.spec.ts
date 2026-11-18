/**
 * A task's startWhen (docs/condition-triggers-design.md §5.2, §6.2; C4), against a real PostgreSQL, through the doors
 * the product uses: TasksService.create writes the task and its condition, ConditionsService.intake takes the runner's
 * samples, the scheduled sweep (dispatchDueScheduledTasks) and execute start the task. One named case each for:
 *
 *   fires-once-and-clears      a task waits OPEN with "Waiting for: <text>" and its newest reading; nothing starts it
 *                              until its condition fires; the sweep then starts it once, the run's brief says it was
 *                              started by a condition and must check again, and the condition ends and the task's
 *                              pointer clears, as runAt clears; a second sweep starts nothing;
 *   held-task-retained         a fired condition on an unassigned task, then on a held one, stays due and is not
 *                              consumed; the sweep starts the task once it can;
 *   task-start-ends-condition  task_start (execute, a person's door) on a task whose condition has not fired starts it,
 *                              without the condition's brief, and ends the condition;
 *   thirty-day-question        a condition that has not fired for 30 days asks the owner once; Keep waiting asks again
 *                              30 days later and not before; Stop ends the condition and leaves the task OPEN, which no
 *                              sweep then starts;
 *   scheduled-page-reads       GET /schedules lists an OPEN task waiting on its startWhen under `waitingTasks`, with the
 *                              newest reading, in its owner's list only and until the task leaves OPEN; the condition's
 *                              read names its runner; the 30-day question names its condition (the iOS client, C6);
 * and: a startWhen beside runAt is refused; a baseline that already holds fires at once; an unfired startWhen vetoes
 * the project's independent auto-run; cancelling the task ends the condition; and the runner is woken when a
 * condition is created and when it ends (probe-handed-out-and-withdrawn-at-once).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-start-when.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { CONDITION_STILL_WAITING_KIND, type ScheduleWaitingTask, type TaskStartWhenInput } from '@orbit/shared';
import { CreatorType, PrismaClient, RunnerStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';

import { ConditionsService } from '../conditions/conditions.service';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RUNNER_WAKE_CHANNEL } from '../realtime/runner-wake';
import { ScheduleReadsService } from '../schedules/schedule-reads.service';
import { SessionsService } from '../sessions/sessions.service';
import { TASK_START_WHEN_AND_RUN_AT } from './task-start-when';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const DAY = 86_400_000;

let db: PrismaClient;
let pg: Client;
let conditions: ConditionsService;
let tasks: TasksService;
let requests: OwnerRequestsService;
const wakes: string[] = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  process.env.DATABASE_URL ??= URL!;
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  // What every replica hears and turns into markRunnerChanged (RealtimeService.onNotify).
  pg.on('notification', (n) => {
    if (n.channel === RUNNER_WAKE_CHANNEL && n.payload) wakes.push((JSON.parse(n.payload) as { r: string }).r);
  });
  await pg.query(`LISTEN ${RUNNER_WAKE_CHANNEL}`);
  db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, publishes);
  conditions = new ConditionsService(prisma, { notify: async () => undefined });
  // TasksService's positional constructor: ConditionsService is its last parameter; the rest are not exercised here.
  const args: unknown[] = new Array(17).fill(undefined);
  args[0] = prisma;
  args[1] = sessions;
  args[2] = publishes;
  args[16] = conditions;
  tasks = new (TasksService as unknown as new (...a: unknown[]) => TasksService)(...args);
  requests = new OwnerRequestsService(prisma, {} as never);
});

after(async () => {
  if (skip) return;
  await db.$disconnect();
  await pg.end();
});

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@start-when.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, workDir: `/srv/${label}`, enabled: true },
  });
  return { ownerId, runnerId, workspaceId };
}

const OSDS: TaskStartWhenInput = {
  text: '3 or more OSDs are in',
  command: 'ceph osd stat -f json | jq .num_in_osds',
  compare: { op: 'GTE', value: 3 },
  intervalSeconds: 300,
  unit: 'in',
  baseline: { value: 2 },
};

async function startWhenTask(
  w: World,
  over: { startWhen?: TaskStartWhenInput; projectId?: string; autoRunWhenReady?: boolean } = {},
) {
  return tasks.create(w.ownerId, {
    title: 'Set the kubernetes pool to 3 copies',
    assigneeId: w.workspaceId,
    // Outside a project a user-filed task settles by its command; inside one, by the project's criterion.
    ...(over.projectId
      ? { completionCriterion: 'EVIDENCE_JUDGMENT' }
      : { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 }),
    provider: 'claude',
    autoRunWhenReady: over.autoRunWhenReady ?? false,
    ...(over.projectId ? { projectId: over.projectId } : {}),
    startWhen: over.startWhen ?? OSDS,
  } as never);
}

/** One sample from the runner that serves the workspace, through the heartbeat's own intake. */
let sampleAt = Date.now();
async function read(w: World, conditionId: string, value: number) {
  sampleAt = Math.max(sampleAt + 1_000, Date.now() + 1_000);
  return conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [
    { conditionId, at: new Date(sampleAt).toISOString(), outcome: 'VALUE', value },
  ]);
}

const sweep = () => (tasks as unknown as { dispatchDueScheduledTasks(): Promise<void> }).dispatchDueScheduledTasks();
const readySweep = () => (tasks as unknown as { reconcileReadyTasks(): Promise<void> }).reconcileReadyTasks();
const runs = (taskId: string) => db.session.count({ where: { taskId, startsTaskWork: true } });
const conditionOf = (taskId: string) => db.condition.findFirstOrThrow({ where: { taskId } });
const pointerOf = async (taskId: string) =>
  (await db.task.findUniqueOrThrow({ where: { id: taskId }, select: { startWhenConditionId: true } })).startWhenConditionId;

/** The brief a run of this task was started with, frozen on its run request. */
async function briefOf(taskId: string): Promise<string> {
  const rows = await db.$queryRaw<Array<{ prompt: string | null }>>`
    SELECT "target"->>'prompt' AS "prompt" FROM "task_run_request"
     WHERE "target"->>'taskId' = ${taskId} ORDER BY "created_at" DESC LIMIT 1`;
  assert.ok(rows[0]?.prompt, 'a run request with a frozen brief');
  return rows[0].prompt!;
}

async function waitForWake(runnerId: string, from: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (wakes.slice(from).includes(runnerId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`runner ${runnerId} was not woken`);
}

test('fires-once-and-clears', { skip, timeout: 120_000 }, async () => {
  const w = await world('fires-once');
  const task = await startWhenTask(w);
  const c = await conditionOf(task.id);
  assert.equal(await pointerOf(task.id), c.id, 'the task points at its condition');
  assert.equal(c.state, 'WAITING');
  assert.equal(c.lastValue, 2, 'the baseline is the first reading');
  assert.equal(c.approvedCommandHash.length, 64, "the command's hash is stored as approved");

  // While it waits: OPEN, with the waiting line, the newest reading and when it was taken.
  await read(w, c.id, 2);
  const waiting = await tasks.get(w.ownerId, task.id) as unknown as {
    status: string; startWhen: { waitingLine: string | null; lastValue: number | null; lastSampleAt: string | null };
    dependencyState: string;
  };
  assert.equal(waiting.status, 'OPEN');
  assert.equal(waiting.startWhen.waitingLine, 'Waiting for: 3 or more OSDs are in');
  assert.equal(waiting.startWhen.lastValue, 2);
  assert.ok(waiting.startWhen.lastSampleAt);
  assert.equal(waiting.dependencyState, 'NONE', 'a condition is not a dependency state');
  await sweep();
  assert.equal(await runs(task.id), 0, 'nothing starts a task whose condition has not fired');

  // It fires: the sweep starts it, once.
  await read(w, c.id, 3);
  assert.equal((await conditionOf(task.id)).state, 'FIRED');
  await sweep();
  assert.equal(await runs(task.id), 1, 'the fired condition started the task');
  const brief = await briefOf(task.id);
  assert.match(brief, /^## Started by a condition/);
  assert.match(brief, /"3 or more OSDs are in" held \(it read 3 in\)/);
  assert.match(brief, /check the condition again yourself/);
  assert.match(brief, /If it no longer holds, say so and end without acting/);

  // ...and the condition then ends, as runAt clears.
  const ended = await conditionOf(task.id);
  assert.equal(ended.state, 'ENDED');
  assert.ok(ended.endedAt);
  assert.equal(await pointerOf(task.id), null, 'the start cleared the pointer, as a start clears runAt');
  await read(w, c.id, 4);
  await sweep();
  await sweep();
  assert.equal(await runs(task.id), 1, 'once: an ended condition starts nothing more');
});

test('held-task-retained', { skip, timeout: 120_000 }, async () => {
  const w = await world('held');
  const task = await startWhenTask(w);
  const c = await conditionOf(task.id);

  // Unassigned when it fires: due, not consumed.
  await db.task.update({ where: { id: task.id }, data: { assigneeId: null } });
  await read(w, c.id, 3);
  await sweep();
  assert.equal(await runs(task.id), 0);
  assert.equal((await conditionOf(task.id)).state, 'FIRED', 'retained, not consumed');
  assert.equal(await pointerOf(task.id), c.id);

  // Assigned again but held: still due, still not consumed.
  await db.task.update({ where: { id: task.id }, data: { assigneeId: w.workspaceId, dispatchHold: true } });
  await sweep();
  assert.equal(await runs(task.id), 0);
  assert.equal((await conditionOf(task.id)).state, 'FIRED');

  // Released: the sweep starts it, and the start ends the condition.
  await db.task.update({ where: { id: task.id }, data: { dispatchHold: false } });
  await sweep();
  assert.equal(await runs(task.id), 1, 'it started once it could');
  assert.equal((await conditionOf(task.id)).state, 'ENDED');
  assert.equal(await pointerOf(task.id), null);
});

test('task-start-ends-condition', { skip, timeout: 120_000 }, async () => {
  const w = await world('task-start');
  const task = await startWhenTask(w);
  const c = await conditionOf(task.id);
  assert.equal(c.state, 'WAITING');
  // A person's start (Run, task_start) ignores the condition.
  const started = await tasks.execute(w.ownerId, task.id);
  assert.equal(started.ok, true);
  assert.equal(await runs(task.id), 1);
  assert.doesNotMatch(await briefOf(task.id), /Started by a condition/, 'a person started it, not the condition');
  // ...and ends it.
  assert.equal((await conditionOf(task.id)).state, 'ENDED');
  assert.equal(await pointerOf(task.id), null);
  await read(w, c.id, 3);
  await sweep();
  assert.equal(await runs(task.id), 1, 'the ended condition fires nothing');
});

test('thirty-day-question', { skip, timeout: 120_000 }, async () => {
  const w = await world('thirty-days');
  const task = await startWhenTask(w);
  const c = await conditionOf(task.id);
  const home = randomUUID();
  // The conversation the card was answered in: where the question is shown (ConditionsService.homeSession).
  await db.condition.update({ where: { id: c.id }, data: { createdFromSessionId: home } });
  const questions = () => db.ownerRequest.findMany({
    where: { conditionId: c.id, kind: CONDITION_STILL_WAITING_KIND }, orderBy: { createdAt: 'asc' },
  });

  assert.equal(await conditions.askStillWaiting(new Date(c.createdAt.getTime() + 29 * DAY)), 0, 'not before 30 days');
  const day31 = new Date(c.createdAt.getTime() + 31 * DAY);
  assert.equal(await conditions.askStillWaiting(day31), 1);
  assert.equal(await conditions.askStillWaiting(day31), 0, 'once');
  assert.equal(await conditions.askStillWaiting(new Date(day31.getTime() + DAY)), 0, 'once, while it is pending');
  const [first] = await questions();
  assert.equal(first.title, 'Still waiting for 3 or more OSDs are in. Keep waiting?');
  assert.equal(first.state, 'PENDING');
  assert.equal(first.askedBySessionId, home);
  assert.deepEqual((first.options as Array<{ label: string }>).map((o) => o.label), ['Keep waiting', 'Stop']);
  assert.equal(await db.conditionEvent.count({ where: { conditionId: c.id, kind: 'ASKED_STILL_WAITING' } }), 1);

  // Keep waiting: asks again 30 days later, and not before.
  await requests.complete(w.ownerId, first.id, { option: 0 });
  const kept = await conditionOf(task.id);
  assert.ok(kept.keepWaitingSince);
  assert.notEqual(kept.state, 'ENDED');
  assert.equal(await conditions.askStillWaiting(new Date(kept.keepWaitingSince!.getTime() + 29 * DAY)), 0);
  assert.equal(await conditions.askStillWaiting(new Date(kept.keepWaitingSince!.getTime() + 30 * DAY + 60_000)), 1);
  const asked = await questions();
  assert.equal(asked.length, 2);
  assert.equal(asked[0].state, 'DONE');

  // Stop: the condition ends, the task stays OPEN and nothing starts it.
  await requests.complete(w.ownerId, asked[1].id, { option: 1 });
  const stopped = await conditionOf(task.id);
  assert.equal(stopped.state, 'ENDED');
  const after = await db.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.status, TaskStatus.OPEN);
  await read(w, c.id, 5);
  await sweep();
  await readySweep();
  assert.equal(await runs(task.id), 0, 'a stopped condition starts nothing');
  const view = await tasks.get(w.ownerId, task.id) as unknown as { startWhen: { waitingLine: string | null; state: string } };
  assert.equal(view.startWhen.state, 'ENDED');
  assert.equal(view.startWhen.waitingLine, null);
  assert.equal(await conditions.askStillWaiting(new Date(Date.now() + 400 * DAY)), 0, 'an ended condition asks nothing');
});

test('a startWhen beside a runAt is refused, and a baseline that already holds fires at once', { skip, timeout: 60_000 }, async () => {
  const w = await world('shape');
  await assert.rejects(
    tasks.create(w.ownerId, {
      title: 'both', assigneeId: w.workspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      runAt: new Date(Date.now() + DAY).toISOString(), startWhen: OSDS,
    } as never),
    (e: unknown) => (e as { response?: { code?: string } }).response?.code === TASK_START_WHEN_AND_RUN_AT,
  );
  await assert.rejects(
    tasks.create(w.ownerId, {
      title: 'no baseline', assigneeId: w.workspaceId, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      startWhen: { ...OSDS, baseline: {} },
    } as never),
    /baseline\.value is required/,
  );
  assert.equal(await db.task.count({ where: { ownerId: w.ownerId } }), 0, 'nothing was written');
  await assert.rejects(
    db.task.update({
      where: { id: (await startWhenTask(w)).id }, data: { runAt: new Date() },
    }),
    /task_run_at_or_start_when_chk/,
  );

  const already = await startWhenTask(w, { startWhen: { ...OSDS, baseline: { value: 3 } } });
  assert.equal((await conditionOf(already.id)).state, 'FIRED', 'it already holds, so it fires at once');
  await sweep();
  assert.equal(await runs(already.id), 1);
});

test('an unfired startWhen vetoes the project auto-run; cancelling the task ends its condition', { skip, timeout: 120_000 }, async () => {
  const w = await world('veto');
  const projectId = randomUUID();
  await db.project.create({
    data: { id: projectId, ownerId: w.ownerId, title: 'veto', coordinatorEnabled: false, startedAt: new Date() },
  });
  await establishProjectContractForPgTest(db, w.ownerId, projectId, `start-when-veto-${RUN}`);
  const plain = await db.task.create({
    data: {
      ownerId: w.ownerId, projectId, assigneeId: w.workspaceId, title: 'control', creatorType: CreatorType.USER,
      creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT', provider: 'claude', autoRunWhenReady: true,
    },
  });
  const waiting = await startWhenTask(w, { projectId, autoRunWhenReady: true });
  await readySweep();
  assert.equal(await runs(plain.id), 1, 'the control: an independent auto-run task in a started project starts');
  assert.equal(await runs(waiting.id), 0, 'its startWhen has not fired: the same veto as a runAt to come');

  await db.task.update({ where: { id: waiting.id }, data: { status: TaskStatus.CANCELLED } });
  assert.equal((await conditionOf(waiting.id)).state, 'ENDED', 'cancelling the task ends its condition');
});

test('probe-handed-out-and-withdrawn-at-once', { skip, timeout: 60_000 }, async () => {
  const w = await world('wake');
  const created = wakes.length;
  const task = await startWhenTask(w);
  await waitForWake(w.runnerId, created);
  const ending = wakes.length;
  await tasks.execute(w.ownerId, task.id);
  assert.equal((await conditionOf(task.id)).state, 'ENDED');
  await waitForWake(w.runnerId, ending);
  // The probe is gone from what the heartbeat hands out.
  assert.deepEqual((await conditions.probesFor(w.runnerId)).map((p) => p.id), []);
});

test('scheduled-page-reads', { skip, timeout: 120_000 }, async () => {
  const w = await world('scheduled-page');
  const other = await world('scheduled-page-other');
  const reads = new ScheduleReadsService(db as unknown as PrismaService);
  const task = await startWhenTask(w);
  const c = await conditionOf(task.id);
  await read(w, c.id, 2);
  await startWhenTask(other);

  type Page = { waitingTasks?: ScheduleWaitingTask[] };
  const page = async (filter: { timeline?: boolean; workspaceId?: string }) =>
    (await reads.list(w.ownerId, filter)) as unknown as Page;
  const list = await page({ timeline: true });
  assert.equal(list.waitingTasks?.length, 1, "the owner's waiting task, and not another account's");
  const row = list.waitingTasks![0];
  assert.equal(row.id, task.id);
  assert.equal(row.title, 'Set the kubernetes pool to 3 copies');
  assert.equal(row.workspaceId, w.workspaceId);
  assert.equal(row.workspaceName, 'scheduled-page-ws');
  assert.equal(row.condition.id, c.id);
  assert.equal(row.condition.text, '3 or more OSDs are in');
  assert.equal(row.condition.unit, 'in');
  assert.equal(row.condition.lastValue, 2);
  assert.ok(row.condition.lastSampleAt, 'the newest reading has its age');
  assert.equal((await page({ timeline: true, workspaceId: other.workspaceId })).waitingTasks?.length, 0,
    'the workspace filter applies');
  assert.equal((await page({})).waitingTasks, undefined, 'only the REST timeline read carries it');

  // The condition's own read names the runner its probes run on: "Every 5 min on scheduled-page-runner".
  assert.equal((await conditions.get(w.ownerId, c.id)).runnerName, 'scheduled-page-runner');

  // The 30-day question carries its condition, which a client reads to name the task.
  await db.condition.update({ where: { id: c.id }, data: { createdFromSessionId: randomUUID() } });
  assert.equal(await conditions.askStillWaiting(new Date(c.createdAt.getTime() + 31 * DAY)), 1);
  const open = await requests.list(w.ownerId, 'open');
  const question = open.requests.find((r) => r.kind === CONDITION_STILL_WAITING_KIND) as { conditionId?: string } | undefined;
  assert.equal(question?.conditionId, c.id);

  // A task that leaves OPEN is no longer waiting, and leaves the page.
  await db.task.update({ where: { id: task.id }, data: { status: TaskStatus.CANCELLED } });
  assert.equal((await page({ timeline: true })).waitingTasks?.length, 0);
});
