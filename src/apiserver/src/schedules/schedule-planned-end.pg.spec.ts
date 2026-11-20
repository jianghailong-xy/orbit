/**
 * A schedule's planned end (docs/scheduled-tasks-design.md §8.5), against a real PostgreSQL migrated from empty,
 * through SchedulesService, ScheduleReadsService and the real firing, starting and telling passes:
 *
 *   1. a schedule with maxRuns 3 ends END_REACHED in the transaction that starts its third run, and once that run is
 *      over the owner gets exactly one push, "Stopped as planned after 3 runs", from the worker's own pass;
 *   2. a schedule with endAt ends after its last slot at or before endAt (a slot exactly at it, or the last one before
 *      it on an EVERY rule), and gets exactly one push once that slot's run is over, landing included; a ONCE rule's
 *      end sends none;
 *   3. an EVERY create card that names no end carries a suggested end 7 days out (the same local time, across a
 *      daylight-saving change); Create writes it, and Create with No end writes none, and the decided card reads
 *      which; a named end is not suggested and DAILY gets no suggestion;
 *   4. the list row carries endAt, maxRuns, runsStarted and runsLeft; maxRuns at or below the runs started is refused,
 *      before any card.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-planned-end.pg.spec.ts
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
import type { ScheduleAlert, ScheduleNotifier } from './schedule-attention';
import { ScheduleReadsService } from './schedule-reads.service';
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import { ScheduleRunsService, type ScheduleRunSessionPort } from './schedule-runs.service';
import { SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';
import { ScheduleWorker } from './schedule.worker';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 60 * 60_000;
const FUTURE = new Date('2100-01-01T00:00:00Z');

let db: PrismaClient;
let pg: Client;
let clockNow = new Date('2026-11-16T08:00:00Z');
const clock = () => clockNow;
let schedules: SchedulesService;
let runs: ScheduleRunsService;
let reads: ScheduleReadsService;
let worker: ScheduleWorker;
let alerts: ScheduleAlert[] = [];

function at(iso: string | Date): Date {
  clockNow = new Date(iso);
  return clockNow;
}

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  // The real create door; every runner and realtime side effect is a no-op: what is under test is the rows and pushes.
  const quiet = new Proxy({}, { get: () => () => undefined });
  const real = new SessionsScheduleRunPort(new SessionsService(db as never, quiet as never, quiet as never));
  const port: ScheduleRunSessionPort = {
    land: (owner, sessionId) => real.land(owner, sessionId),
    open: (input) => real.open(input),
    interrupt: async () => undefined,
    complete: async (_owner, sessionId) => void (await db.session.update({ where: { id: sessionId }, data: { completedAt: clockNow } })),
    end: (owner, sessionId) => real.end(owner, sessionId),
  };
  const notifier: ScheduleNotifier = { notify: async (alert) => void alerts.push(alert) };
  schedules = new SchedulesService(db as unknown as PrismaService, clock, notifier);
  runs = new ScheduleRunsService(db as unknown as PrismaService, port, clock, notifier);
  reads = new ScheduleReadsService(db as unknown as PrismaService);
  // Its passes run here one at a time, never on its own timer.
  worker = new ScheduleWorker(runs);
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
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-planned-end.invalid`, name: label, passwordHash: 'x' },
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

const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const every = (minutes: number) => ({ kind: 'EVERY', minutes, time: '00:00', weekdays: ALL_DAYS });

function input(over: Partial<ScheduleCreateInput> = {}): ScheduleCreateInput {
  return {
    intent: 'Check the Codex stable release',
    title: 'Codex stable check',
    prompt: 'Check the latest stable Codex release against the pinned version.',
    rule: { kind: 'DAILY', time: '10:00' },
    timezone: 'UTC',
    accessLevel: 'CHECK_ONLY',
    ...over,
  };
}

async function created(w: World, over: Partial<ScheduleCreateInput>) {
  const result = await schedules.create(w.owner, { workspaceId: w.workspaceId, ...input(over) });
  assert.equal(result.outcome, 'CREATED');
  return result.schedule;
}

/** A session's create card, its id. */
async function card(w: World, over: Partial<ScheduleCreateInput>): Promise<string> {
  const tag = randomUUID().slice(0, 6);
  const asked = await schedules.create(w.session, input({ title: `Card ${tag}`, intent: `Check the Codex stable release (${tag})`, ...over }));
  assert.equal(asked.outcome, 'PENDING');
  return (asked as { request: { id: string } }).request.id;
}

async function scheduleOf(id: string) {
  return db.schedule.findUniqueOrThrow({ where: { id } });
}

async function delivered(sessionId: string, deliveredAt: Date) {
  await db.conversationTurn.upsert({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId: `initial-${sessionId}` } },
    create: { sessionId, seq: 1, clientTurnId: `initial-${sessionId}`, content: 'x', status: 'IN_FLIGHT', deliveredAt },
    update: { deliveredAt },
  });
}

/** Fire the schedule's next slot and start its run, the first turn delivered. Returns the run's session. */
async function nextRun(scheduleId: string): Promise<string> {
  const s = await scheduleOf(scheduleId);
  at(s.nextDueAt!);
  assert.equal(await runs.fire(scheduleId), 'FIRED');
  const started = await runs.startDue(25, scheduleId);
  assert.equal(started[0]?.outcome, 'STARTED', 'the run starts');
  const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: started[0].runId } });
  await delivered(run.sessionId!, clockNow);
  return run.sessionId!;
}

async function finish(w: World, sessionId: string) {
  await runs.report(w.ownerId, sessionId, { outcome: 'NO_CHANGE', summary: 'Codex 0.48.0, same as pinned.' });
}

/** The telling pass, as it concerns this schedule (the pass is account-wide). */
async function told(scheduleId: string): Promise<string[]> {
  return (await runs.tellPlannedEnds()).filter((id) => id === scheduleId);
}

function plannedEnds(scheduleId: string): ScheduleAlert[] {
  return alerts.filter((a) => a.scheduleId === scheduleId && a.kind === 'PLANNED_END');
}

async function refusedWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const body = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
    assert.equal(body?.code, code, `expected ${code}, got ${JSON.stringify(body ?? String(err))}`);
    return true;
  });
}

async function listRow(w: World, scheduleId: string) {
  const { schedules: rows } = await reads.list(w.ownerId, { state: 'all' });
  const row = rows.find((r) => r.id === scheduleId);
  assert.ok(row, 'the schedule is listed');
  return row;
}

// =============================================================================================================

test('§8.5 maxRuns 3: ENDED (END_REACHED) when its third run starts, one push "Stopped as planned after 3 runs" once it is over', { skip }, async () => {
  const w = await world('max-runs');
  at('2026-11-16T08:00:00Z');
  const s = await created(w, { rule: every(60), maxRuns: 3 });
  assert.equal(s.maxRuns, 3);

  const first = await nextRun(s.id);
  await finish(w, first);
  const second = await nextRun(s.id);
  await finish(w, second);
  let row = await listRow(w, s.id);
  assert.deepEqual([row.endAt, row.maxRuns, row.runsStarted, row.runsLeft], [null, 3, 2, 1], 'the row reads "1 run left"');
  assert.equal((await scheduleOf(s.id)).state, 'ACTIVE', 'two runs started: still active');

  // A third run is planned in the hour after: the next slot fires and starts, and its start ends the schedule.
  const third = await nextRun(s.id);
  const ended = await scheduleOf(s.id);
  assert.equal(ended.state, 'ENDED');
  assert.equal(ended.endedReason, 'END_REACHED');
  assert.equal(ended.nextDueAt, null, 'no next slot');
  assert.equal(ended.endedAt?.toISOString(), clockNow.toISOString(), 'ended at the start that reached it');
  const thirdRun = await db.scheduleRun.findFirstOrThrow({ where: { sessionId: third } });
  assert.equal(thirdRun.state, 'RUNNING', 'the run that reached it goes on');

  // While it runs, nothing is told: its own push comes first.
  assert.deepEqual(await told(s.id), []);
  assert.deepEqual(plannedEnds(s.id), []);
  assert.equal((await scheduleOf(s.id)).plannedEndToldAt, null);

  await finish(w, third);
  // The worker's own pass tells it, now that the run is over.
  await worker.runPass();
  const pushed = plannedEnds(s.id);
  assert.equal(pushed.length, 1, 'exactly one push');
  assert.equal(pushed[0].body, 'Stopped as planned after 3 runs');
  assert.equal(pushed[0].title, 'Codex stable check');
  assert.deepEqual(pushed[0].opens, { scheduleId: s.id }, 'it opens the schedule');

  // Later passes, and the slots that would have come, send nothing more and start nothing.
  at(new Date(clockNow.getTime() + 3 * 60 * 60_000));
  assert.deepEqual((await runs.fireDue()).filter((f) => f.scheduleId === s.id), []);
  await worker.runPass();
  assert.deepEqual(await told(s.id), []);
  assert.equal(plannedEnds(s.id).length, 1, 'still exactly one push');
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id } }), 3, 'no run past the third was written');
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id, startedAt: { not: null } } }), 3, 'three runs started in all');
  row = await listRow(w, s.id);
  assert.deepEqual([row.state, row.endedReason, row.maxRuns, row.runsStarted, row.runsLeft], ['ENDED', 'END_REACHED', 3, 3, 0]);
});

test('§8.5 maxRuns: a retried start counts once, and nothing starts past the count', { skip }, async () => {
  const w = await world('max-runs-retry');
  at('2026-11-16T08:00:00Z');
  const s = await created(w, { rule: every(60), maxRuns: 1 });
  at('2026-11-16T09:00:00Z');
  assert.equal(await runs.fire(s.id), 'FIRED');
  const slotRun = await db.scheduleRun.findFirstOrThrow({ where: { scheduleId: s.id, state: 'QUEUED' } });
  assert.equal(await runs.start(slotRun.id), 'STARTED');
  assert.equal((await scheduleOf(s.id)).state, 'ENDED', 'its one run started: ENDED');

  // The start never reached its engine: the run is retried, the same row, and still counts as one start.
  const sessionId = (await db.scheduleRun.findUniqueOrThrow({ where: { id: slotRun.id } })).sessionId!;
  assert.equal(await runs.fail(slotRun.id, 'RUNNER_UNAVAILABLE', { sessionId }), 'RETRY');
  assert.equal((await db.scheduleRun.findUniqueOrThrow({ where: { id: slotRun.id } })).state, 'QUEUED');
  assert.deepEqual(await told(s.id), [], 'a run waiting for its retry is not over');
  at('2026-11-16T09:02:00Z');
  assert.equal(await runs.start(slotRun.id), 'STARTED', 'the retry starts on the ENDED schedule');
  const retried = await db.scheduleRun.findUniqueOrThrow({ where: { id: slotRun.id } });
  await delivered(retried.sessionId!, clockNow);
  await finish(w, retried.sessionId!);
  assert.deepEqual(await told(s.id), [s.id]);
  assert.deepEqual(plannedEnds(s.id).map((a) => a.body), ['Stopped as planned after 1 run']);

  // A run left queued on it (written here directly: no door queues one on an ENDED schedule) does not start.
  const stray = await db.scheduleRun.create({
    data: { scheduleId: s.id, scheduleRevision: 1, plannedAt: new Date('2026-11-16T09:30:00Z'), trigger: 'MANUAL', state: 'QUEUED' },
  });
  assert.equal(await runs.start(stray.id), 'CANCELLED', 'past maxRuns nothing starts');
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id, startedAt: { not: null } } }), 1);
  assert.deepEqual(await told(s.id), []);
  assert.equal(plannedEnds(s.id).length, 1, 'still exactly one push');
});

test('§8.5 endAt: ENDED after the last slot at or before endAt, one push once that slot\'s run is over', { skip }, async () => {
  const w = await world('end-at');
  at('2026-11-16T08:00:00Z');
  // Daily at 10:00 UTC until 11-17 10:00: a slot exactly at endAt fires, so two runs.
  const s = await created(w, { rule: { kind: 'DAILY', time: '10:00' }, endAt: new Date('2026-11-17T10:00:00Z') });
  const row = await listRow(w, s.id);
  assert.deepEqual([row.endAt, row.maxRuns, row.runsStarted, row.runsLeft], ['2026-11-17T10:00:00.000Z', null, 0, null]);

  const first = await nextRun(s.id);
  assert.equal((await scheduleOf(s.id)).state, 'ACTIVE');
  await finish(w, first);
  assert.deepEqual(await told(s.id), []);

  // The last slot fires, and the schedule has no slot left: ENDED, its last run still to run.
  at('2026-11-17T10:00:00Z');
  assert.equal(await runs.fire(s.id), 'FIRED');
  const ended = await scheduleOf(s.id);
  assert.deepEqual([ended.state, ended.endedReason, ended.nextDueAt], ['ENDED', 'END_REACHED', null]);
  assert.deepEqual(await told(s.id), [], 'its last run is still queued: nothing is told yet');
  const started = await runs.startDue(25, s.id);
  assert.equal(started[0]?.outcome, 'STARTED', 'the last slot\'s run starts');
  const last = await db.scheduleRun.findUniqueOrThrow({ where: { id: started[0].runId } });
  await delivered(last.sessionId!, clockNow);
  assert.deepEqual(await told(s.id), [], 'nor while it runs');
  await finish(w, last.sessionId!);
  // Reported and still landing, as a LAND run is until landReportedRuns settles it (written here directly): its
  // landing may yet fail it, and that push comes first.
  await db.scheduleRun.update({ where: { id: last.id }, data: { landingStatus: 'WAITING' } });
  assert.deepEqual(await told(s.id), [], 'nor while its last run is landing');
  await db.scheduleRun.update({ where: { id: last.id }, data: { landingStatus: 'MERGING' } });
  assert.deepEqual(await told(s.id), []);
  await db.scheduleRun.update({ where: { id: last.id }, data: { landingStatus: 'LANDED' } });

  assert.deepEqual(await told(s.id), [s.id]);
  assert.deepEqual(await told(s.id), []);
  const pushed = plannedEnds(s.id);
  assert.equal(pushed.length, 1, 'exactly one push');
  assert.equal(pushed[0].body, 'Stopped as planned after 2 runs');
  assert.ok((await scheduleOf(s.id)).plannedEndToldAt, 'the push is recorded as told');
});

test('§8.5 a ONCE rule\'s end is its only slot: no "stopped as planned" push', { skip }, async () => {
  const w = await world('once');
  at('2026-11-16T08:00:00Z');
  const s = await created(w, { rule: { kind: 'ONCE', at: '2026-11-16T09:00' } });
  const only = await nextRun(s.id);
  assert.equal((await scheduleOf(s.id)).endedReason, 'END_REACHED');
  await finish(w, only);
  assert.deepEqual(await told(s.id), []);
  assert.deepEqual(plannedEnds(s.id), []);
  assert.ok((await scheduleOf(s.id)).plannedEndToldAt, 'marked, so the pass does not read it again');
});

test('§8.5 endAt between slots: an EVERY rule ends at its last slot before endAt, one push once that run is over', { skip }, async () => {
  const w = await world('end-at-every');
  at('2026-11-16T08:10:00Z');
  // Every hour round the clock, until 10:30: the slots left are 09:00 and 10:00.
  const s = await created(w, { rule: every(60), endAt: new Date('2026-11-16T10:30:00Z') });
  assert.equal(s.nextDueAt?.toISOString(), '2026-11-16T09:00:00.000Z');
  await finish(w, await nextRun(s.id));
  const after9 = await scheduleOf(s.id);
  assert.deepEqual([after9.state, after9.nextDueAt?.toISOString()], ['ACTIVE', '2026-11-16T10:00:00.000Z'], 'one slot left');

  // 10:00 fires; the next slot, 11:00, is past endAt: ENDED with that last run still to run.
  const last = await nextRun(s.id);
  const ended = await scheduleOf(s.id);
  assert.deepEqual([ended.state, ended.endedReason, ended.nextDueAt], ['ENDED', 'END_REACHED', null]);
  assert.equal(ended.endedAt?.toISOString(), '2026-11-16T10:00:00.000Z', 'ended by its last slot');
  assert.deepEqual(await told(s.id), [], 'not while its last run runs');
  await finish(w, last);
  assert.deepEqual(await told(s.id), [s.id]);
  assert.deepEqual(await told(s.id), [], 'told once');
  assert.deepEqual(plannedEnds(s.id).map((a) => [a.title, a.body]), [['Codex stable check', 'Stopped as planned after 2 runs']]);
  const row = await listRow(w, s.id);
  assert.deepEqual(
    [row.state, row.endedReason, row.endAt, row.maxRuns, row.runsStarted, row.runsLeft],
    ['ENDED', 'END_REACHED', '2026-11-16T10:30:00.000Z', null, 2, null],
  );
});

test('§8.5 an EVERY create card without an end suggests one 7 days out; Create writes it, No end writes none', { skip }, async () => {
  const w = await world('suggested');
  // The card's own read: the suggestion as of now (the read's real clock), marked suggested.
  const before = Date.now();
  const id = await card(w, { rule: every(60) });
  const view = (await reads.request(w.ownerId, id)) as unknown as { ends: { endAt: string; maxRuns: null; suggested: boolean } | null };
  const afterRead = Date.now();
  assert.ok(view.ends, 'the card carries an Ends line');
  assert.equal(view.ends.suggested, true);
  assert.equal(view.ends.maxRuns, null);
  const endAt = new Date(view.ends.endAt).getTime();
  assert.ok(endAt >= Math.floor(before / 1000) * 1000 + 7 * DAY - 1000 && endAt <= afterRead + 7 * DAY, `7 days out: ${view.ends.endAt}`);
  assert.equal(((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id } })).proposed as { suggestedEnd?: boolean }).suggestedEnd, true);

  // No end: Create writes no end.
  at('2026-11-16T08:00:00Z');
  const dropped = await schedules.decide(w.owner, id, 'ALLOW', { dropSuggestedEnd: true });
  assert.equal(dropped.outcome, 'ALLOWED');
  assert.equal(dropped.schedule!.endAt, null, 'created without an end');
  assert.equal(dropped.schedule!.maxRuns, null);
  assert.equal(((await reads.request(w.ownerId, id)) as unknown as { ends: unknown }).ends, null, 'the decided card shows no end');

  // Create as suggested: the same local time 7 days after the press, across New York's fall-back (Nov 1, 2026).
  const kept = await card(w, { rule: every(60), timezone: 'America/New_York' });
  at('2026-10-28T14:00:00Z'); // 10:00 EDT
  const allowed = await schedules.decide(w.owner, kept, 'ALLOW');
  assert.equal(allowed.schedule!.endAt?.toISOString(), '2026-11-04T15:00:00.000Z', '10:00 EST seven days later');
  assert.deepEqual(
    ((await reads.request(w.ownerId, kept)) as unknown as { ends: unknown }).ends,
    { endAt: '2026-11-04T15:00:00.000Z', maxRuns: null, suggested: true },
    'the decided card reads the end Create wrote',
  );

  // A card whose zone comes from the pressing device: the press's zone places the end.
  const zoneless = await card(w, { rule: every(120), timezone: null });
  at('2026-11-16T08:00:00Z');
  const pressed = await schedules.decide(w.owner, zoneless, 'ALLOW', { timezone: 'Asia/Shanghai' });
  assert.equal(pressed.schedule!.endAt?.toISOString(), '2026-11-23T08:00:00.000Z');
});

test('§8.5 a named end is never suggested, and DAILY gets no suggestion', { skip }, async () => {
  const w = await world('named');
  const named = await card(w, { rule: every(60), maxRuns: 5 });
  const namedView = (await reads.request(w.ownerId, named)) as unknown as { ends: unknown };
  assert.deepEqual(namedView.ends, { endAt: null, maxRuns: 5, suggested: false });
  assert.equal(((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id: named } })).proposed as { suggestedEnd?: boolean }).suggestedEnd, undefined);
  at('2026-11-16T08:00:00Z');
  const created1 = await schedules.decide(w.owner, named, 'ALLOW', { dropSuggestedEnd: true });
  assert.deepEqual([created1.schedule!.endAt, created1.schedule!.maxRuns], [null, 5], 'No end does not remove a named end');

  const daily = await card(w, { rule: { kind: 'DAILY', time: '10:00' } });
  assert.equal(((await reads.request(w.ownerId, daily)) as unknown as { ends: unknown }).ends, null);
  const created2 = await schedules.decide(w.owner, daily, 'ALLOW');
  assert.equal(created2.schedule!.endAt, null);
});

test('§8.5 maxRuns is inside the envelope: a session sets it at once; at or below the runs started is refused', { skip }, async () => {
  const w = await world('patch');
  at('2026-11-16T08:00:00Z');
  const asked = await card(w, { rule: every(60) });
  const s = (await schedules.decide(w.owner, asked, 'ALLOW', { dropSuggestedEnd: true })).schedule!;
  await finish(w, await nextRun(s.id));
  await finish(w, await nextRun(s.id));

  await refusedWith(schedules.update(w.session, s.id, { maxRuns: 2 }), 'SCHEDULE_MAX_RUNS_ALREADY_REACHED');
  await refusedWith(schedules.update(w.session, s.id, { maxRuns: 0 }), 'SCHEDULE_MAX_RUNS_INVALID');
  // Also beside a change that needs a card (every 30 minutes is more runs a week than allowed): refused before it.
  await refusedWith(
    schedules.update(w.session, s.id, { rule: every(30), runLimitMinutes: 15, maxRuns: 2 }),
    'SCHEDULE_MAX_RUNS_ALREADY_REACHED',
  );
  assert.equal(await db.scheduleChangeRequest.count({ where: { scheduleId: s.id, kind: 'UPDATE' } }), 0, 'no card was written');
  const applied = await schedules.update(w.session, s.id, { maxRuns: 4 });
  assert.equal(applied.outcome, 'APPLIED', 'inside the envelope: applied at once');
  const revision = await db.scheduleRevision.findUniqueOrThrow({
    where: { scheduleId_revision: { scheduleId: s.id, revision: (applied as { revision: number }).revision } },
  });
  assert.deepEqual(revision.fields, { before: { maxRuns: null }, after: { maxRuns: 4 } }, 'recorded, so Undo can put it back');
  const row = await listRow(w, s.id);
  assert.deepEqual([row.maxRuns, row.runsStarted, row.runsLeft], [4, 2, 2]);

  const undone = await schedules.undo(w.owner, s.id, (applied as { revision: number }).revision);
  assert.equal(undone.outcome, 'APPLIED');
  assert.equal((await scheduleOf(s.id)).maxRuns, null, 'Undo removes it');
});
