/**
 * A schedule's runs (docs/scheduled-tasks-design.md §5–§7), against a real PostgreSQL migrated from empty, on a
 * clock the spec moves:
 *
 *   * §5 / §5.1: firing ONCE, DAILY (across a daylight-saving change) and WEEKLY rules; END_REACHED; two workers,
 *     and one after a restart, write one run per slot; at most one run waits;
 *   * §5.2: only the latest missed slot is caught up, with its own plannedAt; the rest are MISSED; a ONCE slot
 *     older than a day is MISSED and ends its schedule;
 *   * §6.1: each start check that fails HOLDS the run and the schedule, which then fires nothing; resume re-checks;
 *   * §6.2 / §6.3: the run's session — runSource SCHEDULE, scheduleRunId, the mode for its level, its first turn's
 *     scheduled-run block — opened through the real SessionsService.create;
 *   * §7.1 / §7.2: the report's four rules; NO_REPORT, RUN_LIMIT, APPROVAL_TIMEOUT; retries only for a run whose first
 *     turn has no delivered_at; consecutive failures counted and the schedule never paused;
 *   * §8.4: Run now and Stop this run.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-runs.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PermissionMode } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SessionsService } from '../sessions/sessions.service';
import { OPEN_PR_DISALLOWED_TOOLS, scheduleRunDisallowedTools, scheduleRunMode } from './schedule-access';
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import {
  SCHEDULE_APPROVAL_TIMEOUT_MS,
  ScheduleRunsService,
  type OpenRunSession,
  type ScheduleRunSessionPort,
} from './schedule-runs.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FUTURE = new Date('2100-01-01T00:00:00Z');

let db: PrismaClient;
let pg: Client;
let clockNow = new Date('2026-11-14T08:00:00Z');
const clock = () => clockNow;
let schedules: SchedulesService;
let runs: ScheduleRunsService;
let calls: Array<{ op: 'interrupt' | 'complete' | 'end'; sessionId: string }> = [];
let opened: OpenRunSession[] = [];
/** How the next opens fail: not at all, before anything is written (a refusal or a fault), or after the INSERT. */
let failOpen: false | 'fault' | 'refuse' | 'after' = false;
let failEnd = false;

function at(iso: string): Date {
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
  // The real create door, as the production port uses it; the runner and realtime sides are not under test.
  // Every runner and realtime side effect is a no-op: what is under test is the rows.
  const quiet = new Proxy({}, { get: () => () => undefined });
  const sessionsService = new SessionsService(db as never, quiet as never, quiet as never);
  const real = new SessionsScheduleRunPort(sessionsService);
  const port: ScheduleRunSessionPort = {
    open: async (input) => {
      if (failOpen === 'fault') throw new Error('connection reset');
      if (failOpen === 'refuse') throw new BadRequestException('pick a workspace bound to a runner');
      opened.push(input);
      await real.open(input);
      if (failOpen === 'after') throw new Error('the managed runner did not answer the wake');
    },
    interrupt: async (_owner, sessionId) => void calls.push({ op: 'interrupt', sessionId }),
    complete: async (_owner, sessionId) => {
      calls.push({ op: 'complete', sessionId });
      await db.session.update({ where: { id: sessionId }, data: { completedAt: clockNow } });
    },
    // The real retire: auto-retry cancelled and SessionsService.end, so an ended session is what a claim would see.
    end: async (owner, sessionId) => {
      calls.push({ op: 'end', sessionId });
      if (failEnd) throw new Error('the database went away');
      await real.end(owner, sessionId);
    },
  };
  schedules = new SchedulesService(db as unknown as PrismaService, clock);
  runs = new ScheduleRunsService(db as unknown as PrismaService, port, clock);
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
}

async function world(label: string, opts: { runnerStatus?: RunnerStatus; repo?: boolean } = {}): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-runs.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: opts.runnerStatus ?? RunnerStatus.ONLINE,
      // The clock moves; a beat in the future keeps the runner online at every instant the spec visits.
      lastHeartbeatAt: opts.runnerStatus === RunnerStatus.OFFLINE ? new Date('2000-01-01T00:00:00Z') : FUTURE,
      capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true,
      ...(opts.repo === false ? {} : { repoUrl: 'https://github.com/example/repo.git' }),
    },
  });
  return { ownerId, runnerId, workspaceId, owner: { kind: 'OWNER', ownerId } };
}

function input(over: Partial<ScheduleCreateInput> = {}): ScheduleCreateInput {
  return {
    intent: '每天北京时间 10 点检查 Codex 官方稳定版，有新版本才告诉我',
    title: 'Codex stable check',
    prompt: 'Check the latest stable Codex release against the pinned version.',
    rule: { kind: 'DAILY', time: '10:00' },
    timezone: 'Asia/Shanghai',
    accessLevel: 'CHECK_ONLY',
    ...over,
  };
}

async function created(w: World, over: Partial<ScheduleCreateInput> = {}) {
  const result = await schedules.create(w.owner, { workspaceId: w.workspaceId, ...input(over) });
  assert.equal(result.outcome, 'CREATED');
  return result.schedule;
}

async function scheduleOf(id: string) {
  return db.schedule.findUniqueOrThrow({ where: { id } });
}

async function runsOf(scheduleId: string) {
  return db.scheduleRun.findMany({ where: { scheduleId }, orderBy: [{ plannedAt: 'asc' }, { createdAt: 'asc' }] });
}

async function runOf(id: string) {
  return db.scheduleRun.findUniqueOrThrow({ where: { id } });
}

/** Fire the schedule's due slot and start what may start: one worker pass without the watching. */
async function fireAndStart(scheduleId: string) {
  const fired = await runs.fire(scheduleId);
  const started = await runs.startDue(25, scheduleId);
  return { fired, started };
}

/** The engine took the run's first turn at `deliveredAt`. */
async function delivered(sessionId: string, deliveredAt: Date, status = 'IN_FLIGHT') {
  await db.conversationTurn.upsert({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId: `initial-${sessionId}` } },
    create: { sessionId, seq: 1, clientTurnId: `initial-${sessionId}`, content: 'x', status, deliveredAt },
    update: { status, deliveredAt },
  });
  // The session row stays as the create door left it: PENDING -> RUNNING is the claim's, and a guard trigger
  // refuses it from anything else. What the run reads is the turn's delivered_at.
}

/** A running run with its session delivered, at the current clock. */
async function runningRun(w: World, over: Partial<ScheduleCreateInput> = {}) {
  const schedule = await created(w, over);
  at(schedule.nextDueAt!.toISOString());
  const { started } = await fireAndStart(schedule.id);
  assert.equal(started[0]?.outcome, 'STARTED', 'the run starts');
  const run = await runOf(started[0].runId);
  await delivered(run.sessionId!, clockNow);
  return { schedule, run, sessionId: run.sessionId! };
}

function code(error: unknown): string | undefined {
  const r = (error as { getResponse?: () => unknown }).getResponse?.();
  return (r as { code?: string } | undefined)?.code;
}

async function refusedWith(promise: Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(code(error), expected);
    return true;
  });
}

function reset(): void {
  calls = [];
  opened = [];
  failOpen = false;
  failEnd = false;
}

/** The sessions of a run that could still run: what must never be more than one. */
async function liveSessionsOf(runId: string) {
  return db.session.findMany({
    where: {
      scheduleRunId: runId, deletedAt: null, completedAt: null, cancelRequestedAt: null,
      status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED'] },
    },
    select: { id: true },
  });
}

// =============================================================================================================
// §5.1 — the three rules, in their time zone
// =============================================================================================================

test('§5.1 DAILY: 09:00 New York stays 09:00 across the spring-forward change (13:00Z after, 14:00Z before)', { skip }, async () => {
  reset();
  at('2026-03-06T12:00:00Z');
  const w = await world('daily-dst');
  const s = await created(w, { rule: { kind: 'DAILY', time: '09:00' }, timezone: 'America/New_York' });
  assert.equal(s.nextDueAt!.toISOString(), '2026-03-06T14:00:00.000Z', 'EST: 09:00 is 14:00Z');
  at('2026-03-07T14:00:00Z');
  await runs.fire(s.id);
  assert.equal((await scheduleOf(s.id)).nextDueAt!.toISOString(), '2026-03-08T13:00:00.000Z', 'EDT from 8 March: 09:00 is 13:00Z');
  at('2026-03-08T13:00:00Z');
  assert.equal(await runs.fire(s.id), 'FIRED');
  assert.equal((await scheduleOf(s.id)).nextDueAt!.toISOString(), '2026-03-09T13:00:00.000Z');
  const planned = (await runsOf(s.id)).map((r) => [r.plannedAt.toISOString(), r.trigger]);
  assert.deepEqual(planned.slice(-1), [['2026-03-08T13:00:00.000Z', 'SCHEDULED']], 'the slot fires at 09:00 local, on time');
});

test('§5.1 WEEKLY: MON and THU 10:00 Shanghai fire on those days only', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z'); // a Saturday
  const w = await world('weekly');
  const s = await created(w, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON', 'THU'] } });
  assert.equal(s.nextDueAt!.toISOString(), '2026-11-16T02:00:00.000Z', 'Monday 10:00 +08:00');
  at('2026-11-16T02:00:00Z');
  await runs.fire(s.id);
  assert.equal((await scheduleOf(s.id)).nextDueAt!.toISOString(), '2026-11-19T02:00:00.000Z', 'then Thursday');
  at('2026-11-19T02:00:30Z');
  await runs.fire(s.id);
  assert.equal((await scheduleOf(s.id)).nextDueAt!.toISOString(), '2026-11-23T02:00:00.000Z', 'then the next Monday');
});

test('§5 ONCE: its only slot fires, and the schedule ENDS (END_REACHED) with the run still to start', { skip }, async () => {
  reset();
  at('2026-11-14T08:00:00Z');
  const w = await world('once');
  const s = await created(w, { rule: { kind: 'ONCE', at: '2026-11-14T18:00' }, intent: 'check at 18:00 whether the deploy is healthy' });
  assert.equal(s.nextDueAt!.toISOString(), '2026-11-14T10:00:00.000Z');
  at('2026-11-14T10:00:00Z');
  assert.equal(await runs.fire(s.id), 'FIRED');
  const after = await scheduleOf(s.id);
  assert.equal(after.state, 'ENDED');
  assert.equal(after.endedReason, 'END_REACHED');
  assert.equal(after.nextDueAt, null);
  const [run] = await runsOf(s.id);
  assert.equal(run.state, 'QUEUED');
  const started = await runs.startDue(25, s.id);
  assert.deepEqual(started.map((r) => r.outcome), ['STARTED'], 'the last slot of an ended schedule still runs');
});

test('§5 endAt: a DAILY rule past its end time ENDS (END_REACHED) after its last slot', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('end-at');
  const s = await created(w, { endAt: new Date('2026-11-15T12:00:00Z') });
  at('2026-11-14T02:00:00Z');
  await runs.fire(s.id);
  assert.equal((await scheduleOf(s.id)).state, 'ACTIVE');
  at('2026-11-15T02:00:00Z');
  await runs.fire(s.id);
  const after = await scheduleOf(s.id);
  assert.equal(after.state, 'ENDED');
  assert.equal(after.endedReason, 'END_REACHED');
});

// =============================================================================================================
// §5 — one run per slot, at most one waiting
// =============================================================================================================

test('§5 two workers firing the same slot at once write one run; a restart that lost the advance writes none', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('two-workers');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const other = new ScheduleRunsService(db as unknown as PrismaService, { open: async () => undefined } as never, clock);
  const outcomes = await Promise.all([runs.fire(s.id), other.fire(s.id), runs.fire(s.id)]);
  assert.deepEqual(outcomes.filter((o) => o === 'FIRED').length, 1, `one fires: ${outcomes.join(', ')}`);
  assert.equal((await runsOf(s.id)).length, 1);
  // A worker restarting from before its advance committed sees the slot again: the slot's unique index holds.
  await db.schedule.update({ where: { id: s.id }, data: { nextDueAt: new Date('2026-11-14T02:00:00Z') } });
  assert.equal(await runs.fire(s.id), 'SETTLED_ELSEWHERE');
  const slotRuns = await runsOf(s.id);
  assert.equal(slotRuns.length, 1, 'still one run for the 02:00Z slot');
  assert.equal((await scheduleOf(s.id)).nextDueAt!.toISOString(), '2026-11-15T02:00:00.000Z', 'and the schedule moves on');
});

test('§5 overlap: a slot while a run is in progress queues; a third slot SKIPS the older queued run; the queued one starts when the first ends', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('overlap');
  const { schedule: s, run: first, sessionId } = await runningRun(w, { runLimitMinutes: 120 });
  at('2026-11-15T02:00:00Z');
  await fireAndStart(s.id);
  let all = await runsOf(s.id);
  assert.deepEqual(all.map((r) => r.state), ['RUNNING', 'QUEUED'], 'the second waits behind the first');
  at('2026-11-16T02:00:00Z');
  await db.conversationTurn.updateMany({ where: { sessionId }, data: { deliveredAt: clockNow } });
  await fireAndStart(s.id);
  all = await runsOf(s.id);
  assert.deepEqual(all.map((r) => r.state), ['RUNNING', 'SKIPPED', 'QUEUED'], 'never more than one waiting');
  assert.equal(all.filter((r) => r.state === 'QUEUED').length, 1);
  await runs.report(w.ownerId, sessionId, { outcome: 'NO_CHANGE', summary: 'same as pinned' });
  all = await runsOf(s.id);
  assert.equal((await runOf(first.id)).state, 'NO_CHANGE');
  assert.deepEqual(all.map((r) => r.state), ['NO_CHANGE', 'SKIPPED', 'RUNNING'], 'the queued run starts when the first ends');
});

// =============================================================================================================
// §5.2 — missed slots
// =============================================================================================================

test('§5.2 after an outage only the latest slot runs (CATCH_UP, original plannedAt); the earlier ones are MISSED', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('catch-up');
  const s = await created(w);
  at('2026-11-17T09:30:00Z'); // 14, 15, 16 and 17 November 02:00Z all passed
  assert.equal(await runs.fire(s.id), 'FIRED');
  const all = await runsOf(s.id);
  assert.deepEqual(
    all.map((r) => [r.plannedAt.toISOString(), r.trigger, r.state]),
    [
      ['2026-11-14T02:00:00.000Z', 'SCHEDULED', 'MISSED'],
      ['2026-11-15T02:00:00.000Z', 'SCHEDULED', 'MISSED'],
      ['2026-11-16T02:00:00.000Z', 'SCHEDULED', 'MISSED'],
      ['2026-11-17T02:00:00.000Z', 'CATCH_UP', 'QUEUED'],
    ],
  );
  assert.equal((await scheduleOf(s.id)).nextDueAt!.toISOString(), '2026-11-18T02:00:00.000Z');
  await runs.startDue(25, s.id);
  const caught = (await runsOf(s.id))[3];
  assert.equal(caught.state, 'RUNNING');
  assert.equal(caught.startedAt!.toISOString(), '2026-11-17T09:30:00.000Z', 'a late run shows both its plannedAt and startedAt');
});

test('§5.2 a ONCE slot within a day is caught up; one older than a day is MISSED and ends the schedule', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('once-window');
  const late = await created(w, { rule: { kind: 'ONCE', at: '2026-11-14T18:00' } });
  const lost = await created(w, { rule: { kind: 'ONCE', at: '2026-11-14T18:00' }, title: 'lost' });
  at('2026-11-15T09:00:00Z'); // 23 hours late
  assert.equal(await runs.fire(late.id), 'FIRED');
  assert.deepEqual((await runsOf(late.id)).map((r) => [r.trigger, r.state]), [['CATCH_UP', 'QUEUED']]);
  at('2026-11-15T10:00:01Z'); // a day and a second late
  assert.equal(await runs.fire(lost.id), 'MISSED');
  assert.deepEqual((await runsOf(lost.id)).map((r) => [r.trigger, r.state]), [['SCHEDULED', 'MISSED']]);
  const ended = await scheduleOf(lost.id);
  assert.equal(ended.state, 'ENDED', 'nothing else will run; S3 tells the owner from this MISSED run');
  assert.equal(ended.endedReason, 'END_REACHED');
});

// =============================================================================================================
// §6.1 — the start checks
// =============================================================================================================

type Breaker = (w: World, scheduleId: string) => Promise<void>;

const CHECKS: Array<{ reason: string; over?: Partial<ScheduleCreateInput>; repo?: boolean; breaks: Breaker; mends: Breaker }> = [
  {
    reason: 'WORKSPACE_NOT_OWNED',
    breaks: async (w) => {
      const other = randomUUID();
      await db.user.create({ data: { id: other, email: `other-${other}@schedule-runs.invalid`, name: 'other', passwordHash: 'x' } });
      await db.workspace.update({ where: { id: w.workspaceId }, data: { ownerId: other } });
    },
    mends: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { ownerId: w.ownerId } })),
  },
  {
    reason: 'WORKSPACE_DELETED',
    breaks: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { deletedAt: clockNow } })),
    mends: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { deletedAt: null } })),
  },
  {
    reason: 'WORKSPACE_DISABLED',
    breaks: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { enabled: false } })),
    mends: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { enabled: true } })),
  },
  {
    reason: 'AGENT_MISSING',
    breaks: async (_w, id) => void (await db.schedule.update({ where: { id }, data: { agentId: randomUUID() } })),
    mends: async (_w, id) => void (await db.schedule.update({ where: { id }, data: { agentId: null } })),
  },
  {
    reason: 'AGENT_DISABLED',
    breaks: async (w, id) => {
      const agent = await db.agent.create({ data: { ownerId: w.ownerId, name: `agent-${randomUUID().slice(0, 6)}`, enabled: false } });
      await db.schedule.update({ where: { id }, data: { agentId: agent.id } });
    },
    mends: async (_w, id) => {
      const s = await scheduleOf(id);
      await db.agent.update({ where: { id: s.agentId! }, data: { enabled: true } });
    },
  },
  {
    reason: 'OUTSIDE_ENVELOPE',
    breaks: async (_w, id) => void (await db.schedule.update({ where: { id }, data: { envelopeRunsPerWeek: 1 } })),
    mends: async (_w, id) => void (await db.schedule.update({ where: { id }, data: { envelopeRunsPerWeek: 7 } })),
  },
  {
    reason: 'MODE_WIDER_THAN_ACCOUNT_DEFAULT',
    over: { accessLevel: 'OPEN_PR' },
    breaks: async (w) => void (await db.user.update({ where: { id: w.ownerId }, data: { preferences: { defaultPermissionMode: PermissionMode.PLAN } } })),
    mends: async (w) => void (await db.user.update({ where: { id: w.ownerId }, data: { preferences: { defaultPermissionMode: PermissionMode.DEFAULT } } })),
  },
  {
    reason: 'NO_REPOSITORY',
    over: { accessLevel: 'OPEN_PR' },
    breaks: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { repoUrl: null, workDirIsGit: false } })),
    mends: async (w) => void (await db.workspace.update({ where: { id: w.workspaceId }, data: { workDirIsGit: true } })),
  },
  {
    reason: 'ACCESS_NOT_ENFORCEABLE',
    over: { accessLevel: 'OPEN_PR' },
    breaks: async (w, id) => {
      const origin = randomUUID();
      await db.session.create({
        data: {
          id: origin, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'chat', prompt: 'p',
          provider: 'opencode', engine: 'opencode', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
        },
      });
      await db.schedule.update({ where: { id }, data: { createdFromSessionId: origin } });
    },
    // The OpenCode conversation is also what the workspace last ran, which is the engine a run with no origin uses.
    mends: async (_w, id) => {
      const s = await scheduleOf(id);
      await db.schedule.update({ where: { id }, data: { createdFromSessionId: null } });
      await db.session.delete({ where: { id: s.createdFromSessionId! } });
    },
  },
];

for (const check of CHECKS) {
  test(`§6.1 ${check.reason}: the run and the schedule are HELD with the reason, nothing fires until resumed, and resume checks again`, { skip }, async () => {
    reset();
    at('2026-11-14T00:00:00Z');
    const w = await world(`held-${check.reason.toLowerCase()}`);
    const s = await created(w, check.over);
    await check.breaks(w, s.id);
    at('2026-11-14T02:00:00Z');
    const { started } = await fireAndStart(s.id);
    assert.deepEqual(started.map((r) => r.outcome), ['HELD']);
    const [run] = await runsOf(s.id);
    assert.equal(run.state, 'HELD');
    assert.equal(run.heldReason, check.reason);
    assert.equal(run.sessionId, null, 'no session was opened');
    let held = await scheduleOf(s.id);
    assert.equal(held.state, 'HELD');
    assert.equal(held.heldReason, check.reason);
    assert.equal(held.nextDueAt, null);
    at('2026-11-17T02:00:00Z');
    await runs.fireDue(1000);
    await runs.startDue(1000);
    assert.equal((await runsOf(s.id)).length, 1, 'a HELD schedule fires nothing');
    await refusedWith(schedules.resume(w.owner, s.id), 'SCHEDULE_START_CHECK_FAILED');
    held = await scheduleOf(s.id);
    assert.equal(held.state, 'HELD', 'still held while the check fails');
    await check.mends(w, s.id);
    const resumed = await schedules.resume(w.owner, s.id);
    assert.equal(resumed.state, 'ACTIVE');
    assert.equal(resumed.heldReason, null);
    assert.equal(resumed.nextDueAt!.toISOString(), '2026-11-18T02:00:00.000Z', 'from the next slot; nothing held is caught up');
  });
}

// =============================================================================================================
// §6.2 / §6.3 — the run's session
// =============================================================================================================

test('§6.2 a level each engine can enforce gets the nearest mode that is not wider; none is refused at create', { skip }, async () => {
  assert.equal(scheduleRunMode('CHECK_ONLY', 'claude'), PermissionMode.DONT_ASK, 'Claude Code\'s Plan does not check Bash (schedule-access.ts)');
  assert.equal(scheduleRunMode('OPEN_PR', 'claude'), PermissionMode.ACCEPT_EDITS);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'dsh'), PermissionMode.DONT_ASK, 'DeepSeek Harness has no Plan: its read-only sandbox');
  assert.equal(scheduleRunMode('OPEN_PR', 'dsh'), PermissionMode.DEFAULT, 'and no Accept Edits: Default asks before each write');
  assert.equal(scheduleRunMode('OPEN_PR', 'opencode'), null, 'OpenCode cannot ask, so it cannot edit under a level');
  assert.equal(scheduleRunMode('CHECK_ONLY', 'opencode'), PermissionMode.PLAN, 'its Plan refuses everything but reads');
  assert.equal(scheduleRunMode('CHECK_ONLY', 'codex'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('CHECK_ONLY', 'kimi'), PermissionMode.PLAN);
  assert.equal(scheduleRunMode('OPEN_PR', 'cursor'), PermissionMode.ACCEPT_EDITS);
  assert.deepEqual(scheduleRunDisallowedTools(['X'], 'CHECK_ONLY', 'codex'), ['X']);
  assert.deepEqual(scheduleRunDisallowedTools(['X'], 'OPEN_PR', 'claude'), ['X', ...OPEN_PR_DISALLOWED_TOOLS]);
  assert.ok(OPEN_PR_DISALLOWED_TOOLS.includes('mcp__orbit__session_merge'));

  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('not-enforceable');
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'chat', prompt: 'p',
      provider: 'opencode', engine: 'opencode', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
      permissionMode: PermissionMode.BYPASS,
    },
  });
  await refusedWith(
    schedules.create({ kind: 'SESSION', ownerId: w.ownerId, sessionId }, input({ accessLevel: 'OPEN_PR' })),
    'SCHEDULE_ACCESS_NOT_ENFORCEABLE',
  );
});

test('§6.3 the run is a new session: runSource SCHEDULE, scheduleRunId, the mode for its level, and a first turn of the scheduled-run block then the prompt', { skip }, async () => {
  reset();
  at('2026-11-13T00:00:00Z');
  const w = await world('session');
  const s = await created(w, {
    baseline: { key: 'codex@0.48.0', summary: 'Codex 0.48.0, same as pinned.' },
  });
  // Run 1: CHANGED, with a note for the next run.
  at('2026-11-13T02:00:00Z');
  const { started } = await fireAndStart(s.id);
  const first = await runOf(started[0].runId);
  await delivered(first.sessionId!, clockNow);
  advance(5 * MINUTE);
  await runs.report(w.ownerId, first.sessionId!, {
    outcome: 'CHANGED', key: 'codex@0.48.1', summary: 'Codex 0.48.1 is out.',
    note: 'release notes moved to github.com/openai/codex/releases, the old changelog URL is 404.',
  });
  // Run 2: what the session is opened with.
  at('2026-11-14T02:00:07Z');
  const second = (await fireAndStart(s.id)).started[0];
  const run = await runOf(second.runId);
  const session = await db.session.findUniqueOrThrow({ where: { id: run.sessionId! } });
  assert.equal(session.runSource, SessionRunSource.SCHEDULE);
  assert.equal(session.scheduleRunId, run.id);
  assert.equal(session.workspaceId, w.workspaceId);
  assert.equal(session.permissionMode, PermissionMode.DONT_ASK, 'CHECK_ONLY on Claude Code runs in Don\'t Ask (schedule-access.ts)');
  assert.equal(session.branch, null, 'with no worktree');
  assert.equal(session.promptByOrbit, true, 'the control plane wrote its first turn');
  assert.equal(session.openedBy, 'SCHEDULE', 'not a person\'s conversation, so never the workspace default');
  assert.equal(session.title, 'Codex stable check');
  assert.equal(
    session.prompt,
    [
      '<scheduled-run>',
      '  Run 2 of "Codex stable check", planned 2026-11-14T02:00:00Z (10:00 Asia/Shanghai), started 02:00:07Z.',
      '  The person asked: "每天北京时间 10 点检查 Codex 官方稳定版，有新版本才告诉我"',
      '  Last run: CHANGED on 2026-11-13.',
      '  Already reported (do not report again; link these instead of opening new ones):',
      '    codex@0.48.0  baseline',
      '    codex@0.48.1  first reported 2026-11-13',
      '  Note from the last run: release notes moved to github.com/openai/codex/releases, the old changelog URL is 404.',
      '  Access: CHECK_ONLY. Limit: 30 minutes.',
      '  When you are done, call mcp__orbit__schedule_run_report exactly once.',
      '</scheduled-run>',
      'Check the latest stable Codex release against the pinned version.',
    ].join('\n'),
  );
});

test('§6.2 an OPEN_PR run runs in Accept Edits, in a worktree when its workspace has them, with the merge and release tools taken away', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('open-pr');
  await db.workspace.update({ where: { id: w.workspaceId }, data: { enableWorktree: true } });
  const s = await created(w, { accessLevel: 'OPEN_PR' });
  at('2026-11-14T02:00:00Z');
  const { started } = await fireAndStart(s.id);
  const run = await runOf(started[0].runId);
  const session = await db.session.findUniqueOrThrow({
    where: { id: run.sessionId! },
    include: { scheduleRun: { select: { schedule: { select: { accessLevel: true } } } } },
  });
  assert.equal(session.permissionMode, PermissionMode.ACCEPT_EDITS);
  assert.notEqual(session.branch, null, 'its own worktree');
  assert.deepEqual(
    scheduleRunDisallowedTools([], session.scheduleRun?.schedule.accessLevel, session.provider),
    [...OPEN_PR_DISALLOWED_TOOLS],
    'what the claim hands the runner as disallowedTools for this session',
  );
});

// =============================================================================================================
// §7.1 — the report
// =============================================================================================================

test('§7.1 the report: only from the run\'s session, CHANGED needs a key, once per run, and the note replaces the schedule\'s', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('report');
  const { schedule: s, sessionId, run } = await runningRun(w);
  const stranger = randomUUID();
  await db.session.create({
    data: {
      id: stranger, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'chat', prompt: 'p',
      provider: 'claude', engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await refusedWith(runs.report(w.ownerId, stranger, { outcome: 'NO_CHANGE', summary: 's' }), 'SCHEDULE_RUN_REPORT_NOT_A_RUN');
  await refusedWith(runs.report(w.ownerId, sessionId, { outcome: 'CHANGED', summary: 's' }), 'SCHEDULE_REPORT_KEY_REQUIRED');
  await db.schedule.update({ where: { id: s.id }, data: { note: 'old note' } });
  const first = await runs.report(w.ownerId, sessionId, {
    outcome: 'CHANGED', key: 'codex@0.48.1', summary: 'new release', links: ['https://example.com/a'], note: 'new note',
  });
  assert.equal(first.run.state, 'CHANGED');
  assert.equal(first.newFinding, true);
  assert.equal((await scheduleOf(s.id)).note, 'new note', 'the note replaces the schedule\'s');
  await refusedWith(runs.report(w.ownerId, sessionId, { outcome: 'NO_CHANGE', summary: 'again' }), 'SCHEDULE_RUN_ALREADY_REPORTED');
  assert.equal((await runOf(run.id)).state, 'CHANGED', 'nothing after the report changes the run');
  assert.deepEqual(calls, [], 'a CHANGED run keeps its session open');

  // The same key next run: not new, lastSeenRunId moves, links merge; an omitted note keeps the note.
  at('2026-11-15T02:00:00Z');
  const next = (await fireAndStart(s.id)).started[0];
  const nextRun = await runOf(next.runId);
  await delivered(nextRun.sessionId!, clockNow);
  const again = await runs.report(w.ownerId, nextRun.sessionId!, {
    outcome: 'CHANGED', key: 'codex@0.48.1', summary: 'same release', links: ['https://example.com/b'],
  });
  assert.equal(again.newFinding, false);
  const finding = await db.scheduleFinding.findUniqueOrThrow({ where: { scheduleId_key: { scheduleId: s.id, key: 'codex@0.48.1' } } });
  assert.equal(finding.firstRunId, run.id);
  assert.equal(finding.lastSeenRunId, nextRun.id);
  assert.deepEqual(finding.links, ['https://example.com/a', 'https://example.com/b']);
  assert.equal((await scheduleOf(s.id)).note, 'new note');
});

test('§7.1 a baseline key is not new; a NO_CHANGE run completes its session once its turn settles', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('baseline');
  const { sessionId } = await runningRun(w, { baseline: { key: 'codex@0.48.0' } });
  const changed = await runs.report(w.ownerId, sessionId, { outcome: 'CHANGED', key: 'codex@0.48.0', summary: 'same as baseline' });
  assert.equal(changed.newFinding, false, 'the baseline was already told');

  at('2026-11-14T00:00:00Z');
  const w2 = await world('no-change');
  const { sessionId: s2 } = await runningRun(w2);
  await runs.report(w2.ownerId, s2, { outcome: 'NO_CHANGE', summary: 'nothing new' });
  assert.deepEqual(calls, [], 'the turn is still running: not completed under it');
  await db.session.update({ where: { id: s2 }, data: { status: 'AWAITING_INPUT' } });
  assert.deepEqual(await runs.completeNoChangeSessions(), [s2]);
  assert.deepEqual(calls, [{ op: 'complete', sessionId: s2 }]);
});

// =============================================================================================================
// §7.1 / §7.2 — ending without a report
// =============================================================================================================

test('§7.1 NO_REPORT: a session that settles idle, or ends, without a report fails its run, which is not retried', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('no-report');
  const { run, sessionId } = await runningRun(w);
  advance(3 * MINUTE);
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED', 'still working');
  await db.conversationTurn.updateMany({ where: { sessionId }, data: { status: 'ANSWERED' } });
  await db.session.update({ where: { id: sessionId }, data: { status: 'AWAITING_INPUT' } });
  assert.equal(await runs.reconcileRun(run.id), 'FAILED');
  const failed = await runOf(run.id);
  assert.equal(failed.failureReason, 'NO_REPORT');
  assert.equal(failed.attempt, 1);

  at('2026-11-14T00:00:00Z');
  const w2 = await world('no-report-ended');
  const { run: r2, sessionId: s2 } = await runningRun(w2);
  await db.session.update({ where: { id: s2 }, data: { completedAt: clockNow } });
  assert.equal(await runs.reconcileRun(r2.id), 'FAILED');
  assert.equal((await runOf(r2.id)).failureReason, 'NO_REPORT');
});

test('§7.2 RUN_LIMIT: a run past runLimitMinutes from its delivery is interrupted and fails', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('run-limit');
  const { run, sessionId } = await runningRun(w, { runLimitMinutes: 20 });
  advance(19 * MINUTE);
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED');
  advance(MINUTE);
  assert.equal(await runs.reconcileRun(run.id), 'FAILED');
  assert.equal((await runOf(run.id)).failureReason, 'RUN_LIMIT');
  assert.deepEqual(calls, [{ op: 'interrupt', sessionId }]);
});

test('§7.2 RUN_LIMIT counts working time: minutes spent waiting on an answered card are not counted', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('run-limit-card');
  const { run, sessionId } = await runningRun(w, { runLimitMinutes: 20 });
  advance(10 * MINUTE);
  const card = await db.approval.create({ data: { sessionId, toolName: 'Bash', input: { command: 'ls' }, createdAt: clockNow } });
  advance(30 * MINUTE);
  await db.approval.update({ where: { id: card.id }, data: { status: 'ALLOWED', decidedAt: clockNow } });
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED', '10 minutes of work, 30 on a card');
  advance(10 * MINUTE);
  assert.equal(await runs.reconcileRun(run.id), 'FAILED', '20 minutes of work');
  assert.equal((await runOf(run.id)).failureReason, 'RUN_LIMIT');
});

test('§6.4 / §7.2 a card moves the run to AWAITING_APPROVAL; an answer moves it back; two hours unanswered is APPROVAL_TIMEOUT', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('approval');
  const { run, sessionId } = await runningRun(w, { runLimitMinutes: 120 });
  const card = await db.approval.create({
    data: { sessionId, toolName: 'WebFetch', input: { url: 'https://example.com' }, createdAt: clockNow },
  });
  assert.equal(await runs.reconcileRun(run.id), 'AWAITING_APPROVAL');
  await db.approval.update({ where: { id: card.id }, data: { status: 'ALLOWED', decidedAt: clockNow } });
  assert.equal(await runs.reconcileRun(run.id), 'RUNNING');
  advance(MINUTE);
  await db.approval.create({ data: { sessionId, toolName: 'Bash', input: { command: 'curl x' }, createdAt: clockNow } });
  assert.equal(await runs.reconcileRun(run.id), 'AWAITING_APPROVAL');
  advance(SCHEDULE_APPROVAL_TIMEOUT_MS - 1);
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED', 'time on a card does not count toward the 120-minute limit');
  advance(1);
  assert.equal(await runs.reconcileRun(run.id), 'FAILED');
  assert.equal((await runOf(run.id)).failureReason, 'APPROVAL_TIMEOUT');
  assert.deepEqual(calls, [{ op: 'interrupt', sessionId }]);
});

test('§5.2 / §7.2 a run that never reached its engine (no delivered_at) is retried after 1, 5 and 15 minutes, then hourly inside its catch-up window, then MISSED, never FAILED', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('retry');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  await fireAndStart(s.id);
  const [run] = await runsOf(s.id);
  const sessions: string[] = [];
  for (const [attempt, wait] of [[1, 1], [2, 5], [3, 15], [4, 60]] as const) {
    const current = await runOf(run.id);
    assert.equal(current.state, 'RUNNING');
    assert.equal(current.attempt, attempt);
    sessions.push(current.sessionId!);
    const error = attempt === 4 ? "You've hit your usage limit. Try again later." : 'spawn failed';
    await db.session.update({ where: { id: current.sessionId! }, data: { status: 'FAILED', error, retryAt: FUTURE } });
    assert.equal(await runs.reconcileRun(run.id), 'RETRY');
    const waiting = await runOf(run.id);
    assert.equal(waiting.state, 'QUEUED');
    assert.equal(waiting.notBeforeAt!.getTime(), clockNow.getTime() + wait * MINUTE, `attempt ${attempt + 1} waits ${wait} min`);
    assert.equal(waiting.failureReason, attempt === 4 ? 'QUOTA' : 'ENGINE_CRASHED_BEFORE_START');
    const retired = await db.session.findUniqueOrThrow({ where: { id: current.sessionId! } });
    assert.equal(retired.retryAt, null, 'its auto-retry is cancelled, so it cannot come back beside the next one');
    advance(wait * MINUTE - 1);
    assert.deepEqual(await runs.startDue(25, s.id), [], 'not before its wait is over');
    advance(1);
    assert.deepEqual((await runs.startDue(25, s.id)).map((r) => r.outcome), ['STARTED']);
    assert.equal((await liveSessionsOf(run.id)).length, 1, 'one live session for the run, the new one');
  }
  assert.equal((await scheduleOf(s.id)).consecutiveFailures, 0, 'a run that never started is not a failure');
  // The next hourly attempt would start after the window (02:00Z the next day) closes: the slot is MISSED.
  at('2026-11-15T01:30:00Z');
  const late = await runOf(run.id);
  await db.session.update({ where: { id: late.sessionId! }, data: { status: 'FAILED', error: 'spawn failed' } });
  assert.equal(await runs.reconcileRun(run.id), 'MISSED');
  const missed = await runOf(run.id);
  assert.equal(missed.state, 'MISSED');
  assert.equal(missed.failureReason, 'ENGINE_CRASHED_BEFORE_START');
  assert.equal((await scheduleOf(s.id)).consecutiveFailures, 0);
  assert.equal(new Set([...sessions, late.sessionId]).size, 5, 'each attempt is its own session');
});

test('§5.2 a ONCE run failing before delivery near the end of its 24-hour window is MISSED rather than retried past it', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('retry-window');
  const s = await created(w, { rule: { kind: 'ONCE', at: '2026-11-14T10:00' } });
  at('2026-11-15T01:59:30Z'); // 23 h 59 m 30 s after its 02:00Z slot
  const { started } = await fireAndStart(s.id);
  const run = await runOf(started[0].runId);
  assert.equal(run.trigger, 'CATCH_UP');
  await db.session.update({ where: { id: run.sessionId! }, data: { status: 'FAILED', error: 'spawn failed' } });
  assert.equal(await runs.reconcileRun(run.id), 'MISSED', 'a retry in a minute would be past the window');
  assert.equal((await scheduleOf(s.id)).consecutiveFailures, 0);
});

test('§7.2 a run whose first turn was delivered is never retried: ENGINE_CRASHED', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('no-retry');
  const { run, sessionId } = await runningRun(w);
  await db.session.update({ where: { id: sessionId }, data: { status: 'FAILED', error: 'engine exited' } });
  assert.equal(await runs.reconcileRun(run.id), 'FAILED');
  const failed = await runOf(run.id);
  assert.equal(failed.failureReason, 'ENGINE_CRASHED');
  assert.equal(failed.attempt, 1);
  assert.equal(failed.notBeforeAt, null);
  const after = await scheduleOf(run.scheduleId);
  assert.equal(after.consecutiveFailures, 1, 'counted');
  assert.equal(after.state, 'ACTIVE', 'and the schedule goes on');
  assert.notEqual(after.nextDueAt, null);
});

test('§5.2 a runner offline at the start is a missed slot: the run waits without a session or an attempt, starts when the runner is back, and is MISSED past its window', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('offline', { runnerStatus: RunnerStatus.OFFLINE });
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const { started } = await fireAndStart(s.id);
  assert.deepEqual(started.map((r) => r.outcome), ['WAITING']);
  let run = (await runsOf(s.id))[0];
  assert.equal(run.state, 'QUEUED');
  assert.equal(run.attempt, 1, 'no attempt spent');
  assert.equal(run.failureReason, 'RUNNER_UNAVAILABLE');
  assert.deepEqual(opened, []);
  advance(3 * HOUR);
  assert.deepEqual((await runs.startDue(25, s.id)).map((r) => r.outcome), ['WAITING'], 'still away');
  await db.runner.update({ where: { id: w.runnerId }, data: { status: RunnerStatus.ONLINE, lastHeartbeatAt: FUTURE } });
  advance(MINUTE);
  assert.deepEqual((await runs.startDue(25, s.id)).map((r) => r.outcome), ['STARTED'], 'back: the slot runs, late');
  run = await runOf(run.id);
  assert.equal(run.state, 'RUNNING');
  assert.equal(run.plannedAt.toISOString(), '2026-11-14T02:00:00.000Z');

  at('2026-11-14T00:00:00Z');
  const w2 = await world('offline-past-window', { runnerStatus: RunnerStatus.OFFLINE });
  const s2 = await created(w2, { rule: { kind: 'ONCE', at: '2026-11-14T10:00' } });
  at('2026-11-14T02:00:00Z');
  await fireAndStart(s2.id);
  at('2026-11-15T02:00:01Z');
  assert.deepEqual((await runs.startDue(25, s2.id)).map((r) => r.outcome), ['MISSED']);
  const missed = (await runsOf(s2.id))[0];
  assert.equal(missed.state, 'MISSED');
  assert.equal(missed.failureReason, 'RUNNER_UNAVAILABLE');
  assert.equal((await scheduleOf(s2.id)).consecutiveFailures, 0, 'not a failure');
});

test('§5.2 a managed runner asleep is not absent: the run opens its session, which is what wakes the runner', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('managed', { runnerStatus: RunnerStatus.OFFLINE });
  // The managed runner's default workspace is another one on the same machine: the default's first-session runtime
  // preflight is not what this test is about.
  const home = await db.workspace.create({ data: { ownerId: w.ownerId, runnerId: w.runnerId, name: 'managed-home', enabled: true } });
  await db.managedRunner.create({
    data: {
      ownerId: w.ownerId, runnerId: w.runnerId, defaultWorkspaceId: home.id,
      clusterKey: 'lab', namespace: `ns-${RUN}`, pvcName: `mr-data-${w.runnerId}`,
    },
  });
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const { started } = await fireAndStart(s.id);
  assert.deepEqual(started.map((r) => r.outcome), ['STARTED']);
  assert.equal(opened.length, 1);
});

test('§6 A1: a create that fails after its INSERT keeps that session as the run\'s; a fault before it retries; a refusal before it HOLDS, not retried', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('open-after');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  failOpen = 'after';
  const { started } = await fireAndStart(s.id);
  assert.deepEqual(started.map((r) => r.outcome), ['STARTED']);
  const run = await runOf(started[0].runId);
  assert.equal(run.state, 'RUNNING');
  assert.equal(run.sessionId, opened[0].sessionId);
  assert.deepEqual((await liveSessionsOf(run.id)).map((x) => x.id), [run.sessionId], 'exactly one live session, the one written');

  at('2026-11-14T00:00:00Z');
  const w2 = await world('open-fault');
  const s2 = await created(w2);
  at('2026-11-14T02:00:00Z');
  failOpen = 'fault';
  const second = await fireAndStart(s2.id);
  assert.deepEqual(second.started.map((r) => r.outcome), ['RETRY']);
  const r2 = (await runsOf(s2.id))[0];
  assert.equal(r2.failureReason, 'RUNNER_UNAVAILABLE');
  assert.equal(r2.attempt, 2);
  assert.equal((await liveSessionsOf(r2.id)).length, 0);

  at('2026-11-14T00:00:00Z');
  const w3 = await world('open-refused');
  const s3 = await created(w3);
  at('2026-11-14T02:00:00Z');
  failOpen = 'refuse';
  const third = await fireAndStart(s3.id);
  assert.deepEqual(third.started.map((r) => r.outcome), ['HELD']);
  const r3 = (await runsOf(s3.id))[0];
  assert.equal(r3.state, 'HELD');
  assert.equal(r3.heldReason, 'SESSION_REFUSED');
  assert.equal(r3.attempt, 1, 'not retried');
  const held = await scheduleOf(s3.id);
  assert.equal(held.state, 'HELD');
  assert.equal(held.heldReason, 'SESSION_REFUSED');
});

test('§7.2 A2: undelivered for 10 minutes, the session is retired first and only then the run re-queued; one live session after the retry starts', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('undelivered');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const { started } = await fireAndStart(s.id);
  const run = await runOf(started[0].runId);
  const first = run.sessionId!;
  advance(10 * MINUTE - 1);
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED');
  advance(1);
  // The retire fails: nothing moves, and the session is still the run's.
  failEnd = true;
  assert.equal(await runs.reconcileRun(run.id), 'DEFERRED');
  assert.equal((await runOf(run.id)).state, 'RUNNING');
  assert.equal((await runOf(run.id)).sessionId, first);
  failEnd = false;
  assert.equal(await runs.reconcileRun(run.id), 'RETRY');
  const ended = await db.session.findUniqueOrThrow({ where: { id: first } });
  assert.equal(ended.status, 'CANCELLED', 'the superseded session is ended: no claim takes a CANCELLED session');
  assert.equal((await runOf(run.id)).failureReason, 'RUNNER_UNAVAILABLE');
  advance(MINUTE);
  await runs.startDue(25, s.id);
  const live = await liveSessionsOf(run.id);
  assert.equal(live.length, 1);
  assert.notEqual(live[0].id, first);
  // The old session reports: it no longer serves the run.
  await refusedWith(runs.report(w.ownerId, first, { outcome: 'NO_CHANGE', summary: 's' }), 'SCHEDULE_RUN_REPORT_NOT_A_RUN');
});

test('§7.2 A2: a process that died after retiring but before re-queueing, or a session left alive, still ends with one live session', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('died-between');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const run = await runOf((await fireAndStart(s.id)).started[0].runId);
  // Retired, and the process died there: the run is still RUNNING on an ended, undelivered session.
  await db.session.update({ where: { id: run.sessionId! }, data: { status: 'CANCELLED', cancelRequestedAt: clockNow } });
  assert.equal(await runs.reconcileRun(run.id), 'RETRY');
  // A session of the run left alive (a create that committed after its caller gave up) is retired before a new one.
  const stray = randomUUID();
  await db.session.create({
    data: {
      id: stray, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'stray', prompt: 'p',
      provider: 'claude', engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.SCHEDULE, scheduleRunId: run.id,
    },
  });
  advance(MINUTE);
  assert.deepEqual((await runs.startDue(25, s.id)).map((r) => r.outcome), ['STARTED']);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: stray } })).status, 'CANCELLED');
  const live = await liveSessionsOf(run.id);
  assert.equal(live.length, 1);
  assert.equal(live[0].id, (await runOf(run.id)).sessionId);
});

test('§7.2 a run whose session never appeared is retried after 10 minutes (ENGINE_CRASHED_BEFORE_START)', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('never-appeared');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const run = await runOf((await fireAndStart(s.id)).started[0].runId);
  const ghost = randomUUID();
  await db.scheduleRun.update({ where: { id: run.id }, data: { sessionId: ghost } });
  advance(10 * MINUTE - 1);
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED');
  advance(1);
  assert.equal(await runs.reconcileRun(run.id), 'RETRY');
  assert.equal((await runOf(run.id)).failureReason, 'ENGINE_CRASHED_BEFORE_START');
});

test('§8.4 a retry is CANCELLED when its schedule was paused meanwhile; a MANUAL run on a paused schedule still retries', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('paused-retry');
  const s = await created(w);
  at('2026-11-14T02:00:00Z');
  const run = await runOf((await fireAndStart(s.id)).started[0].runId);
  await schedules.pause(w.owner, s.id);
  await db.session.update({ where: { id: run.sessionId! }, data: { status: 'FAILED', error: 'spawn failed' } });
  assert.equal(await runs.reconcileRun(run.id), 'CANCELLED');
  assert.equal((await runOf(run.id)).state, 'CANCELLED');
  advance(HOUR);
  assert.deepEqual(await runs.startDue(25, s.id), []);

  const manual = await runs.runNow(w.owner, s.id);
  const m = await runOf(manual.id);
  await db.session.update({ where: { id: m.sessionId! }, data: { status: 'FAILED', error: 'spawn failed' } });
  assert.equal(await runs.reconcileRun(manual.id), 'RETRY');
});

test('a QUEUED run whose start throws on every pass is put aside so others start, and is MISSED once its window has passed', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('start-throws');
  const broken = await created(w, { title: 'broken' });
  const fine = await created(w, { title: 'fine' });
  at('2026-11-14T02:00:00Z');
  await runs.fire(broken.id);
  await runs.fire(fine.id);
  await db.$executeRaw`UPDATE "schedule" SET "rule" = '{"kind":"HOURLY"}'::jsonb WHERE "id" = ${broken.id}::uuid`;
  // The broken run is the oldest, so a batch of one reaches it first.
  await db.scheduleRun.updateMany({ where: { scheduleId: broken.id }, data: { plannedAt: new Date('2026-11-14T01:59:00Z') } });
  const outcomes = await runs.startDue(1);
  assert.equal(outcomes.length, 0, 'the broken run threw');
  const [aside] = await runsOf(broken.id);
  assert.equal(aside.state, 'QUEUED');
  assert.ok(aside.notBeforeAt && aside.notBeforeAt > clockNow, 'put aside');
  const next = await runs.startDue(1);
  assert.deepEqual(next.map((r) => r.outcome), ['STARTED'], 'the next pass reaches the other schedule');
  at('2026-11-15T01:59:01Z');
  await runs.startDue(25, broken.id);
  assert.equal((await runsOf(broken.id))[0].state, 'MISSED', 'no run waits for ever');
});

test('§6.1 a creating session moved to Trash no longer decides the run\'s engine', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('origin-deleted');
  const s = await created(w);
  const origin = randomUUID();
  await db.session.create({
    data: {
      id: origin, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'chat', prompt: 'p',
      provider: 'kimi', engine: 'kimi', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, deletedAt: clockNow,
    },
  });
  await db.schedule.update({ where: { id: s.id }, data: { createdFromSessionId: origin } });
  at('2026-11-14T02:00:00Z');
  await fireAndStart(s.id);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].engine, null, 'not pinned to the deleted session\'s engine');
});

test('§7.2 consecutive failures are counted and never pause the schedule; a result resets the count', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('failures');
  const s = await created(w);
  for (const day of ['14', '15', '16']) {
    at(`2026-11-${day}T02:00:00Z`);
    const { started } = await fireAndStart(s.id);
    const run = await runOf(started[0].runId);
    await delivered(run.sessionId!, clockNow);
    await runs.report(w.ownerId, run.sessionId!, { outcome: 'FAILED', summary: 'the release page did not load' });
  }
  let after = await scheduleOf(s.id);
  assert.equal(after.consecutiveFailures, 3);
  assert.equal(after.state, 'ACTIVE', 'not paused');
  assert.equal(after.nextDueAt!.toISOString(), '2026-11-17T02:00:00.000Z', 'and still firing');
  assert.deepEqual((await runsOf(s.id)).map((r) => r.failureReason), ['REPORTED_FAILED', 'REPORTED_FAILED', 'REPORTED_FAILED']);
  at('2026-11-17T02:00:00Z');
  const { started } = await fireAndStart(s.id);
  const run = await runOf(started[0].runId);
  await delivered(run.sessionId!, clockNow);
  await runs.report(w.ownerId, run.sessionId!, { outcome: 'NO_CHANGE', summary: 'fine again' });
  after = await scheduleOf(s.id);
  assert.equal(after.consecutiveFailures, 0);
});

test('§7.4 CHANGED and FAILED runs leave their sessions open after they settle; only NO_CHANGE completes', { skip }, async () => {
  reset();
  for (const outcome of ['CHANGED', 'FAILED'] as const) {
    at('2026-11-14T00:00:00Z');
    const w = await world(`open-${outcome.toLowerCase()}`);
    const { sessionId } = await runningRun(w);
    await runs.report(w.ownerId, sessionId, { outcome, key: outcome === 'CHANGED' ? 'k@1' : undefined, summary: 's' });
    await db.session.update({ where: { id: sessionId }, data: { status: 'AWAITING_INPUT' } });
    assert.ok(!(await runs.completeNoChangeSessions(1000)).includes(sessionId), `${outcome} keeps its session`);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).completedAt, null);
  }
  assert.deepEqual(calls.filter((c) => c.op === 'complete'), []);
});

test('§5 a run AWAITING_APPROVAL is in progress: the next slot is QUEUED behind it', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('overlap-approval');
  const { schedule: s, run, sessionId } = await runningRun(w, { runLimitMinutes: 120 });
  await db.approval.create({ data: { sessionId, toolName: 'Bash', input: { command: 'curl x' }, createdAt: clockNow } });
  assert.equal(await runs.reconcileRun(run.id), 'AWAITING_APPROVAL');
  at('2026-11-14T02:30:00Z');
  await db.schedule.update({ where: { id: s.id }, data: { nextDueAt: clockNow } });
  await fireAndStart(s.id);
  assert.deepEqual((await runsOf(s.id)).map((r) => r.state), ['AWAITING_APPROVAL', 'QUEUED']);
});

test('§7.2 consecutiveFailures resets on CHANGED', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('reset-changed');
  const { schedule: s, sessionId } = await runningRun(w);
  await db.schedule.update({ where: { id: s.id }, data: { consecutiveFailures: 2 } });
  await runs.report(w.ownerId, sessionId, { outcome: 'CHANGED', key: 'k@2', summary: 'new' });
  assert.equal((await scheduleOf(s.id)).consecutiveFailures, 0);
});

// =============================================================================================================
// §8.4 — Run now and Stop this run
// =============================================================================================================

test('§8.4 Run now writes a MANUAL run under the overlap rule, works when PAUSED, is refused when ENDED, and changes no budget', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('run-now');
  const s = await created(w);
  await schedules.pause(w.owner, s.id);
  const manual = await runs.runNow(w.owner, s.id);
  assert.equal(manual.trigger, 'MANUAL');
  assert.equal((await runOf(manual.id)).state, 'RUNNING', 'it starts at once when nothing runs');
  const second = await runs.runNow(w.owner, s.id);
  assert.equal((await runOf(second.id)).state, 'QUEUED', 'behind the running one');
  const third = await runs.runNow(w.owner, s.id);
  assert.equal((await runOf(second.id)).state, 'SKIPPED');
  assert.equal((await runOf(third.id)).state, 'QUEUED');
  const after = await scheduleOf(s.id);
  assert.equal(after.envelopeRunsPerWeek, 7, 'runs per week is the rule\'s, not a count of runs');
  assert.equal(after.state, 'PAUSED');
  await schedules.remove(w.owner, s.id);
  await refusedWith(runs.runNow(w.owner, s.id), 'SCHEDULE_ENDED');
});

test('§8.4 Stop this run: CANCELLED (CANCELLED_BY_OWNER), its session interrupted, the schedule unchanged, and the next queued run starts', { skip }, async () => {
  reset();
  at('2026-11-14T00:00:00Z');
  const w = await world('stop');
  const { schedule: s, run, sessionId } = await runningRun(w);
  const queued = await runs.runNow(w.owner, s.id);
  const stopped = await runs.stopRun(w.owner, run.id);
  assert.equal(stopped.state, 'CANCELLED');
  assert.equal(stopped.failureReason, 'CANCELLED_BY_OWNER');
  assert.deepEqual(calls, [{ op: 'interrupt', sessionId }]);
  assert.equal((await runOf(queued.id)).state, 'RUNNING');
  const after = await scheduleOf(s.id);
  assert.equal(after.state, 'ACTIVE');
  assert.equal(after.consecutiveFailures, 0, 'a stop is not a failure');
  await refusedWith(runs.stopRun(w.owner, run.id), 'SCHEDULE_RUN_NOT_ACTIVE');
});

