/**
 * A schedule's WHEN rule (docs/condition-triggers-design.md §3, §5.2, §6.1; C3), against a real PostgreSQL migrated
 * from empty, on a clock the spec moves, through the real paths: a session's create card and the owner's Create, the
 * runner's samples through ConditionsService.intake, the fire hook ScheduleConditionHook registers, and the run's
 * start through ScheduleRunsService.startDue.
 *
 *   one-run-per-firing          a firing inserts exactly one run, trigger CONDITION, planned at the firing sample's
 *                               time; staying above the line starts nothing more; after its re-arm a second crossing
 *                               starts a second; the run block states the firing; the time worker passes it over
 *   over-budget-missed          a firing past the envelope's runs per week is MISSED OVER_BUDGET, the owner is told,
 *                               and the condition still waits for its re-arm
 *   command-change-needs-allow  a new probe command waits on a PROBE_COMMAND card and the runner keeps the approved
 *                               one until the owner's Allow; text, interval and re-arm apply at once as revisions
 *   pause-withdraws-the-probe   pausing or deleting ends the condition and withdraws the probe, resuming brings it
 *                               back without reading as silence, and each marks the runner changed
 *   create-card-and-views       the card's When lines, the baseline the create requires, and the reading a list shows
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-when.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode, type ConditionSampleReport } from '@orbit/shared';
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
let marked: string[] = [];

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
  const realtime = { markRunnerChanged: (ids: string | readonly string[]) => void marked.push(...(typeof ids === 'string' ? [ids] : ids)) };
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
  await db.user.create({ data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-when.invalid`, name: label, passwordHash: 'x' } });
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

const COMMAND = 'ceph df -f json | jq .stats.total_used_raw_ratio';
const hash = (command: string) => createHash('sha256').update(command, 'utf8').digest('hex');

function guard(over: Partial<ScheduleCreateInput> = {}, condition: Record<string, unknown> = {}, runsPerWeek = 3): ScheduleCreateInput {
  return {
    intent: 'Tell me when Ceph is above 90% and look at what can be cleared',
    title: 'Ceph capacity guard',
    prompt: 'Look at what is using the space and propose what to clear.',
    rule: {
      kind: 'WHEN',
      runsPerWeek,
      condition: {
        text: 'Raw used above 90%', command: COMMAND, compare: { op: 'GT', value: 90 }, holdSeconds: 300,
        rearm: { op: 'LT', value: 85 }, unit: '%', ...condition,
      },
    },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    baseline: { key: 'below-90', summary: 'Raw used is 6.9%. Nothing to report.' },
    ...over,
  };
}

/** A session asks, and the owner presses Create on the card. */
async function createdByCard(w: World, input = guard()) {
  const asked = await schedules.create(w.agent, input);
  assert.equal(asked.outcome, 'PENDING', "a session's create waits on the card");
  const decided = await schedules.decide(w.owner, asked.outcome === 'PENDING' ? asked.request.id : '', 'ALLOW');
  assert.equal(decided.outcome, 'ALLOWED');
  return decided.schedule!;
}

async function conditionOf(scheduleId: string) {
  return db.condition.findFirstOrThrow({ where: { scheduleId } });
}

function value(conditionId: string, seconds: number, v: number): ConditionSampleReport {
  return { conditionId, at: t(seconds).toISOString(), outcome: 'VALUE', value: v };
}

/** The runner reports samples, one beat each, at their own time. */
async function feed(w: World, ...samples: ConditionSampleReport[]) {
  for (const s of samples) {
    clockNow = new Date(s.at);
    const result = await conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [s]);
    assert.equal(result.stored, 1, 'the runner that serves the workspace has its sample taken');
  }
}

const runsOf = (scheduleId: string) => db.scheduleRun.findMany({ where: { scheduleId }, orderBy: { plannedAt: 'asc' } });

/** The run's session has done its work: it ended with no change (the report path is the schedule's own, tested elsewhere). */
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

test('one-run-per-firing', { skip }, async () => {
  const w = await world('firing');
  const schedule = await createdByCard(w);
  assert.equal(schedule.nextDueAt, null, 'a WHEN schedule has no next slot');
  const c = await conditionOf(schedule.id);
  assert.equal(c.state, 'WAITING');
  assert.equal(c.approvedCommandHash, hash(COMMAND), "Create approved the command's hash");
  assert.equal(schedule.envelopeCommandHash, hash(COMMAND), "the envelope holds the approved command's hash");
  assert.equal((schedule.rule as { conditionId?: string }).conditionId, c.id, 'the rule names the condition written with it');

  // 80 → 93 (holding) → 95 after 5 min: one firing.
  await feed(w, value(c.id, 0, 80), value(c.id, 300, 93));
  assert.equal((await runsOf(schedule.id)).length, 0, 'holding starts nothing');
  await feed(w, value(c.id, 600, 95));
  let all = await runsOf(schedule.id);
  assert.equal(all.length, 1, 'one firing, one run');
  assert.equal(all[0].trigger, 'CONDITION');
  assert.equal(all[0].plannedAt.toISOString(), t(600).toISOString(), "planned at the firing sample's time");
  assert.equal(all[0].state, 'QUEUED');
  const event = await db.conditionEvent.findFirstOrThrow({ where: { conditionId: c.id, kind: 'FIRED' } });
  assert.equal(event.runId, all[0].id, 'the FIRED event names its run');

  // Staying above the line fires nothing more, and the time worker passes the schedule over.
  await feed(w, value(c.id, 900, 97), value(c.id, 1200, 99));
  assert.equal((await runsOf(schedule.id)).length, 1, 'staying above the line starts no second run');
  const fired = await runs.fireDue(200);
  assert.equal(fired.filter((f) => f.scheduleId === schedule.id).length, 0, 'the time worker passes a WHEN schedule over');

  // The run starts through the schedule's own start, and its block states the firing.
  opened = [];
  const started = await runs.startDue(25, schedule.id);
  assert.deepEqual(started.map((s) => s.outcome), ['STARTED']);
  const turn = opened[0].prompt;
  assert.match(turn, /Run 1 of "Ceph capacity guard", fired 2026-11-17T08:10:00Z/);
  assert.match(turn, /Fired because: "Raw used above 90%"\. The reading was 95% at 2026-11-17T08:10:00Z\./);
  assert.match(turn, /It has held since 2026-11-17T08:05:00Z \(5 min\)\./);
  assert.match(turn, /Recent samples, newest first:\n {4}2026-11-17T08:10:00Z {2}95%\n {4}2026-11-17T08:05:00Z {2}93%\n {4}2026-11-17T08:00:00Z {2}80%/);
  assert.match(turn, /Already reported[^\n]*\n {4}below-90 {2}baseline/, "the create's baseline is already told");
  await ended(all[0].id);

  // Back below the re-arm line, then a second crossing: a second run, and only one.
  await feed(w, value(c.id, 1500, 84));
  assert.equal((await conditionOf(schedule.id)).state, 'WAITING', 'ready again below 85%');
  await feed(w, value(c.id, 1800, 92), value(c.id, 2100, 93));
  all = await runsOf(schedule.id);
  assert.equal(all.length, 2, 'the second crossing starts the second run');
  assert.equal(all[1].trigger, 'CONDITION');
  assert.equal(all[1].plannedAt.toISOString(), t(2100).toISOString());
  assert.deepEqual(
    (await db.conditionEvent.findMany({ where: { conditionId: c.id }, orderBy: { at: 'asc' } })).map((e) => e.kind),
    ['FIRED', 'READY_AGAIN', 'FIRED'],
  );
});

test('over-budget-missed', { skip }, async () => {
  const w = await world('budget');
  const schedule = await createdByCard(w, guard({}, { holdSeconds: 0, rearm: null }, 1));
  assert.equal(schedule.envelopeRunsPerWeek, 1);
  const c = await conditionOf(schedule.id);
  pushed = [];

  await feed(w, value(c.id, 0, 95));
  assert.deepEqual((await runs.startDue(25, schedule.id)).map((s) => s.outcome), ['STARTED'], 'the first firing starts');
  const [first] = await runsOf(schedule.id);
  await ended(first.id);

  // Ready again (no re-arm: as soon as it no longer holds), and a second crossing inside the same 7 days.
  await feed(w, value(c.id, 300, 80), value(c.id, 600, 96));
  const all = await runsOf(schedule.id);
  assert.equal(all.length, 2, 'the firing over budget still writes its run');
  assert.deepEqual((await runs.startDue(25, schedule.id)).map((s) => s.outcome), ['MISSED']);
  const second = await db.scheduleRun.findUniqueOrThrow({ where: { id: all[1].id } });
  assert.equal(second.trigger, 'CONDITION');
  assert.equal(second.state, 'MISSED');
  assert.equal(second.failureReason, 'OVER_BUDGET', 'a firing over budget is recorded MISSED OVER_BUDGET');
  assert.equal(second.startedAt, null, 'nothing was started');
  assert.equal(pushed.filter((a) => a.kind === 'OVER_BUDGET' && a.scheduleId === schedule.id).length, 1, 'the owner is told once');
  const after = await conditionOf(schedule.id);
  assert.equal(after.state, 'FIRED');
  assert.equal(after.armed, false, 'the condition waits for its re-arm either way');
  const sched = await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } });
  assert.equal(sched.state, 'ACTIVE', 'the schedule goes on');

  // Still above the line: nothing more is written.
  await feed(w, value(c.id, 900, 97));
  assert.equal((await runsOf(schedule.id)).length, 2);
});

test('command-change-needs-allow', { skip }, async () => {
  const w = await world('command');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);
  marked = [];

  // Text, interval and re-arm: inside the envelope, applied at once, each a revision, and the condition follows.
  const words = await schedules.update(w.agent, schedule.id, {
    rule: { kind: 'WHEN', condition: { text: 'Raw used above 90 percent', intervalSeconds: 120, rearm: { op: 'LT', value: 80 } } },
  });
  assert.equal(words.outcome, 'APPLIED', 'text, interval and re-arm apply at once');
  const revision = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: schedule.id, revision: 2 } });
  assert.equal(revision.changedBy, 'SESSION');
  assert.ok('rule' in (revision.fields as { after: object }).after, 'recorded as a revision of the rule, which Undo reads');
  let row = await conditionOf(schedule.id);
  assert.equal(row.text, 'Raw used above 90 percent');
  assert.equal(row.intervalSeconds, 120);
  assert.equal(row.rearmValue, 80);
  assert.equal(row.probeCommand, COMMAND, 'the command is untouched');
  assert.ok(marked.includes(w.runnerId), "a change to the probe's interval marks the runner changed");
  await assert.rejects(
    schedules.update(w.agent, schedule.id, { rule: { kind: 'WHEN', condition: { intervalSeconds: 30 } } }),
    (e: unknown) => code(e) === 'SCHEDULE_RULE_INVALID',
    'an interval under 60 s is refused',
  );

  // A new command: a PROBE_COMMAND card, and nothing changes until the owner's Allow.
  const NEW = 'ceph df -f json | jq .stats.total_used_raw_ratio*100';
  const asked = await schedules.update(w.agent, schedule.id, { rule: { kind: 'WHEN', condition: { command: NEW } } });
  assert.equal(asked.outcome, 'PENDING', 'a change of command waits for Allow');
  assert.ok(asked.outcome === 'PENDING');
  assert.deepEqual(asked.request.widens, ['PROBE_COMMAND']);
  row = await conditionOf(schedule.id);
  assert.equal(row.probeCommand, COMMAND);
  assert.equal(row.approvedCommandHash, hash(COMMAND));
  let probes = await conditions.probesFor(w.runnerId);
  assert.deepEqual(probes.map((p) => [p.command, p.commandHash]), [[COMMAND, hash(COMMAND)]], 'the runner keeps the approved command');
  const [card] = (await reads.requests(w.ownerId)).requests.filter((r) => r.id === asked.request.id);
  assert.equal(card.kind, 'UPDATE');
  assert.deepEqual(card.envelope?.widens, ['PROBE_COMMAND']);

  // The run's own session cannot widen it either; and a session cannot decide.
  await assert.rejects(schedules.decide(w.agent, asked.request.id, 'ALLOW'), (e: unknown) => code(e) === 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');

  marked = [];
  clockNow = t(3600);
  const allowed = await schedules.decide(w.owner, asked.request.id, 'ALLOW');
  assert.equal(allowed.outcome, 'ALLOWED');
  row = await conditionOf(schedule.id);
  assert.equal(row.probeCommand, NEW);
  assert.equal(row.approvedCommandHash, hash(NEW), "Allow approves the new command's hash");
  assert.equal(row.approvedAt.toISOString(), t(3600).toISOString());
  assert.equal(row.id, c.id, 'the same condition');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: schedule.id } })).envelopeCommandHash, hash(NEW));
  probes = await conditions.probesFor(w.runnerId);
  assert.deepEqual(probes.map((p) => [p.command, p.commandHash]), [[NEW, hash(NEW)]]);
  assert.ok(marked.includes(w.runnerId), 'the runner is marked changed, so it is handed the new probe at once');

  // Going back to the old command is a change of command too: it waits again.
  const back = await schedules.update(w.agent, schedule.id, { rule: { kind: 'WHEN', condition: { command: COMMAND } } });
  assert.equal(back.outcome, 'PENDING');
});

test('pause-withdraws-the-probe', { skip }, async () => {
  const w = await world('pause');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);
  assert.equal((await conditions.probesFor(w.runnerId)).length, 1);

  marked = [];
  clockNow = t(100);
  await schedules.pause(w.owner, schedule.id);
  assert.equal((await conditionOf(schedule.id)).state, 'ENDED', 'pausing ends the condition');
  assert.equal((await conditions.probesFor(w.runnerId)).length, 0, 'the runner stops being sent the probe');
  assert.deepEqual(marked, [w.runnerId], 'and is marked changed, so the probe is withdrawn at once');
  const refused = await conditions.intake({ id: w.runnerId, ownerId: w.ownerId }, [value(c.id, 200, 99)]);
  assert.equal(refused.refused, 1, "a sample of a paused schedule's condition is not taken");

  marked = [];
  clockNow = t(86_400);
  await schedules.resume(w.owner, schedule.id);
  const back = await conditionOf(schedule.id);
  assert.equal(back.state, 'WAITING', 'resuming brings it back, waiting');
  assert.equal(back.armed, true);
  assert.equal(back.resumedAt?.toISOString(), t(86_400).toISOString());
  assert.equal((await conditions.probesFor(w.runnerId)).length, 1);
  assert.deepEqual(marked, [w.runnerId]);
  clockNow = t(86_400 + 60);
  // The sweep covers every condition in the database (the earlier cases' ones go silent a day later); this one stays.
  await conditions.sweep();
  assert.equal((await conditionOf(schedule.id)).state, 'WAITING', 'a resume does not read as a runner gone silent');
  clockNow = t(86_400 + 3 * 300);
  await conditions.sweep();
  assert.equal((await conditionOf(schedule.id)).state, 'UNKNOWN', 'three intervals with no sample after the resume do');

  marked = [];
  await schedules.remove(w.owner, schedule.id);
  assert.equal((await conditionOf(schedule.id)).state, 'ENDED', 'deleting ends it');
  assert.equal((await conditions.probesFor(w.runnerId)).length, 0);
  assert.deepEqual(marked, [w.runnerId]);
});

test('create-card-and-views', { skip }, async () => {
  const w = await world('views');
  const { baseline: _baseline, ...noBaseline } = guard();
  await assert.rejects(
    schedules.create(w.agent, noBaseline),
    (e: unknown) => code(e) === 'SCHEDULE_BASELINE_REQUIRED',
    'a WHEN rule needs the baseline reading',
  );
  await assert.rejects(
    schedules.create(w.agent, guard({}, { compare: { op: 'GT' } })),
    (e: unknown) => code(e) === 'SCHEDULE_RULE_INVALID',
  );
  const asked = await schedules.create(w.agent, guard({}, { holdSeconds: 600 }));
  assert.ok(asked.outcome === 'PENDING');
  assert.equal(await db.condition.count({ where: { ownerId: w.ownerId } }), 0, 'nothing is written before Create');
  const [card] = (await reads.requests(w.ownerId)).requests;
  assert.equal(card.kind, 'CREATE');
  assert.ok(card.kind === 'CREATE');
  assert.deepEqual(card.when?.condition, {
    text: 'Raw used above 90% for 10 min',
    detail: 'Fires again only after it drops below 85%. Checked every 5 min on views-gpu, no model.',
    command: COMMAND,
    repeat: null,
    // A self-managed runner: the condition keeps nothing awake (managed-runner-condition.pg.spec.ts has the cloud line).
    awake: null,
  });
  assert.equal(card.when?.text, 'Raw used above 90% for 10 min');
  assert.equal(card.costs?.text, 'Up to 3 runs a week, 30 min each', 'Costs still counts runs a week');
  assert.equal(card.today?.text, 'Raw used is 6.9%. Nothing to report.');

  const decided = await schedules.decide(w.owner, asked.request.id, 'ALLOW');
  const c = await conditionOf(decided.schedule!.id);
  await feed(w, value(c.id, 0, 6.9));
  const list = await reads.list(w.ownerId);
  const row = list.schedules.find((s) => s.id === decided.schedule!.id)!;
  assert.equal(row.ruleText, 'Raw used above 90%');
  assert.deepEqual(row.condition, {
    id: c.id, text: 'Raw used above 90%', unit: '%', state: 'WAITING', lastValue: 6.9, lastSampleAt: t(0).toISOString(),
  });
  const detail = await reads.get(w.ownerId, decided.schedule!.id);
  assert.equal(detail.schedule.condition?.lastValue, 6.9);
  assert.equal(detail.readBack, 'When raw used above 90% · Look at what is using the space and propose what to clear.');
});
