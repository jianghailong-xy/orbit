/**
 * A WHEN condition that fires again while it still holds (docs/condition-triggers-design.md §3, §5.1, §6.1; C9),
 * against a real PostgreSQL migrated from empty, on a clock the spec moves, through the real paths: a session's create
 * card and the owner's Create, the runner's samples through ConditionsService.intake, the fire hook
 * ScheduleConditionHook registers, and the run's start through ScheduleRunsService.startDue.
 *
 *   repeat-while-true-fires-again  with repeatSeconds, a FIRED condition whose comparison holds in every sample fires
 *                                  again each time that long has passed since its last FIRED: one FIRED marked repeat
 *                                  and one CONDITION run each; the run block says it is a repeat, when the condition
 *                                  first fired and how many runs it has started since
 *   no-repeat-fires-once           with no repeatSeconds, staying above the line fires nothing more, however long
 *   repeat-over-budget-missed      a repeat past the envelope's runs per week is MISSED OVER_BUDGET, like any firing
 *   repeat-stops-when-rearmed      a false sample short of the re-arm stops the repeats and the clock restarts from the
 *                                  sample that holds again; once re-armed nothing repeats
 *   unknown-does-not-repeat        UNKNOWN never repeats, and the sample that leaves it restarts the clock
 *   create-card-repeat-line        the create card's When block says the repeat in words; shortening it applies at once
 *                                  as a revision; a repeat under 15 minutes, under the interval, or on a startWhen
 *                                  condition is refused
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-when-repeat.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode, scheduleRepeatText, type ConditionSampleReport } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { ConditionsService } from '../conditions/conditions.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { ScheduleAlert } from './schedule-attention';
import { ScheduleConditionHook } from './schedule-condition-hook';
import { ScheduleReadsService } from './schedule-reads.service';
import { ScheduleRunsService, type OpenRunSession, type ScheduleRunSessionPort } from './schedule-runs.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const SECOND = 1000;
const FUTURE = new Date('2100-01-01T00:00:00Z');
const T0 = new Date('2026-11-17T08:00:00Z').getTime();
const t = (seconds: number) => new Date(T0 + seconds * SECOND);
const HOUR = 3600;

let db: PrismaClient;
let pg: Client;
let clockNow = new Date(T0);
const clock = () => clockNow;
let schedules: SchedulesService;
let runs: ScheduleRunsService;
let conditions: ConditionsService;
let reads: ScheduleReadsService;
let opened: OpenRunSession[] = [];
let pushed: ScheduleAlert[] = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // The session door is not under test: an open is recorded with its first turn, which is what the run block is.
  const port: ScheduleRunSessionPort = {
    open: async (input: OpenRunSession) => void opened.push(input),
    land: async () => undefined,
    interrupt: async () => undefined,
    complete: async () => undefined,
    end: async () => undefined,
  } as unknown as ScheduleRunSessionPort;
  const notifier = { notify: async (alert: ScheduleAlert) => void pushed.push(alert) };
  const realtime = { markRunnerChanged: () => undefined };
  schedules = new SchedulesService(prisma, clock, notifier, realtime);
  runs = new ScheduleRunsService(prisma, port, clock, notifier);
  conditions = new ConditionsService(prisma, undefined, clock);
  reads = new ScheduleReadsService(prisma);
  new ScheduleConditionHook(conditions, runs).onModuleInit();
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
  owner: ScheduleActor;
  agent: ScheduleActor;
}

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-repeat.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-gpu`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: FUTURE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/srv/${label}` } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, title: 'chat', prompt: 'p', provider: 'claude',
      engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode: PermissionMode.DEFAULT,
    },
  });
  return { ownerId, runnerId, workspaceId, owner: { kind: 'OWNER', ownerId }, agent: { kind: 'SESSION', ownerId, sessionId } };
}

const COMMAND = 'curl -s -o /dev/null -w "%{http_code}" http://svc.internal/healthz';

/**
 * A guard on a service's health: it fires while the health check reads 500 or more, re-arms once it reads below 300,
 * is checked every 5 min, and, unless `condition` says otherwise, fires again every 2 hours while it stays unhealthy.
 */
function guard(condition: Record<string, unknown> = {}, runsPerWeek = 7): ScheduleCreateInput {
  return {
    intent: 'When the service is unhealthy, look at it and try to fix it',
    title: 'Service health guard',
    prompt: 'Look at why the service is unhealthy and propose a fix.',
    rule: {
      kind: 'WHEN',
      runsPerWeek,
      condition: {
        text: 'The service answers 500 or more', command: COMMAND, compare: { op: 'GTE', value: 500 }, holdSeconds: 0,
        rearm: { op: 'LT', value: 300 }, repeatSeconds: 2 * HOUR, ...condition,
      },
    },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    baseline: { key: 'healthy', summary: 'The service answers 200.' },
  };
}

/** A session asks, and the owner presses Create on the card. */
async function createdByCard(w: World, input = guard()) {
  clockNow = new Date(T0 - 60 * SECOND);
  const asked = await schedules.create(w.agent, input);
  assert.equal(asked.outcome, 'PENDING', "a session's create waits on the card");
  const decided = await schedules.decide(w.owner, asked.outcome === 'PENDING' ? asked.request.id : '', 'ALLOW');
  assert.equal(decided.outcome, 'ALLOWED');
  return decided.schedule!;
}

const conditionOf = (scheduleId: string) => db.condition.findFirstOrThrow({ where: { scheduleId } });

function value(conditionId: string, seconds: number, v: number): ConditionSampleReport {
  return { conditionId, at: t(seconds).toISOString(), outcome: 'VALUE', value: v };
}

function failed(conditionId: string, seconds: number): ConditionSampleReport {
  return { conditionId, at: t(seconds).toISOString(), outcome: 'TIMEOUT' };
}

/** The runner reports samples, one beat each, at their own time. */
async function feed(w: World, ...samples: ConditionSampleReport[]) {
  for (const s of samples) {
    clockNow = new Date(s.at);
    const result = await conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [s]);
    assert.equal(result.stored, 1, 'the runner that serves the workspace has its sample taken');
  }
}

/** Every 5 min from `from` to `to` (inclusive), the same reading. */
async function steady(w: World, conditionId: string, from: number, to: number, v: number) {
  for (let s = from; s <= to; s += 300) await feed(w, value(conditionId, s, v));
}

const runsOf = (scheduleId: string) => db.scheduleRun.findMany({ where: { scheduleId }, orderBy: { plannedAt: 'asc' } });
const firedOf = (conditionId: string) =>
  db.conditionEvent.findMany({ where: { conditionId, kind: 'FIRED' }, orderBy: { at: 'asc' } });

/** The run's session has done its work: it ended with no change (the report path is the schedule's own). */
async function ended(runId: string) {
  // Its first turn reached the engine: a run that never did does not count toward the budget (§4).
  const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.sessionId) {
    // The session door is a stub here, so the run's session is written as its first turn reached the engine.
    const schedule = await db.schedule.findUniqueOrThrow({ where: { id: run.scheduleId } });
    await db.session.upsert({
      where: { id: run.sessionId },
      create: {
        id: run.sessionId, ownerId: schedule.ownerId, creatorId: schedule.ownerId, workspaceId: schedule.workspaceId, title: 'run',
        prompt: 'p', provider: 'claude', engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
        permissionMode: PermissionMode.DEFAULT, scheduleRunId: run.id,
      },
      update: {},
    });
    await db.conversationTurn.upsert({
      where: { sessionId_clientTurnId: { sessionId: run.sessionId, clientTurnId: `initial-${run.sessionId}` } },
      create: { sessionId: run.sessionId, seq: 1, clientTurnId: `initial-${run.sessionId}`, content: 'x', status: 'IN_FLIGHT', deliveredAt: clockNow },
      update: { deliveredAt: clockNow },
    });
  }
  await db.scheduleRun.update({ where: { id: runId }, data: { state: 'NO_CHANGE', endedAt: clockNow } });
}

function code(error: unknown): string | undefined {
  const r = (error as { getResponse?: () => unknown }).getResponse?.();
  return (r as { code?: string } | undefined)?.code;
}

test('repeat-while-true-fires-again', { skip }, async () => {
  const w = await world('repeat');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);
  assert.equal(c.repeatSeconds, 2 * HOUR, "the create's repeat is on the condition");

  // Unhealthy at 0: the crossing fires.
  await feed(w, value(c.id, 0, 503));
  let all = await runsOf(schedule.id);
  assert.equal(all.length, 1, 'the crossing starts one run');
  assert.deepEqual((await runs.startDue(25, schedule.id)).map((s) => s.outcome), ['STARTED']);
  await ended(all[0].id);

  // The fix failed: it stays unhealthy. Nothing more until 2 hours have passed since that FIRED.
  await steady(w, c.id, 300, 2 * HOUR - 300, 503);
  assert.equal((await runsOf(schedule.id)).length, 1, 'nothing repeats before repeatSeconds have passed');
  await feed(w, value(c.id, 2 * HOUR, 502));
  all = await runsOf(schedule.id);
  assert.equal(all.length, 2, 'two hours later, still unhealthy and not re-armed: it fires again');
  assert.equal(all[1].trigger, 'CONDITION');
  assert.equal(all[1].plannedAt.toISOString(), t(2 * HOUR).toISOString(), "planned at the repeating sample's time");
  let fired = await firedOf(c.id);
  assert.deepEqual(fired.map((e) => e.repeat), [false, true], 'the second FIRED is marked a repeat');
  assert.equal(fired[1].runId, all[1].id, 'the repeat FIRED names its run');
  const row = await conditionOf(schedule.id);
  assert.equal(row.state, 'FIRED');
  assert.equal(row.armed, false, 'a repeat does not re-arm');
  assert.equal(row.firedAt?.toISOString(), t(0).toISOString(), 'firedAt stays at the crossing');

  // The run block of a repeat says so.
  opened = [];
  assert.deepEqual((await runs.startDue(25, schedule.id)).map((s) => s.outcome), ['STARTED']);
  const turn = opened[0].prompt;
  assert.match(turn, /Run 2 of "Service health guard", fired 2026-11-17T10:00:00Z/);
  assert.match(
    turn,
    /This is a repeat: the condition first fired at 2026-11-17T08:00:00Z and has not re-armed since\. 1 run has started from it since then, before this one\./,
  );
  await ended(all[1].id);

  // And again two hours after the repeat: counted from the last FIRED, not the crossing.
  await steady(w, c.id, 2 * HOUR + 300, 4 * HOUR - 300, 503);
  assert.equal((await runsOf(schedule.id)).length, 2);
  await feed(w, value(c.id, 4 * HOUR, 503));
  all = await runsOf(schedule.id);
  assert.equal(all.length, 3, 'each further repeatSeconds fires once more');
  opened = [];
  await runs.startDue(25, schedule.id);
  assert.match(opened[0].prompt, /2 runs have started from it since then, before this one\./);
  fired = await firedOf(c.id);
  assert.deepEqual(fired.map((e) => [e.at.toISOString(), e.repeat]), [
    [t(0).toISOString(), false], [t(2 * HOUR).toISOString(), true], [t(4 * HOUR).toISOString(), true],
  ]);
  const view = await conditions.get(w.ownerId, c.id);
  assert.equal(view.repeatSeconds, 2 * HOUR);
  assert.deepEqual(view.events.filter((e) => e.kind === 'FIRED').map((e) => e.repeat), [true, true, false], 'the read marks repeats');
});

test('no-repeat-fires-once', { skip }, async () => {
  const w = await world('once');
  const schedule = await createdByCard(w, guard({ repeatSeconds: null }));
  const c = await conditionOf(schedule.id);
  assert.equal(c.repeatSeconds, null);
  await feed(w, value(c.id, 0, 503));
  assert.equal((await runsOf(schedule.id)).length, 1, 'the crossing fires');
  await steady(w, c.id, 300, 6 * HOUR, 503);
  assert.equal((await runsOf(schedule.id)).length, 1, 'six hours unhealthy with no repeat: nothing more');
  assert.equal((await firedOf(c.id)).length, 1);
  const row = await conditionOf(schedule.id);
  assert.equal(row.state, 'FIRED');
  assert.equal(row.repeatFrom, null, 'no repeat clock without repeatSeconds');
});

test('repeat-over-budget-missed', { skip }, async () => {
  const w = await world('budget');
  const schedule = await createdByCard(w, guard({ repeatSeconds: HOUR }, 1));
  const c = await conditionOf(schedule.id);
  pushed = [];

  await feed(w, value(c.id, 0, 503));
  assert.deepEqual((await runs.startDue(25, schedule.id)).map((s) => s.outcome), ['STARTED'], 'the crossing starts');
  const [first] = await runsOf(schedule.id);
  await ended(first.id);

  await steady(w, c.id, 300, HOUR, 503);
  const all = await runsOf(schedule.id);
  assert.equal(all.length, 2, 'the repeat over budget still writes its run');
  assert.deepEqual((await runs.startDue(25, schedule.id)).map((s) => s.outcome), ['MISSED']);
  const second = await db.scheduleRun.findUniqueOrThrow({ where: { id: all[1].id } });
  assert.equal(second.trigger, 'CONDITION');
  assert.equal(second.state, 'MISSED');
  assert.equal(second.failureReason, 'OVER_BUDGET', 'a repeat over budget is MISSED OVER_BUDGET');
  assert.equal(second.startedAt, null, 'nothing was started');
  assert.equal(pushed.filter((a) => a.kind === 'OVER_BUDGET' && a.scheduleId === schedule.id).length, 1, 'the owner is told');
  assert.deepEqual((await firedOf(c.id)).map((e) => e.repeat), [false, true]);
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).state, 'ACTIVE', 'the schedule goes on');
});

test('repeat-stops-when-rearmed', { skip }, async () => {
  const w = await world('rearm');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);

  await feed(w, value(c.id, 0, 503));
  await steady(w, c.id, 300, HOUR, 503);
  // A false sample short of the re-arm (400: not 500 or more, not below 300) stops the repeats.
  await feed(w, value(c.id, HOUR + 300, 400));
  let row = await conditionOf(schedule.id);
  assert.equal(row.state, 'FIRED', 'not re-armed');
  assert.equal(row.repeatFrom, null, 'the repeats stop');
  // It holds again at 1:10: the clock restarts from that sample, so 2:00 (two hours after the FIRED) fires nothing.
  await steady(w, c.id, HOUR + 600, 2 * HOUR, 503);
  assert.equal((await conditionOf(schedule.id)).repeatFrom?.toISOString(), t(HOUR + 600).toISOString(), 'restarted from the sample that held again');
  await steady(w, c.id, 2 * HOUR + 300, 3 * HOUR + 300, 503);
  assert.equal((await runsOf(schedule.id)).length, 1, 'two hours from the restart have not passed yet');
  await feed(w, value(c.id, 3 * HOUR + 600, 503));
  assert.equal((await runsOf(schedule.id)).length, 2, 'two hours after the restart, it fires again');
  assert.deepEqual((await firedOf(c.id)).map((e) => [e.at.toISOString(), e.repeat]), [
    [t(0).toISOString(), false], [t(3 * HOUR + 600).toISOString(), true],
  ]);

  // Healthy again: re-armed, and nothing repeats however long it stays healthy.
  await feed(w, value(c.id, 3 * HOUR + 900, 200));
  row = await conditionOf(schedule.id);
  assert.equal(row.state, 'WAITING');
  assert.equal(row.armed, true);
  assert.equal(row.repeatFrom, null);
  await steady(w, c.id, 3 * HOUR + 1200, 8 * HOUR, 200);
  assert.equal((await runsOf(schedule.id)).length, 2, 'once re-armed nothing repeats');
  // A new crossing fires as a crossing, not a repeat.
  await feed(w, value(c.id, 8 * HOUR + 300, 503));
  assert.deepEqual((await firedOf(c.id)).map((e) => e.repeat), [false, true, false]);
});

test('unknown-does-not-repeat', { skip }, async () => {
  const w = await world('unknown');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);

  await feed(w, value(c.id, 0, 503));
  await steady(w, c.id, 300, HOUR, 503);
  // Three failed checks: UNKNOWN. It stays unreadable past two hours since the FIRED: nothing repeats.
  for (let s = HOUR + 300; s <= 3 * HOUR; s += 300) await feed(w, failed(c.id, s));
  let row = await conditionOf(schedule.id);
  assert.equal(row.state, 'UNKNOWN');
  assert.equal(row.repeatFrom, null);
  assert.equal((await runsOf(schedule.id)).length, 1, 'UNKNOWN never repeats');
  // It reads again, still unhealthy: back to FIRED, and the clock restarts from that sample, not from the FIRED.
  await feed(w, value(c.id, 3 * HOUR + 300, 503));
  row = await conditionOf(schedule.id);
  assert.equal(row.state, 'FIRED', 'back by that sample: not armed, so FIRED');
  assert.equal(row.repeatFrom?.toISOString(), t(3 * HOUR + 300).toISOString(), 'leaving UNKNOWN restarts the clock');
  assert.equal((await runsOf(schedule.id)).length, 1, 'leaving UNKNOWN fires nothing');
  await steady(w, c.id, 3 * HOUR + 600, 5 * HOUR, 503);
  assert.equal((await runsOf(schedule.id)).length, 1);
  await feed(w, value(c.id, 5 * HOUR + 300, 503));
  assert.equal((await runsOf(schedule.id)).length, 2, 'two hours after reading again, it repeats');
  // A failed check short of UNKNOWN neither completes a repeat nor breaks one.
  await steady(w, c.id, 5 * HOUR + 600, 7 * HOUR - 300, 503);
  await feed(w, failed(c.id, 7 * HOUR + 300));
  assert.equal((await runsOf(schedule.id)).length, 2, 'a failed check completes no repeat');
  await feed(w, value(c.id, 7 * HOUR + 600, 503));
  assert.equal((await runsOf(schedule.id)).length, 3, 'the next reading that holds does');
});

test('create-card-repeat-line', { skip }, async () => {
  const w = await world('card');
  const asked = await schedules.create(w.agent, guard());
  assert.ok(asked.outcome === 'PENDING');
  const [card] = (await reads.requests(w.ownerId)).requests.filter((r) => r.id === asked.request.id);
  assert.ok(card.kind === 'CREATE');
  assert.equal(card.when?.condition?.repeat, 'And again every 2 hours while it stays that way.', 'the When block says the repeat in words');
  assert.equal(card.when?.condition?.text, 'The service answers 500 or more');
  assert.equal(scheduleRepeatText(3600), 'And again every hour while it stays that way.');
  assert.equal(scheduleRepeatText(5400), 'And again every 90 minutes while it stays that way.');
  assert.equal(scheduleRepeatText(null), null, 'no repeat, no line');

  const once = await schedules.create(w.agent, guard({ repeatSeconds: null }));
  assert.ok(once.outcome === 'PENDING');
  const [plain] = (await reads.requests(w.ownerId)).requests.filter((r) => r.id === once.request.id);
  assert.ok(plain.kind === 'CREATE');
  assert.equal(plain.when?.condition?.repeat, null, 'a condition with no repeat has no repeat line');

  // Refusals: under 15 minutes, under the interval.
  await assert.rejects(schedules.create(w.agent, guard({ repeatSeconds: 600 })), (e: unknown) => code(e) === 'SCHEDULE_RULE_INVALID');
  await assert.rejects(
    schedules.create(w.agent, guard({ repeatSeconds: 900, intervalSeconds: 1800 })),
    (e: unknown) => code(e) === 'SCHEDULE_RULE_INVALID',
    'a repeat shorter than the interval is refused',
  );

  // Shortening it later applies at once, as a revision, and the condition follows.
  const decided = await schedules.decide(w.owner, asked.request.id, 'ALLOW');
  const schedule = decided.schedule!;
  const shorter = await schedules.update(w.agent, schedule.id, { rule: { kind: 'WHEN', condition: { repeatSeconds: HOUR } } });
  assert.equal(shorter.outcome, 'APPLIED', 'a shorter repeat applies at once: the weekly budget already bounds it');
  const revision = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: schedule.id, revision: 2 } });
  assert.ok('rule' in (revision.fields as { after: object }).after, 'recorded as a revision of the rule');
  assert.equal((await conditionOf(schedule.id)).repeatSeconds, HOUR);

  // A startWhen condition with a repeat is refused, by the create and by the schema.
  // Refused before anything is written, so the task it names need not exist.
  const taskId = randomUUID();
  await assert.rejects(
    db.$transaction((tx) => conditions.createCondition(tx, {
      ownerId: w.ownerId, workspaceId: w.workspaceId, command: 'ceph osd stat -f json | jq .num_in_osds',
      compare: { op: 'GTE', value: 3 }, text: '3 or more OSDs are in', taskId, repeatSeconds: HOUR, approvedAt: clockNow,
    })),
    /only a schedule's WHEN condition repeats/,
  );
  const c = await conditionOf(schedule.id);
  await assert.rejects(
    db.$executeRaw`UPDATE "condition" SET "repeat_seconds" = 600 WHERE "id" = ${c.id}::uuid`,
    /condition_repeat_chk/,
    'the schema refuses a repeat under 15 minutes',
  );
});
