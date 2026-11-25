/**
 * The weekly budget counts real starts (docs/scheduled-tasks-design.md §4, §5, §8.4), against a real PostgreSQL
 * migrated from empty, on a clock the spec moves, through the real trigger path (fire, then start):
 *
 *   1. a schedule whose rule is moved to "a few minutes from now" after every run starts at most its envelope's
 *      runs per week in any trailing 7 days; the extra slots are MISSED (OVER_BUDGET), the schedule stays ACTIVE,
 *      the owner is told once, and the run list reads the reason in English;
 *   2. two replicas racing on the last slot of the budget start exactly one run, and none past it;
 *   3. the owner's Run now starts and counts toward no budget; a session's counts toward a budget of its own, apart
 *      from the automatic slots, and is refused over it (SCHEDULE_OVER_BUDGET);
 *   4. a start that never reached its engine and was retried is one start, not four;
 *   5. a personal access token's Run now is refused over budget like a session's;
 *   6. a ONCE slot over budget follows the missed-ONCE rule;
 *   7. runs already started stay counted when the envelope is narrowed mid-week;
 *   a–c. a schedule whose rule fills its envelope never trips it, whatever each start's latency (DAILY over 15 days,
 *      WEEKLY over 4 weeks, one run 3 hours late after a runner outage, across a daylight-saving change);
 *   e. the owner's Run now inside a full week starts, and the next automatic slot still starts; presses by sessions
 *      never take a daily slot's place;
 *   f–g. a run that never reached its engine costs nothing, a live one holds its place.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-budget.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SessionsService } from '../sessions/sessions.service';
import type { ScheduleAlert } from './schedule-attention';
import { scheduleBudgetStarts, scheduleOverBudget } from './schedule-start-check';
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import { ScheduleRunsService, type ScheduleRunSessionPort } from './schedule-runs.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const FUTURE = new Date('2100-01-01T00:00:00Z');

let db: PrismaClient;
let pg: Client;
let clockNow = new Date('2026-11-16T08:00:00Z');
const clock = () => clockNow;
let schedules: SchedulesService;
let runs: ScheduleRunsService;
/** A second replica: its own service over the same database. */
let replica: ScheduleRunsService;
let pushed: ScheduleAlert[] = [];

function at(iso: string | Date): Date {
  clockNow = new Date(iso);
  return clockNow;
}

function advance(ms: number): Date {
  clockNow = new Date(clockNow.getTime() + ms);
  return clockNow;
}

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  // The real create door; every runner and realtime side effect is a no-op: what is under test is the rows.
  const quiet = new Proxy({}, { get: () => () => undefined });
  const real = new SessionsScheduleRunPort(new SessionsService(db as never, quiet as never, quiet as never));
  const port: ScheduleRunSessionPort = {
    land: (owner, sessionId) => real.land(owner, sessionId),
    open: (input) => real.open(input),
    interrupt: async () => undefined,
    complete: async (_owner, sessionId) => void (await db.session.update({ where: { id: sessionId }, data: { completedAt: clockNow } })),
    end: (owner, sessionId) => real.end(owner, sessionId),
  };
  const notifier = { notify: async (alert: ScheduleAlert) => void pushed.push(alert) };
  schedules = new SchedulesService(db as unknown as PrismaService, clock);
  runs = new ScheduleRunsService(db as unknown as PrismaService, port, clock, notifier);
  replica = new ScheduleRunsService(db as unknown as PrismaService, port, clock, notifier);
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
  /** An ordinary agent session of the owner, in the workspace. */
  agent: ScheduleActor;
}

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-budget.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: FUTURE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, title: 'chat', prompt: 'p', provider: 'claude',
      engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode: PermissionMode.DEFAULT,
    },
  });
  return { ownerId, runnerId, workspaceId, owner: { kind: 'OWNER', ownerId }, agent: { kind: 'SESSION', ownerId, sessionId } };
}

async function created(w: World, over: Partial<ScheduleCreateInput>) {
  const result = await schedules.create(w.owner, {
    workspaceId: w.workspaceId,
    intent: 'Check the Codex stable release',
    title: 'Codex stable check',
    prompt: 'Check the latest stable Codex release against the pinned version.',
    rule: { kind: 'DAILY', time: '10:00' },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    ...over,
  });
  assert.equal(result.outcome, 'CREATED');
  return result.schedule;
}

/** "HH:MM" in UTC, `ms` from now. */
function hhmm(ms: number): string {
  return new Date(clockNow.getTime() + ms).toISOString().slice(11, 16);
}

/** Move the rule to a few minutes from now, as the hole's session does: inside the envelope, applied at once. */
async function moveRule(actor: ScheduleActor, scheduleId: string, rule: (time: string) => unknown) {
  const result = await schedules.update(actor, scheduleId, { rule: rule(hhmm(5 * MINUTE)) });
  assert.equal(result.outcome, 'APPLIED', 'the move is inside the envelope');
  return result;
}

/** The engine took the run's first turn now. */
async function delivered(sessionId: string) {
  await db.conversationTurn.upsert({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId: `initial-${sessionId}` } },
    create: { sessionId, seq: 1, clientTurnId: `initial-${sessionId}`, content: 'x', status: 'IN_FLIGHT', deliveredAt: clockNow },
    update: { deliveredAt: clockNow },
  });
}

/** Go to the schedule's next slot and run the trigger path: fire, then start. */
async function nextSlot(scheduleId: string, service = runs) {
  const s = await db.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
  assert.ok(s.nextDueAt, 'a next slot');
  at(s.nextDueAt);
  await service.fire(scheduleId);
  return service.startDue(25, scheduleId);
}

/** A started run's session moves the rule, then reports and ends the run. */
async function runMovesAndEnds(w: World, runId: string, scheduleId: string, rule: (time: string) => unknown) {
  const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: runId } });
  assert.ok(run.sessionId);
  await delivered(run.sessionId);
  await moveRule({ kind: 'SESSION', ownerId: w.ownerId, sessionId: run.sessionId }, scheduleId, rule);
  advance(MINUTE);
  await runs.report(w.ownerId, run.sessionId, { outcome: 'NO_CHANGE', summary: 'same as pinned' });
}

function code(error: unknown): string | undefined {
  const r = (error as { getResponse?: () => unknown }).getResponse?.();
  return (r as { code?: string } | undefined)?.code;
}

function message(error: unknown): string | undefined {
  const r = (error as { getResponse?: () => unknown }).getResponse?.();
  return (r as { message?: string } | undefined)?.message;
}

async function startedIn(scheduleId: string, from: Date, to: Date): Promise<number> {
  return db.scheduleRun.count({ where: { scheduleId, startedAt: { gt: from, lte: to } } });
}

const daily = (time: string) => ({ kind: 'DAILY', time });

// =============================================================================================================

test('1. a rule moved to a few minutes from now after every run starts at most runsPerWeek runs in 7 days', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-moved');
  const s = await created(w, { rule: daily('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 7);

  const outcomes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const [started] = await nextSlot(s.id);
    outcomes.push(started?.outcome ?? 'NONE');
    if (started?.outcome === 'STARTED') {
      await runMovesAndEnds(w, started.runId, s.id, daily);
    } else {
      // Nothing started, so no run moves the rule: any agent session of the owner keeps doing it.
      await moveRule(w.agent, s.id, daily);
    }
  }
  assert.deepEqual(outcomes, [...Array(7).fill('STARTED'), 'MISSED', 'MISSED', 'MISSED'], 'seven start, the rest are not');

  const list = await db.scheduleRun.findMany({ where: { scheduleId: s.id }, orderBy: { plannedAt: 'asc' } });
  const over = list.filter((r) => r.state === 'MISSED');
  assert.equal(over.length, 3);
  for (const r of over) {
    assert.equal(r.failureReason, 'OVER_BUDGET');
    assert.equal(r.startedAt, null, 'an over-budget slot opened no session');
    assert.equal(r.sessionId, null);
  }
  const after = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(after.state, 'ACTIVE', 'a slot over budget does not hold or pause the schedule');
  assert.equal(after.heldReason, null);
  assert.ok(after.nextDueAt && after.nextDueAt > clockNow, 'the next slot is computed as usual');
  assert.equal(after.consecutiveFailures, 0, 'a slot over budget is not a failure');

  // Told once for the new reason, not once per slot.
  const budget = pushed.filter((a) => (a.kind as string) === 'OVER_BUDGET');
  assert.equal(budget.length, 1, `one push for three slots over budget, got ${budget.length}`);
  assert.match(budget[0].body, /7 runs/);

  // The run list reads the reason in English.
  // Read loosely, so the spec compiles against a tree without the field and fails on the assertion instead.
  const history = (await runs.history(w.ownerId, s.id)) as Array<{ id: string; state: string; failureReason: string | null; reasonText?: string | null }>;
  const row = history.find((r) => r.id === over[0].id)!;
  assert.equal(row.failureReason, 'OVER_BUDGET');
  assert.match(row.reasonText ?? '', /^Not started: it had already started as many scheduled runs in the past 7 days as you allowed/);
  assert.ok(!/[一-鿿]/.test(row.reasonText ?? ''), 'English');
  const ok = history.find((r) => r.state === 'NO_CHANGE')!;
  assert.equal(ok.reasonText, null, 'a run without a reason has no reason text');

  // In any trailing 7 days: once the first start is more than 7 days old, the slot runs again.
  const first = list.find((r) => r.startedAt)!.startedAt!;
  at(new Date(first.getTime() + 7 * DAY + MINUTE));
  await moveRule(w.agent, s.id, daily);
  const [again] = await nextSlot(s.id);
  assert.equal(again?.outcome, 'STARTED', 'the oldest start left the window');
  const startedAt = (await db.scheduleRun.findUniqueOrThrow({ where: { id: again.runId } })).startedAt!;
  assert.ok(await startedIn(s.id, new Date(startedAt.getTime() - 7 * DAY), startedAt) <= 7, 'still at most 7 in the trailing window');
});

test('2. two replicas racing on the last slot of the budget start exactly one run, and none past it', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z'); // a Monday
  const w = await world('budget-race');
  const weekly = (time: string) => ({ kind: 'WEEKLY', time, weekdays: ['MON', 'TUE'] });
  const s = await created(w, { rule: weekly('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 2);

  const [firstStart] = await nextSlot(s.id);
  assert.equal(firstStart?.outcome, 'STARTED');
  await runMovesAndEnds(w, firstStart.runId, s.id, weekly);

  // The last slot of the budget, fired and started by two replicas at once.
  const due = (await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).nextDueAt!;
  at(due);
  const race = async () => {
    const [a, b] = await Promise.all([
      runs.fire(s.id).then(() => runs.startDue(25, s.id)),
      replica.fire(s.id).then(() => replica.startDue(25, s.id)),
    ]);
    return [...a, ...b].filter((o) => o.outcome === 'STARTED');
  };
  const lastSlot = await race();
  assert.equal(lastSlot.length, 1, 'the last slot of the budget starts once');
  await runMovesAndEnds(w, lastSlot[0].runId, s.id, weekly);

  // Past the budget, both replicas again: neither starts.
  at((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).nextDueAt!);
  assert.equal((await race()).length, 0, 'no replica starts past the budget');
  const list = await db.scheduleRun.findMany({ where: { scheduleId: s.id } });
  assert.equal(list.filter((r) => r.startedAt).length, 2, 'two starts for a budget of two');
  assert.equal(list.filter((r) => r.state === 'MISSED' && r.failureReason === 'OVER_BUDGET').length, 1);
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).state, 'ACTIVE');
});

test('3. the owner\'s Run now starts and counts toward no budget; a session\'s counts toward its own, apart from the slots', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-run-now');
  const weekly = (time: string) => ({ kind: 'WEEKLY', time, weekdays: ['MON'] });
  const s = await created(w, { rule: weekly('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 1);

  // A session's Run now, inside its budget: allowed, and it is the week's one press by a session or a token.
  const mine = await runs.runNow(w.agent, s.id);
  const first = await db.scheduleRun.findUniqueOrThrow({ where: { id: mine.id } });
  assert.equal(first.state, 'RUNNING', 'inside the budget a session may run it now');
  assert.equal(first.byOwner, false);
  await delivered(first.sessionId!);
  advance(MINUTE);
  await runs.report(w.ownerId, first.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });

  // Now over it: a session's Run now is refused with a named code, and writes no run.
  const refusedOne = (error: unknown) => {
    assert.equal(code(error), 'SCHEDULE_OVER_BUDGET');
    assert.equal(
      message(error),
      'Run now by a session or a token has started 1 run of this schedule in the past 7 days; ' +
        'its owner allowed 1 a week. Only the owner can run it now.',
    );
    return true;
  };
  const runsBefore = await db.scheduleRun.count({ where: { scheduleId: s.id } });
  await assert.rejects(runs.runNow(w.agent, s.id), refusedOne);
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id } }), runsBefore, 'a refused Run now writes no run');

  // The owner's press starts, and records that it was theirs.
  const press = await runs.runNow(w.owner, s.id);
  const pressed = await db.scheduleRun.findUniqueOrThrow({ where: { id: press.id } });
  assert.equal(pressed.state, 'RUNNING', "the owner's Run now is the owner's own press");
  assert.equal(pressed.byOwner, true);
  await delivered(pressed.sessionId!);
  advance(MINUTE);
  await runs.report(w.ownerId, pressed.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });

  // Neither press takes the automatic slot's place: the slot, moved to a few minutes from now, starts.
  await moveRule(w.agent, s.id, weekly);
  const [auto] = await nextSlot(s.id);
  assert.equal(auto?.outcome, 'STARTED', 'two presses in the window, and the rhythm still runs');
  // The rule's own one run a week still bounds it: moved again, the next slot is over budget.
  await runMovesAndEnds(w, auto.runId, s.id, weekly);
  const [again] = await nextSlot(s.id);
  assert.equal(again?.outcome, 'MISSED');
  assert.equal((await db.scheduleRun.findUniqueOrThrow({ where: { id: again.runId } })).failureReason, 'OVER_BUDGET');

  // The owner's press still starts, and a session's refusal still counts only the sessions' and tokens' presses.
  const last = await runs.runNow(w.owner, s.id);
  assert.equal((await db.scheduleRun.findUniqueOrThrow({ where: { id: last.id } })).state, 'RUNNING');
  await assert.rejects(runs.runNow(w.agent, s.id), refusedOne);
});

test('4. a start that never reached its engine, retried three times, is one start', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-retry');
  const weekly = (time: string) => ({ kind: 'WEEKLY', time, weekdays: ['MON', 'TUE'] });
  const s = await created(w, { rule: weekly('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 2);

  const [first] = await nextSlot(s.id);
  assert.equal(first?.outcome, 'STARTED');
  // Three times the first turn never reaches the engine: RUNNER_UNAVAILABLE, retried after 1, 5 and 15 minutes.
  for (const wait of [1, 5, 15]) {
    advance(10 * MINUTE);
    assert.equal(await runs.reconcileRun(first.runId), 'RETRY');
    advance(wait * MINUTE);
    const [retry] = await runs.startDue(25, s.id);
    assert.equal(retry?.outcome, 'STARTED', 'a retry of an undelivered start is not refused by the budget');
  }
  const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: first.runId } });
  assert.equal(run.attempt, 4);
  assert.equal(await db.session.count({ where: { scheduleRunId: run.id } }), 4, 'four sessions were opened for it');
  await runMovesAndEnds(w, run.id, s.id, weekly);

  // One start so far, of two: the next slot starts; the one after it is over budget.
  const [second] = await nextSlot(s.id);
  assert.equal(second?.outcome, 'STARTED', 'the four attempts counted once');
  await runMovesAndEnds(w, second.runId, s.id, weekly);
  const [third] = await nextSlot(s.id);
  assert.equal(third?.outcome, 'MISSED');
  assert.equal((await db.scheduleRun.findUniqueOrThrow({ where: { id: third.runId } })).failureReason, 'OVER_BUDGET');
});

test('5. a personal access token\'s Run now works inside the budget and is refused over it; the owner\'s still starts', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-pat');
  const pat: ScheduleActor = { kind: 'PAT', ownerId: w.ownerId };
  const s = await created(w, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON', 'TUE'] } });
  assert.equal(s.envelopeRunsPerWeek, 2);

  // Inside the budget a token works as before: two starts of two.
  for (let i = 0; i < 2; i++) {
    const asked = await runs.runNow(pat, s.id);
    const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: asked.id } });
    assert.equal(run.state, 'RUNNING', 'inside the budget a token may run it now');
    await delivered(run.sessionId!);
    advance(MINUTE);
    await runs.report(w.ownerId, run.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });
  }
  // Over it, a token is what an agent with a shell holds: refused like a session.
  const runsBefore = await db.scheduleRun.count({ where: { scheduleId: s.id } });
  await assert.rejects(runs.runNow(pat, s.id), (error: unknown) => {
    assert.equal(code(error), 'SCHEDULE_OVER_BUDGET');
    return true;
  });
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id } }), runsBefore, 'a refused Run now writes no run');
  // Only the owner-interactive press starts over budget.
  const press = await runs.runNow(w.owner, s.id);
  assert.equal((await db.scheduleRun.findUniqueOrThrow({ where: { id: press.id } })).state, 'RUNNING');
});

test('6. a ONCE slot over budget is MISSED (OVER_BUDGET) and follows the missed-ONCE rule: one push, the schedule ends', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-once');
  const s = await created(w, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  assert.equal(s.envelopeRunsPerWeek, 1);

  // Its slot starts, and the run turns it into a ONCE a few minutes from now (inside the envelope): the one start of
  // the week is spent. A Run now would not spend it (§8.4).
  const [first] = await nextSlot(s.id);
  assert.equal(first?.outcome, 'STARTED');
  await runMovesAndEnds(w, first.runId, s.id, (time) => ({ kind: 'ONCE', at: `2026-11-16T${time}` }));
  pushed = [];

  const [slot] = await nextSlot(s.id);
  assert.equal(slot?.outcome, 'MISSED');
  const missed = await db.scheduleRun.findUniqueOrThrow({ where: { id: slot.runId } });
  assert.equal(missed.failureReason, 'OVER_BUDGET');
  assert.equal(missed.sessionId, null);
  const after = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(after.state, 'ENDED');
  assert.equal(after.endedReason, 'END_REACHED', 'its only slot has passed');
  assert.deepEqual(pushed.map((a) => a.kind), ['ONCE_MISSED'], 'one push, the missed-ONCE one');
});

test('7. narrowed mid-week: runs already started stay counted against the new, smaller number', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-narrowed');
  const s = await created(w, { rule: daily('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 7);
  for (let i = 0; i < 3; i++) {
    const [started] = await nextSlot(s.id);
    assert.equal(started?.outcome, 'STARTED');
    await runMovesAndEnds(w, started.runId, s.id, daily);
  }
  // The owner narrows to two weekdays, today among them: the envelope shrinks to 2, below the 3 already started.
  const narrowed = await schedules.update(w.owner, s.id, { rule: { kind: 'WEEKLY', time: hhmm(5 * MINUTE), weekdays: ['MON', 'WED'] } });
  assert.equal(narrowed.outcome, 'APPLIED');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeRunsPerWeek, 2);
  const [next] = await nextSlot(s.id);
  assert.equal(next?.outcome, 'MISSED', 'the three starts count against the new budget of two');
  assert.equal((await db.scheduleRun.findUniqueOrThrow({ where: { id: next.runId } })).failureReason, 'OVER_BUDGET');
});

// =============================================================================================================
// A rule that fills its envelope never trips it: the window is counted on planned slots, not on start times.
// =============================================================================================================

/** Seconds each start waits behind its slot: varied 0-90 s, with later starts earlier in their slot than seven before. */
const JITTER = [90, 0, 45, 10, 80, 5, 60, 2, 85, 30, 0, 70, 15, 90, 1];

/**
 * Run the schedule's next `count` slots on the real path, with the clock driven: fire at the slot, start `latency`
 * seconds later, deliver, report. `late` is a slot index whose runner is offline for three hours first (§5.2).
 */
async function runSlots(w: World, scheduleId: string, count: number, opts: { late?: number } = {}) {
  const outcomes: string[] = [];
  for (let i = 0; i < count; i++) {
    const s = await db.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
    at(s.nextDueAt!);
    assert.equal(await runs.fire(scheduleId), 'FIRED');
    if (opts.late === i) {
      await db.runner.update({ where: { id: w.runnerId }, data: { status: RunnerStatus.OFFLINE, lastHeartbeatAt: new Date('2000-01-01T00:00:00Z') } });
      const [waiting] = await runs.startDue(25, scheduleId);
      assert.equal(waiting?.outcome, 'WAITING', 'the runner is offline: the run waits');
      advance(3 * 60 * MINUTE);
      await db.runner.update({ where: { id: w.runnerId }, data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: FUTURE } });
    } else {
      advance(JITTER[i % JITTER.length] * 1000);
    }
    const [started] = await runs.startDue(25, scheduleId);
    outcomes.push(started?.outcome ?? 'NONE');
    if (started?.outcome !== 'STARTED') continue;
    const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: started.runId } });
    await delivered(run.sessionId!);
    advance(MINUTE);
    await runs.report(w.ownerId, run.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });
  }
  return outcomes;
}

async function noneMissed(scheduleId: string, outcomes: string[]) {
  assert.deepEqual(outcomes.filter((o) => o !== 'STARTED'), [], `every slot starts: ${outcomes.join(' ')}`);
  assert.equal(await db.scheduleRun.count({ where: { scheduleId, state: 'MISSED' } }), 0);
  assert.equal(pushed.filter((a) => (a.kind as string) === 'OVER_BUDGET').length, 0, 'no over-budget push');
}

test('a. DAILY with envelope 7, 15 days, each start 0-90 s late: no slot is MISSED, no push', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-daily-jitter');
  const s = await created(w, { rule: daily('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 7);
  await noneMissed(s.id, await runSlots(w, s.id, 15));
});

test('a. DAILY with envelope 7 across the spring-forward change (New York): no slot is MISSED', { skip }, async () => {
  pushed = [];
  at('2026-03-02T13:00:00Z');
  const w = await world('budget-daily-dst');
  const s = await created(w, { rule: daily('09:00'), timezone: 'America/New_York' });
  // 2 March to 16 March: the week across 8 March is 167 hours from slot to slot.
  await noneMissed(s.id, await runSlots(w, s.id, 15));
});

test('b. WEEKLY with envelope 1, 4 weeks, each start 0-90 s late: none missed', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-weekly-jitter');
  const s = await created(w, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  assert.equal(s.envelopeRunsPerWeek, 1);
  // JITTER[0..3] = 90, 0, 45, 10: week 2 starts earlier in its slot than week 1 did.
  await noneMissed(s.id, await runSlots(w, s.id, 4));
});

test('c. one run 3 hours late after a runner outage, the next day on time: none missed', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-late');
  const s = await created(w, { rule: daily('10:00') });
  await noneMissed(s.id, await runSlots(w, s.id, 15, { late: 3 }));
  const late = (await db.scheduleRun.findMany({ where: { scheduleId: s.id }, orderBy: { plannedAt: 'asc' } }))[3];
  assert.equal(late.startedAt!.getTime() - late.plannedAt.getTime(), 3 * 60 * MINUTE, 'that run did start 3 hours late');
});

test('e. the owner\'s Run now inside a full week starts, and the next automatic slot still starts', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-press-cost');
  const s = await created(w, { rule: daily('10:00') });
  await noneMissed(s.id, await runSlots(w, s.id, 6));
  // The seventh day, before its slot: the owner presses Run now. It starts.
  at('2026-11-22T08:00:00Z');
  const press = await runs.runNow(w.owner, s.id);
  const pressed = await db.scheduleRun.findUniqueOrThrow({ where: { id: press.id } });
  assert.equal(pressed.state, 'RUNNING');
  await delivered(pressed.sessionId!);
  advance(MINUTE);
  await runs.report(w.ownerId, pressed.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });
  // The press is not the cost of the day's 10:00 slot: the rhythm the owner approved runs.
  const [slot] = await nextSlot(s.id);
  assert.equal(slot?.outcome, 'STARTED');
});

/** The production case of 2026-11-20: six presses by sessions in three days, then the daily slots go on. */
test('e2. presses by sessions and tokens up to their budget never take a daily slot\'s place', { skip }, async () => {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world('budget-presses-apart');
  const s = await created(w, { rule: daily('10:00') });
  await noneMissed(s.id, await runSlots(w, s.id, 1));
  for (let i = 0; i < 6; i++) {
    advance(60 * MINUTE);
    const asked = await runs.runNow(w.agent, s.id);
    const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: asked.id } });
    assert.equal(run.state, 'RUNNING');
    await delivered(run.sessionId!);
    advance(MINUTE);
    await runs.report(w.ownerId, run.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });
  }
  await noneMissed(s.id, await runSlots(w, s.id, 6));
});

/**
 * Six delivered slots of a rule that a run moved to a few minutes after each run (envelope 7), then the seventh slot
 * started and never delivered.
 */
async function sixDeliveredThenUndeliveredSlot(label: string) {
  pushed = [];
  at('2026-11-16T09:58:00Z');
  const w = await world(label);
  const s = await created(w, { rule: daily('10:00') });
  assert.equal(s.envelopeRunsPerWeek, 7);
  for (let i = 0; i < 6; i++) {
    const [slot] = await nextSlot(s.id);
    assert.equal(slot?.outcome, 'STARTED');
    await runMovesAndEnds(w, slot.runId, s.id, daily);
  }
  const [seventh] = await nextSlot(s.id);
  assert.equal(seventh?.outcome, 'STARTED');
  const started = await db.scheduleRun.findUniqueOrThrow({ where: { id: seventh.runId } });
  assert.ok(started.startedAt && started.sessionId, 'the slot opened a session');
  assert.equal(await db.conversationTurn.count({ where: { sessionId: started.sessionId!, deliveredAt: { not: null } } }), 0, 'never delivered');
  await moveRule(w.agent, s.id, daily);
  return { w, s, started };
}

test('f. six delivered runs plus a MISSED RUNNER_UNAVAILABLE run that never reached its engine: the next slot starts', { skip }, async () => {
  const { s, started } = await sixDeliveredThenUndeliveredSlot('budget-undelivered-missed');
  // Five tries, none delivered, then MISSED: it keeps startedAt, as in production.
  await db.scheduleRun.update({
    where: { id: started.id },
    data: { state: 'MISSED', failureReason: 'RUNNER_UNAVAILABLE', endedAt: advance(MINUTE) },
  });
  const row = await db.scheduleRun.findUniqueOrThrow({ where: { id: started.id } });
  assert.ok(row.startedAt, 'the missed run kept startedAt');
  const [slot] = await nextSlot(s.id);
  assert.equal(slot?.outcome, 'STARTED', 'an undelivered run does not cost the slot its place');
});

test('g. six delivered runs plus a RUNNING run not yet delivered: the next slot is OVER_BUDGET', { skip }, async () => {
  const { s } = await sixDeliveredThenUndeliveredSlot('budget-undelivered-live');
  // A live run holds its place. The next slot would also wait behind the run in progress (start()'s busy check), so
  // the budget is read the way start() reads it for that slot.
  const schedule = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  const slot = schedule.nextDueAt!;
  assert.equal(await scheduleBudgetStarts(db, schedule, slot), 7, 'six delivered plus the live undelivered run');
  assert.equal(await scheduleOverBudget(db, schedule, slot), true);
});
