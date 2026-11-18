/**
 * A WHEN schedule's firing always tells the owner, once (docs/condition-triggers-design.md §5.2, §6.1; G1), against a
 * real PostgreSQL migrated from empty, on a clock the spec moves, through the real paths: a session's create card and
 * the owner's Create, the runner's samples through ConditionsService.intake, the fire hook, the run's start through
 * ScheduleRunsService.startDue, its report through ScheduleRunsService.report, and a LAND run's landing through
 * landReportedRuns.
 *
 *   condition-run-known-key-notifies   a CONDITION run's CHANGED report under a known key (the create's baseline)
 *                                      pushes once, naming the schedule, the condition's words and the firing reading;
 *                                      the finding row is refreshed, not duplicated; a new key pushes once too, never
 *                                      as a second FINDING banner
 *   condition-run-no-change-notifies   a CONDITION run's NO_CHANGE report pushes once: the condition fired and the run
 *                                      found nothing to report; no finding is written
 *   condition-firing-one-push          a firing whose run is MISSED OVER_BUDGET, FAILED by its report, or FAILED
 *                                      APPROVAL_TIMEOUT is told by that outcome's notice alone; a LAND run is told when
 *                                      its landing settles, and a failed landing only by its failure; a repeat firing
 *                                      is its own firing with its own push
 *   timed-run-unchanged                a timed (MANUAL) run's NO_CHANGE and known-key CHANGED push nothing, and a new key
 *                                      pushes the FINDING banner once, as before
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-when-notify.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode, type ConditionSampleReport } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { Client } from 'pg';

import { ConditionsService } from '../conditions/conditions.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { ScheduleAlert } from './schedule-attention';
import { ScheduleConditionHook } from './schedule-condition-hook';
import { ScheduleRunsService, type OpenRunSession, type ScheduleRunSessionPort } from './schedule-runs.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const SECOND = 1000;
const HOUR = 3600;
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
let pushed: ScheduleAlert[] = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // The session door is not under test: an open writes the run's session row, which is what the report checks.
  const port: ScheduleRunSessionPort = {
    open: async (input: OpenRunSession) => {
      await db.session.create({
        data: {
          id: input.sessionId, ownerId: input.ownerId, creatorId: input.ownerId, workspaceId: input.workspaceId,
          title: input.title, prompt: input.prompt, provider: 'claude', engine: 'claude', providerBuiltin: true,
          dispatchOrigin: SessionDispatchOrigin.USER, permissionMode: PermissionMode.DEFAULT,
          runSource: SessionRunSource.SCHEDULE, scheduleRunId: input.scheduleRunId,
        },
      });
    },
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
  await db.user.create({ data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-when-notify.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-gpu`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: FUTURE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/srv/${label}`,
      repoUrl: 'https://github.com/example/repo.git', enableWorktree: true,
    },
  });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, title: 'chat', prompt: 'p', provider: 'claude',
      engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode: PermissionMode.DEFAULT,
    },
  });
  return { ownerId, runnerId, workspaceId, owner: { kind: 'OWNER', ownerId }, agent: { kind: 'SESSION', ownerId, sessionId } };
}

const COMMAND = 'ceph df -f json | jq .stats.total_used_raw_ratio';
const BASELINE = 'ceph-raw-used-proof@0.0812';

function guard(over: Partial<ScheduleCreateInput> = {}, condition: Record<string, unknown> = {}, runsPerWeek = 7): ScheduleCreateInput {
  return {
    intent: 'Tell me when Ceph is above 90% and look at what can be cleared',
    title: 'Ceph capacity guard',
    prompt: 'Look at what is using the space and propose what to clear.',
    rule: {
      kind: 'WHEN',
      runsPerWeek,
      condition: {
        text: 'Raw used above 90%', command: COMMAND, compare: { op: 'GT', value: 90 }, holdSeconds: 0,
        rearm: { op: 'LT', value: 85 }, unit: '%', ...condition,
      },
    },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    baseline: { key: BASELINE, summary: 'Raw used is 8.12%. Nothing to report.' },
    ...over,
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
const runsOf = (scheduleId: string) => db.scheduleRun.findMany({ where: { scheduleId }, orderBy: { plannedAt: 'asc' } });
const runOf = (id: string) => db.scheduleRun.findUniqueOrThrow({ where: { id } });
const pushesOf = (runId: string) => pushed.filter((a) => a.runId === runId);

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

/** Feed a firing sample and start its run: the run and its session. */
async function fire(w: World, scheduleId: string, conditionId: string, seconds: number, v: number) {
  const before = (await runsOf(scheduleId)).length;
  await feed(w, value(conditionId, seconds, v));
  const all = await runsOf(scheduleId);
  assert.equal(all.length, before + 1, 'the firing writes one run');
  const run = all.at(-1)!;
  assert.equal(run.trigger, 'CONDITION');
  const started = await runs.startDue(25, scheduleId);
  return { run, outcome: started[0]?.outcome, sessionId: (await runOf(run.id)).sessionId };
}

test('condition-run-known-key-notifies', { skip }, async () => {
  const w = await world('known-key');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);
  const baseline = await db.scheduleFinding.findUniqueOrThrow({ where: { scheduleId_key: { scheduleId: schedule.id, key: BASELINE } } });
  assert.ok(baseline.notifiedAt, 'the baseline is a finding already told');

  // The production case: the guard fires and its run reports CHANGED under the baseline's own key.
  await feed(w, value(c.id, 0, 80));
  pushed = [];
  const first = await fire(w, schedule.id, c.id, 300, 90.4);
  assert.equal(first.outcome, 'STARTED');
  const reported = await runs.report(w.ownerId, first.sessionId!, {
    outcome: 'CHANGED', key: BASELINE, summary: '14 old RBD snapshots hold 1.1 TiB; one proposal is waiting for you.',
  });
  assert.equal(reported.newFinding, false, 'the key is known');
  const told = pushesOf(first.run.id);
  assert.equal(told.length, 1, 'a firing is told once, whatever its key');
  assert.equal(told[0].kind, 'FINDING', "a firing's push rings as its schedule's FINDING (Android's kinds)");
  assert.equal(told[0].title, 'Ceph capacity guard: raw used above 90%, read 90.4%', "the schedule, the condition's words, the reading");
  assert.equal(told[0].body, '14 old RBD snapshots hold 1.1 TiB; one proposal is waiting for you.');
  assert.deepEqual(told[0].opens, { sessionId: first.sessionId }, "the tap opens the run's session");
  const refreshed = await db.scheduleFinding.findUniqueOrThrow({ where: { id: baseline.id } });
  assert.equal(refreshed.lastSeenRunId, first.run.id, 'the known finding is refreshed under its key');
  assert.equal(await db.scheduleFinding.count({ where: { scheduleId: schedule.id } }), 1, 'no second row for a known key');

  // A second crossing under a new key: still one push, the firing's, and the finding is written as today.
  await feed(w, value(c.id, 600, 80));
  const second = await fire(w, schedule.id, c.id, 900, 93);
  const fresh = await runs.report(w.ownerId, second.sessionId!, { outcome: 'CHANGED', key: 'above-90@2026-11-17', summary: 'Snapshots again.' });
  assert.equal(fresh.newFinding, true);
  const toldAgain = pushesOf(second.run.id);
  assert.equal(toldAgain.length, 1, 'a new key is not a second banner beside the firing');
  assert.equal(toldAgain[0].title, 'Ceph capacity guard: raw used above 90%, read 93%');
  const row = await db.scheduleFinding.findUniqueOrThrow({ where: { scheduleId_key: { scheduleId: schedule.id, key: 'above-90@2026-11-17' } } });
  assert.equal(row.firstRunId, second.run.id);
  assert.ok(row.notifiedAt, 'the new finding is recorded as told');
});

test('condition-run-no-change-notifies', { skip }, async () => {
  const w = await world('no-change');
  const schedule = await createdByCard(w);
  const c = await conditionOf(schedule.id);
  pushed = [];
  const { run, sessionId } = await fire(w, schedule.id, c.id, 0, 91.2);
  await runs.report(w.ownerId, sessionId!, { outcome: 'NO_CHANGE', summary: 'A rebalance was already running; it is back to 88%.' });
  const told = pushesOf(run.id);
  assert.equal(told.length, 1, 'a NO_CHANGE firing is told once');
  assert.equal(told[0].kind, 'FINDING');
  assert.equal(told[0].title, 'Ceph capacity guard: raw used above 90%, read 91.2%');
  assert.equal(
    told[0].body,
    'The condition fired and the run found nothing to report. A rebalance was already running; it is back to 88%.',
  );
  assert.equal(await db.scheduleFinding.count({ where: { scheduleId: schedule.id } }), 1, 'NO_CHANGE writes no finding');
  assert.equal(pushed.length, 1, 'nothing else rang');
});

test('condition-firing-one-push', { skip }, async () => {
  // MISSED OVER_BUDGET: the over-budget notice is the one push, and nothing reports.
  {
    const w = await world('one-budget');
    const schedule = await createdByCard(w, guard({}, { rearm: null }, 1));
    const c = await conditionOf(schedule.id);
    pushed = [];
    const first = await fire(w, schedule.id, c.id, 0, 95);
    await runs.report(w.ownerId, first.sessionId!, { outcome: 'NO_CHANGE', summary: 'fine' });
    await feed(w, value(c.id, 300, 80));
    const second = await fire(w, schedule.id, c.id, 600, 96);
    assert.equal(second.outcome, 'MISSED');
    assert.equal((await runOf(second.run.id)).failureReason, 'OVER_BUDGET');
    const told = pushed.filter((a) => a.scheduleId === schedule.id && a.runId !== first.run.id);
    assert.deepEqual(told.map((a) => a.kind), ['OVER_BUDGET'], "a firing over budget is told by that notice alone");
  }
  // FAILED by its report, and FAILED APPROVAL_TIMEOUT: the failure's notice is the one push.
  {
    const w = await world('one-failed');
    const schedule = await createdByCard(w);
    const c = await conditionOf(schedule.id);
    pushed = [];
    const a = await fire(w, schedule.id, c.id, 0, 95);
    await runs.report(w.ownerId, a.sessionId!, { outcome: 'FAILED', summary: 'ceph df did not answer' });
    assert.deepEqual(pushesOf(a.run.id).map((p) => p.kind), ['FAILED'], 'a FAILED report: the failure notice alone');
    await feed(w, value(c.id, 300, 80));
    const b = await fire(w, schedule.id, c.id, 600, 95);
    await db.scheduleRun.update({ where: { id: b.run.id }, data: { state: 'AWAITING_APPROVAL' } });
    assert.equal(await runs.fail(b.run.id, 'APPROVAL_TIMEOUT', { sessionId: b.sessionId, interrupt: true }), 'FAILED');
    assert.equal((await runOf(b.run.id)).failureReason, 'APPROVAL_TIMEOUT');
    assert.deepEqual(pushesOf(b.run.id).map((p) => p.kind), ['FAILED'], 'APPROVAL_TIMEOUT: the failure notice alone');
  }
  // LAND: the firing is told when the landing settles; a failed landing is told by its failure alone.
  {
    const w = await world('one-land');
    const schedule = await createdByCard(w, guard({ accessLevel: 'LAND' }));
    const c = await conditionOf(schedule.id);
    pushed = [];
    const a = await fire(w, schedule.id, c.id, 0, 95);
    assert.equal(a.outcome, 'STARTED');
    await runs.report(w.ownerId, a.sessionId!, { outcome: 'CHANGED', key: BASELINE, summary: 'Committed the cleanup script.' });
    assert.equal(pushesOf(a.run.id).length, 0, 'a LAND run waits for its landing before the firing is told');
    await db.session.update({ where: { id: a.sessionId! }, data: {
      status: 'AWAITING_INPUT', isolationStatus: 'worktree', baseSha: 'a'.repeat(40), branchSha: 'a'.repeat(40),
    } });
    await runs.landReportedRuns();
    assert.equal((await runOf(a.run.id)).landingStatus, 'NO_COMMITS');
    const told = pushesOf(a.run.id);
    assert.deepEqual(told.map((p) => p.kind), ['FINDING'], 'the settled landing tells the firing once');
    assert.equal(told[0].body, 'Committed the cleanup script.', "the run's own summary, not the landing suffix");
    await runs.landReportedRuns();
    assert.equal(pushesOf(a.run.id).length, 1, 'a replayed landing pass tells nothing more');

    await feed(w, value(c.id, 300, 80));
    const b = await fire(w, schedule.id, c.id, 600, 95);
    await runs.report(w.ownerId, b.sessionId!, { outcome: 'NO_CHANGE', summary: 'Nothing to clear.' });
    await db.session.update({ where: { id: b.sessionId! }, data: {
      status: 'AWAITING_INPUT', isolationStatus: 'worktree', baseSha: 'a'.repeat(40), branchSha: 'b'.repeat(40),
      mergeStatus: 'error', mergeError: 'Merge check failed: tests are red.',
    } });
    await runs.landReportedRuns();
    assert.equal((await runOf(b.run.id)).state, 'FAILED');
    assert.deepEqual(pushesOf(b.run.id).map((p) => p.kind), ['FAILED'], 'a failed landing: the failure notice alone');
  }
  // A repeat firing is its own firing: its own run, its own one push.
  {
    const w = await world('one-repeat');
    const schedule = await createdByCard(w, guard({}, { repeatSeconds: 2 * HOUR }));
    const c = await conditionOf(schedule.id);
    pushed = [];
    const first = await fire(w, schedule.id, c.id, 0, 95);
    await runs.report(w.ownerId, first.sessionId!, { outcome: 'CHANGED', key: 'above-90', summary: 'Snapshots.' });
    for (let s = 300; s < 2 * HOUR; s += 300) await feed(w, value(c.id, s, 95));
    const repeat = await fire(w, schedule.id, c.id, 2 * HOUR, 95.5);
    const event = await db.conditionEvent.findFirstOrThrow({ where: { conditionId: c.id, runId: repeat.run.id, kind: 'FIRED' } });
    assert.equal(event.repeat, true, 'the second firing is a repeat');
    await runs.report(w.ownerId, repeat.sessionId!, { outcome: 'CHANGED', key: 'above-90', summary: 'Snapshots, still.' });
    assert.equal(pushesOf(first.run.id).length, 1, 'the crossing: one push');
    assert.equal(pushesOf(repeat.run.id).length, 1, 'the repeat: its own one push, under the same key');
    assert.equal(pushesOf(repeat.run.id)[0].title, 'Ceph capacity guard: raw used above 90%, read 95.5%');
    assert.notEqual(pushesOf(first.run.id)[0].collapseId, pushesOf(repeat.run.id)[0].collapseId, 'the repeat does not replace the first banner');
  }
});

test('timed-run-unchanged', { skip }, async () => {
  const w = await world('timed');
  clockNow = new Date(T0);
  const created = await schedules.create(w.owner, {
    workspaceId: w.workspaceId,
    intent: 'Check the Codex stable release every day',
    title: 'Codex stable check',
    prompt: 'Check the latest stable Codex release against the pinned version.',
    rule: { kind: 'DAILY', time: '10:00' },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    baseline: { key: 'codex@0.48.0', summary: 'Pinned at 0.48.0.' },
  });
  assert.equal(created.outcome, 'CREATED');
  const scheduleId = created.outcome === 'CREATED' ? created.schedule.id : '';
  pushed = [];
  const reportNow = async (input: Parameters<ScheduleRunsService['report']>[2]) => {
    const run = await runs.runNow(w.owner, scheduleId);
    assert.equal(run.trigger, 'MANUAL');
    const sessionId = (await runOf(run.id)).sessionId!;
    await runs.report(w.ownerId, sessionId, input);
    return run;
  };
  const quiet = await reportNow({ outcome: 'NO_CHANGE', summary: 'Still 0.48.0.' });
  assert.equal(pushesOf(quiet.id).length, 0, 'a timed NO_CHANGE rings nobody');
  const known = await reportNow({ outcome: 'CHANGED', key: 'codex@0.48.0', summary: 'Same as the baseline.' });
  assert.equal(pushesOf(known.id).length, 0, 'a timed CHANGED under a known key rings nobody');
  const fresh = await reportNow({ outcome: 'CHANGED', key: 'codex@0.49.0', summary: 'Codex 0.49.0 is out.' });
  const told = pushesOf(fresh.id);
  assert.equal(told.length, 1, 'a timed new key is told once');
  assert.equal(told[0].kind, 'FINDING');
  assert.equal(told[0].title, 'Codex stable check', "the FINDING banner as before: the schedule's title");
  assert.equal(told[0].body, 'Codex 0.49.0 is out.');
  assert.equal(pushed.length, 1);
});
