/**
 * An EVERY rule inside the runs-per-week envelope (docs/scheduled-tasks-design.md §3, §4, §5), against a real
 * PostgreSQL migrated from empty, through SchedulesService and the real trigger path (fire, then start):
 *
 *   1. DAILY → EVERY 60 asks for 168 runs a week against an envelope of 7: it waits on the widen card, whose Now and
 *      Asked read 7 and 168, and nothing changes until the owner's Allow, which writes the rule and the envelope;
 *   2. EVERY 30 → EVERY 60 halves the runs a week (336 → 168): it applies at once with a revision that reads the rule
 *      change, shrinks the envelope, and the owner's Undo puts both back;
 *   3. EVERY 6 hours in Berlin across the autumn change fills its envelope of 28 without a slot MISSED; the owner's
 *      Run now takes no slot's place; one slot more than the rhythm, from a rule moved inside the envelope, is MISSED
 *      (OVER_BUDGET), and the one after runs.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-every-envelope.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode, scheduleRecordParts } from '@orbit/shared';
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
import { ScheduleRunsService, type ScheduleRunSessionPort } from './schedule-runs.service';
import { scheduleCardViews } from './schedule-views';
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
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-every.invalid`, name: label, passwordHash: 'x' },
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

/** The engine took the run's first turn now. */
async function delivered(sessionId: string) {
  await db.conversationTurn.upsert({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId: `initial-${sessionId}` } },
    create: { sessionId, seq: 1, clientTurnId: `initial-${sessionId}`, content: 'x', status: 'IN_FLIGHT', deliveredAt: clockNow },
    update: { deliveredAt: clockNow },
  });
}

/** Go to the schedule's next slot, fire it, start it a little late, and end the run if it started. */
async function nextSlot(w: World, scheduleId: string, latencySeconds = 0): Promise<{ outcome: string; runId: string }> {
  const s = await db.schedule.findUniqueOrThrow({ where: { id: scheduleId } });
  assert.ok(s.nextDueAt, 'a next slot');
  at(s.nextDueAt);
  assert.equal(await runs.fire(scheduleId), 'FIRED');
  advance(latencySeconds * 1000);
  const [started] = await runs.startDue(25, scheduleId);
  assert.ok(started, 'the slot has a run');
  if (started.outcome === 'STARTED') {
    const run = await db.scheduleRun.findUniqueOrThrow({ where: { id: started.runId } });
    await delivered(run.sessionId!);
    advance(MINUTE);
    await runs.report(w.ownerId, run.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });
  }
  return started;
}

// =============================================================================================================

test('1. DAILY → EVERY 60 raises the widen card (7 → 168) and does not apply until the owner\'s Allow', { skip }, async () => {
  at('2026-11-16T08:00:00Z');
  const w = await world('every-widen');
  const s = await created(w, { rule: { kind: 'DAILY', time: '09:00' } });
  assert.equal(s.envelopeRunsPerWeek, 7);

  const asked = await schedules.update(w.session, s.id, { rule: every(60) });
  assert.equal(asked.outcome, 'PENDING');
  if (asked.outcome !== 'PENDING') return;
  assert.deepEqual(asked.request.widens, ['RUNS_PER_WEEK']);

  // The card reads Now 7 and Asked 168.
  const [card] = await scheduleCardViews(db as never, w.ownerId, [asked.request], clockNow);
  assert.deepEqual(card.envelope?.widens, ['RUNS_PER_WEEK']);
  assert.equal(card.envelope?.now?.costs.runsPerWeek, 7);
  assert.equal(card.envelope?.asked.costs.runsPerWeek, 168);
  assert.match(card.envelope?.now?.costs.text ?? '', /\b7\b/);
  assert.match(card.envelope?.asked.costs.text ?? '', /\b168\b/);

  // Nothing applied while it waits.
  const waiting = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(waiting.revision, 1);
  assert.deepEqual(waiting.rule, { kind: 'DAILY', time: '09:00' });
  assert.equal(waiting.envelopeRunsPerWeek, 7);
  assert.equal(await db.scheduleRevision.count({ where: { scheduleId: s.id } }), 1);

  // Allow applies the rule and widens the envelope to what it asked.
  const allowed = await schedules.decide(w.owner, asked.request.id, 'ALLOW');
  assert.equal(allowed.request.state, 'ALLOWED');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(now.revision, 2);
  assert.deepEqual(now.rule, every(60));
  assert.equal(now.envelopeRunsPerWeek, 168);
  // The next slot is the top of the next hour, not tomorrow's 09:00.
  assert.equal(now.nextDueAt?.toISOString(), '2026-11-16T09:00:00.000Z');

  const revision = await db.scheduleRevision.findUniqueOrThrow({ where: { scheduleId_revision: { scheduleId: s.id, revision: 2 } } });
  const fields = revision.fields as { before: Record<string, unknown>; after: Record<string, unknown> };
  assert.equal(
    scheduleRecordParts({ before: fields.before, after: fields.after, revision: 2 }).text,
    'Daily 09:00 → Every hour',
  );
});

test('2. EVERY 30 → EVERY 60 applies at once with a revision, shrinks the envelope, and Undo puts both back', { skip }, async () => {
  at('2026-11-16T08:10:00Z');
  const w = await world('every-narrow');
  const s = await created(w, { rule: every(30) });
  assert.equal(s.envelopeRunsPerWeek, 336);

  const applied = await schedules.update(w.session, s.id, { rule: every(60) });
  assert.equal(applied.outcome, 'APPLIED');
  assert.equal(await db.scheduleChangeRequest.count({ where: { scheduleId: s.id } }), 0, 'no card');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(now.revision, 2);
  assert.deepEqual(now.rule, every(60));
  assert.equal(now.envelopeRunsPerWeek, 168, 'a session\'s narrowing shrinks the envelope');
  assert.equal(now.nextDueAt?.toISOString(), '2026-11-16T09:00:00.000Z');

  const revision = await db.scheduleRevision.findUniqueOrThrow({ where: { scheduleId_revision: { scheduleId: s.id, revision: 2 } } });
  assert.equal(revision.changedBy, 'SESSION');
  assert.equal(revision.sessionId, w.session.sessionId);
  const fields = revision.fields as { before: Record<string, unknown>; after: Record<string, unknown> };
  assert.deepEqual(fields.before.rule, every(30));
  assert.deepEqual(fields.after.rule, every(60));
  assert.equal(
    scheduleRecordParts({ before: fields.before, after: fields.after, revision: 2 }).text,
    'Every 30 min → Every hour',
  );

  // Back to 30 from a session is now wider than the envelope: it waits.
  const back = await schedules.update(w.session, s.id, { rule: every(30) });
  assert.equal(back.outcome, 'PENDING');

  // The owner's Undo restores the rule and the envelope.
  const undone = await schedules.undo(w.owner, s.id, 2);
  assert.equal(undone.outcome, 'APPLIED');
  const restored = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual(restored.rule, every(30));
  assert.equal(restored.envelopeRunsPerWeek, 336);
  assert.equal(restored.nextDueAt?.toISOString(), '2026-11-16T08:30:00.000Z');
});

test('3. EVERY 6 hours in Berlin across the autumn change: none MISSED at the envelope, Run now takes no slot, one slot more is OVER_BUDGET', { skip }, async () => {
  // 23:00 on Monday 19 October in Berlin (UTC+2); the clocks go back at 03:00 on Sunday 25 October.
  at('2026-10-19T21:00:00Z');
  const w = await world('every-budget');
  const s = await created(w, { rule: every(360), timezone: 'Europe/Berlin' });
  assert.equal(s.envelopeRunsPerWeek, 28, '4 slots a day × 7 days');

  // Nine local days, 36 slots, each started 0-90 s late: the week across the change is 169 hours, and the slot a
  // local week back is outside the window, so every slot starts.
  const jitter = [90, 0, 45, 10, 80, 5, 60, 2];
  const outcomes: string[] = [];
  for (let i = 0; i < 36; i++) outcomes.push((await nextSlot(w, s.id, jitter[i % jitter.length])).outcome);
  assert.deepEqual(outcomes.filter((o) => o !== 'STARTED'), [], `every slot starts: ${outcomes.join(' ')}`);
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id, state: 'MISSED' } }), 0);
  const list = await db.scheduleRun.findMany({ where: { scheduleId: s.id }, orderBy: { plannedAt: 'asc' } });
  assert.equal(list[0].plannedAt.toISOString(), '2026-10-19T22:00:00.000Z', 'Tuesday 00:00 in Berlin (UTC+2)');
  assert.equal(list[35].plannedAt.toISOString(), '2026-10-28T17:00:00.000Z', 'Wednesday 18:00 in Berlin (UTC+1)');

  // Before the next slot, the owner's Run now. That slot has 27 automatic starts in its trailing local 7 days.
  advance(MINUTE);
  const press = await runs.runNow(w.owner, s.id);
  const pressed = await db.scheduleRun.findUniqueOrThrow({ where: { id: press.id } });
  assert.equal(pressed.state, 'RUNNING');
  await delivered(pressed.sessionId!);
  advance(MINUTE);
  await runs.report(w.ownerId, pressed.sessionId!, { outcome: 'NO_CHANGE', summary: 'same' });

  // The press is not the 28th (§4: no Run now is in the count): the rhythm the owner approved still runs.
  const slot = await nextSlot(w, s.id);
  assert.equal(slot.outcome, 'STARTED');
  const started = await db.scheduleRun.findUniqueOrThrow({ where: { id: slot.runId } });
  assert.equal(started.plannedAt.toISOString(), '2026-10-28T23:00:00.000Z', 'Thursday 00:00 in Berlin');

  // The rule moved inside the envelope to 03:00, 09:00, …: the 03:00 slot is one more than the rhythm, with 28
  // automatic starts in its trailing local 7 days. It is MISSED, for the budget.
  const moved = await schedules.update(w.session, s.id, { rule: { ...every(360), time: '03:00' } });
  assert.equal(moved.outcome, 'APPLIED');
  const missed = await nextSlot(w, s.id);
  assert.equal(missed.outcome, 'MISSED');
  const row = await db.scheduleRun.findUniqueOrThrow({ where: { id: missed.runId } });
  assert.equal(row.failureReason, 'OVER_BUDGET');
  assert.equal(row.startedAt, null);
  assert.equal(row.plannedAt.toISOString(), '2026-10-29T02:00:00.000Z', 'Thursday 03:00 in Berlin');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).state, 'ACTIVE');

  // Six hours on, slots have left the window and the missed one never started: it runs again, at 27 automatic starts
  // (the owner's press, still inside the window, would make it 28).
  const next = await nextSlot(w, s.id);
  assert.equal(next.outcome, 'STARTED');
});
