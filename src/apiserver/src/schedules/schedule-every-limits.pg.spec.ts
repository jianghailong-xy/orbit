/**
 * An EVERY rule's run limit and catch-up (docs/scheduled-tasks-design.md §5.2), against a real PostgreSQL migrated
 * from empty, through SchedulesService and the real firing pass:
 *
 *   1. a run limit not shorter than the interval is refused, on create and on update;
 *   2. an EVERY rule without a run limit gets half its interval, at most 30 minutes;
 *   3. after a 3-hour outage an EVERY 60 schedule runs one CATCH_UP for the latest slot and records the earlier ones
 *      MISSED; a latest slot older than one interval (the day's last, its next one the next morning) is MISSED.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-every-limits.pg.spec.ts
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
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import { catchUpWindowMs, ScheduleRunsService, type ScheduleRunSessionPort } from './schedule-runs.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const FUTURE = new Date('2100-01-01T00:00:00Z');

let db: PrismaClient;
let pg: Client;
let clockNow = new Date('2026-11-16T08:00:00Z');
const clock = () => clockNow;
let schedules: SchedulesService;
let runs: ScheduleRunsService;

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
  schedules = new SchedulesService(db as unknown as PrismaService, clock);
  runs = new ScheduleRunsService(db as unknown as PrismaService, port, clock, { notify: async () => undefined });
});

after(async () => {
  if (skip) return;
  await db.$disconnect();
  await pg.end();
});

interface World {
  ownerId: string;
  workspaceId: string;
  owner: ScheduleActor;
  /** An ordinary agent session of the owner, in Default mode, in the workspace. */
  session: ScheduleActor & { sessionId: string };
}

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-every-limits.invalid`, name: label, passwordHash: 'x' },
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
  return { ownerId, workspaceId, owner: { kind: 'OWNER', ownerId }, session: { kind: 'SESSION', ownerId, sessionId } };
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

const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const every = (minutes: number) => ({ kind: 'EVERY', minutes, time: '00:00', weekdays: ALL_DAYS });

async function refusedWith(promise: Promise<unknown>, code: string): Promise<string> {
  let message = '';
  await assert.rejects(promise, (err: unknown) => {
    const body = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string; message?: string } | undefined;
    assert.equal(body?.code, code, `expected ${code}, got ${JSON.stringify(body ?? String(err))}`);
    message = body?.message ?? '';
    return true;
  });
  return message;
}

async function runsOf(scheduleId: string) {
  const list = await db.scheduleRun.findMany({ where: { scheduleId }, orderBy: { plannedAt: 'asc' } });
  return list.map((r) => [r.plannedAt.toISOString(), r.trigger, r.state]);
}

// =============================================================================================================

test('1. a run limit not shorter than the EVERY interval is refused, on create and on update', { skip }, async () => {
  at('2026-11-16T08:05:00Z');
  const w = await world('every-limit');
  const message = await refusedWith(
    created(w, { rule: every(30), runLimitMinutes: 30 }),
    'SCHEDULE_RUN_LIMIT_NOT_SHORTER_THAN_INTERVAL',
  );
  assert.match(message, /not shorter than the 30-minute interval/);
  await refusedWith(created(w, { rule: every(60), runLimitMinutes: 90 }), 'SCHEDULE_RUN_LIMIT_NOT_SHORTER_THAN_INTERVAL');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0, 'nothing written');

  const s = await created(w, { rule: every(30), runLimitMinutes: 14 });
  assert.equal(s.runLimitMinutes, 14);

  // Update: a longer limit, or a shorter interval, that would reach the next slot is refused and changes nothing.
  await refusedWith(schedules.update(w.owner, s.id, { runLimitMinutes: 30 }), 'SCHEDULE_RUN_LIMIT_NOT_SHORTER_THAN_INTERVAL');
  const daily = await created(w, { rule: { kind: 'DAILY', time: '10:00' }, runLimitMinutes: 60 });
  assert.equal(daily.runLimitMinutes, 60, 'a DAILY rule keeps any limit');
  await refusedWith(schedules.update(w.owner, daily.id, { rule: every(60) }), 'SCHEDULE_RUN_LIMIT_NOT_SHORTER_THAN_INTERVAL');
  const unchanged = await db.schedule.findUniqueOrThrow({ where: { id: daily.id } });
  assert.deepEqual(unchanged.rule, { kind: 'DAILY', time: '10:00' });
  assert.equal(unchanged.runLimitMinutes, 60);
});

test('2. an EVERY rule without a run limit gets half its interval, at most 30 minutes', { skip }, async () => {
  at('2026-11-16T08:05:00Z');
  const w = await world('every-default');
  assert.equal((await created(w, { rule: every(60) })).runLimitMinutes, 30);
  assert.equal((await created(w, { rule: every(30) })).runLimitMinutes, 15);
  assert.equal((await created(w, { rule: every(720) })).runLimitMinutes, 30);
  assert.equal((await created(w, { rule: { kind: 'DAILY', time: '10:00' } })).runLimitMinutes, 30, 'DAILY keeps 30');
});

test('3. after a 3-hour outage EVERY 60 catches up the latest slot only; a slot older than one interval is MISSED', { skip }, async () => {
  at('2026-11-16T08:05:00Z');
  const w = await world('every-catch-up');
  const s = await created(w, { rule: every(60) });
  assert.equal(s.nextDueAt?.toISOString(), '2026-11-16T09:00:00.000Z');

  // Down from 09:00 to 12:20: four slots are due; 12:00 runs late as a CATCH_UP, 09:00-11:00 are MISSED.
  at('2026-11-16T12:20:00Z');
  assert.equal(await runs.fire(s.id), 'FIRED');
  assert.deepEqual(await runsOf(s.id), [
    ['2026-11-16T09:00:00.000Z', 'SCHEDULED', 'MISSED'],
    ['2026-11-16T10:00:00.000Z', 'SCHEDULED', 'MISSED'],
    ['2026-11-16T11:00:00.000Z', 'SCHEDULED', 'MISSED'],
    ['2026-11-16T12:00:00.000Z', 'CATCH_UP', 'QUEUED'],
  ]);
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).nextDueAt?.toISOString(), '2026-11-16T13:00:00.000Z');

  // The day's last slot, 12:00 of a 09:00-12:00 window: its next slot is tomorrow's 09:00, but its catch-up still
  // reaches back one interval, so at 13:30 it is MISSED rather than run 90 minutes late.
  const windowed = await created(w, { rule: { ...every(60), time: '09:00', until: '12:00' } });
  assert.equal(windowed.nextDueAt?.toISOString(), '2026-11-17T09:00:00.000Z');
  at('2026-11-17T13:30:00Z');
  assert.equal(await runs.fire(windowed.id), 'MISSED');
  assert.deepEqual((await runsOf(windowed.id)).map(([, trigger, state]) => [trigger, state]), [
    ['SCHEDULED', 'MISSED'], ['SCHEDULED', 'MISSED'], ['SCHEDULED', 'MISSED'], ['SCHEDULED', 'MISSED'],
  ]);
  // Inside one interval, the same last slot is caught up.
  at('2026-11-18T12:45:00Z');
  assert.equal(await runs.fire(windowed.id), 'FIRED');
  const last = (await runsOf(windowed.id)).at(-1);
  assert.deepEqual(last, ['2026-11-18T12:00:00.000Z', 'CATCH_UP', 'QUEUED']);

  // The retry window of a run that never reached its engine is the same one interval.
  const rule = { kind: 'EVERY' as const, minutes: 60, time: '09:00', until: '12:00', weekdays: ALL_DAYS as never };
  assert.equal(catchUpWindowMs(rule, 'UTC', new Date('2026-11-18T12:00:00Z')), 60 * MINUTE);
});
