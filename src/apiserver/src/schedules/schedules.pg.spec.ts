/**
 * Scheduled tasks' model and envelope rule (docs/scheduled-tasks-design.md §3, §4, §5.1, §8), against a real
 * PostgreSQL migrated from empty:
 *
 *   * §3's constraints, each by writing the row that violates it and seeing it refused;
 *   * §4's rule, case by case, through SchedulesService: inside the envelope applies at once with an undoable
 *     revision; each of the four widenings waits; only the owner channel's press writes the envelope; a person's
 *     narrowing shrinks it and a run's own does not; no envelope wider than the asking session's mode;
 *   * §8.1's intent and baseline, and §5.1's nextDueAt on both daylight-saving change days.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedules.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode } from '@orbit/shared';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SCHEDULE_LIMIT, SchedulesService, type ScheduleActor, type ScheduleCreateInput } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

let db: PrismaClient;
let pg: Client;
let clockNow = new Date('2026-11-14T08:00:00Z');
let service: SchedulesService;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  service = new SchedulesService(db as unknown as PrismaService, () => clockNow);
});

after(async () => {
  if (skip) return;
  await db.$disconnect();
  await pg.end();
});

interface World {
  ownerId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  owner: ScheduleActor;
  pat: ScheduleActor;
  /** An ordinary session in Default mode, in `workspaceId`. */
  session: ScheduleActor & { sessionId: string };
  /** An ordinary session in Plan mode. */
  planSession: ScheduleActor & { sessionId: string };
}

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedules.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  for (const id of [workspaceId, otherWorkspaceId]) {
    await db.workspace.create({ data: { id, ownerId, runnerId, name: `${label}-${id.slice(0, 6)}`, enabled: true } });
  }
  const sessionId = await makeSession(ownerId, workspaceId, PermissionMode.DEFAULT);
  const planId = await makeSession(ownerId, workspaceId, PermissionMode.PLAN);
  return {
    ownerId,
    workspaceId,
    otherWorkspaceId,
    owner: { kind: 'OWNER', ownerId },
    pat: { kind: 'PAT', ownerId },
    session: { kind: 'SESSION', ownerId, sessionId },
    planSession: { kind: 'SESSION', ownerId, sessionId: planId },
  };
}

async function makeSession(
  ownerId: string,
  workspaceId: string,
  permissionMode: string,
  extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId, creatorId: ownerId, workspaceId, title: 'chat', prompt: 'p', provider: 'claude', engine: 'claude',
      providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode, ...extra,
    },
  });
  return id;
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

/** A schedule the owner created directly (the press on a create card). */
async function created(w: World, over: Partial<ScheduleCreateInput> = {}) {
  const result = await service.create(w.owner, { workspaceId: w.workspaceId, ...input(over) });
  assert.equal(result.outcome, 'CREATED');
  return result.schedule;
}

/** A session serving one of `scheduleId`'s runs: the run's own session (§8.3). */
async function runSession(w: World, scheduleId: string): Promise<ScheduleActor> {
  const run = await db.scheduleRun.create({
    data: { scheduleId, scheduleRevision: 1, plannedAt: new Date(), trigger: 'SCHEDULED', state: 'RUNNING' },
  });
  const sessionId = await makeSession(w.ownerId, w.workspaceId, PermissionMode.PLAN, {
    runSource: SessionRunSource.SCHEDULE,
    scheduleRunId: run.id,
  });
  return { kind: 'SESSION', ownerId: w.ownerId, sessionId };
}

async function refusedWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const body = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
    assert.equal(body?.code, code, `expected ${code}, got ${JSON.stringify(body ?? String(err))}`);
    return true;
  });
}

function pgCode(err: unknown): string | undefined {
  return (err as { code?: string }).code;
}

async function insertRun(scheduleId: string, trigger: string, state: string, plannedAt: string) {
  return pg.query(
    `INSERT INTO "schedule_run"("id","schedule_id","schedule_revision","planned_at","trigger","state")
     VALUES ($1,$2,1,$3,$4::"schedule_run_trigger",$5::"schedule_run_state")`,
    [randomUUID(), scheduleId, plannedAt, trigger, state],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// §3 constraints
// ---------------------------------------------------------------------------------------------------------------

test('§3 one run per SCHEDULED or CATCH_UP slot; MANUAL runs are left out of the slot index', { skip }, async () => {
  const w = await world('slot');
  const s = await created(w);
  const slot = '2026-11-15T02:00:00Z';
  await insertRun(s.id, 'SCHEDULED', 'NO_CHANGE', slot);
  await assert.rejects(insertRun(s.id, 'SCHEDULED', 'NO_CHANGE', slot), (e) => pgCode(e) === '23505');
  await assert.rejects(insertRun(s.id, 'CATCH_UP', 'NO_CHANGE', slot), (e) => pgCode(e) === '23505');
  await insertRun(s.id, 'MANUAL', 'NO_CHANGE', slot);
  await insertRun(s.id, 'MANUAL', 'CHANGED', slot);
  await insertRun(s.id, 'SCHEDULED', 'NO_CHANGE', '2026-11-16T02:00:00Z');
});

test('§3 at most one RUNNING or AWAITING_APPROVAL run and at most one QUEUED run per schedule', { skip }, async () => {
  const w = await world('overlap');
  const s = await created(w);
  const other = await created(w);
  await insertRun(s.id, 'MANUAL', 'RUNNING', '2026-11-15T02:00:00Z');
  await assert.rejects(insertRun(s.id, 'MANUAL', 'RUNNING', '2026-11-15T03:00:00Z'), (e) => pgCode(e) === '23505');
  await assert.rejects(insertRun(s.id, 'MANUAL', 'AWAITING_APPROVAL', '2026-11-15T03:00:00Z'), (e) => pgCode(e) === '23505');
  await insertRun(s.id, 'MANUAL', 'QUEUED', '2026-11-15T04:00:00Z');
  await assert.rejects(insertRun(s.id, 'MANUAL', 'QUEUED', '2026-11-15T05:00:00Z'), (e) => pgCode(e) === '23505');
  // Ended runs are not limited, and another schedule has its own one of each.
  await insertRun(s.id, 'MANUAL', 'FAILED', '2026-11-15T06:00:00Z');
  await insertRun(s.id, 'MANUAL', 'SKIPPED', '2026-11-15T06:00:00Z');
  await insertRun(other.id, 'MANUAL', 'AWAITING_APPROVAL', '2026-11-15T02:00:00Z');
  await insertRun(other.id, 'MANUAL', 'QUEUED', '2026-11-15T02:00:00Z');
});

test('§3 one finding per key per schedule', { skip }, async () => {
  const w = await world('finding');
  const s = await created(w);
  const t = await created(w);
  await db.scheduleFinding.create({ data: { scheduleId: s.id, key: 'codex@0.48.1' } });
  await assert.rejects(
    db.scheduleFinding.create({ data: { scheduleId: s.id, key: 'codex@0.48.1' } }),
    (e) => (e as { code?: string }).code === 'P2002',
  );
  await db.scheduleFinding.create({ data: { scheduleId: s.id, key: 'codex@0.48.2' } });
  await db.scheduleFinding.create({ data: { scheduleId: t.id, key: 'codex@0.48.1' } });
});

test('§3 SessionRunSource has SCHEDULE and a session names the run it serves', { skip }, async () => {
  const w = await world('runsource');
  const s = await created(w);
  const actor = await runSession(w, s.id);
  const row = await db.session.findUniqueOrThrow({
    where: { id: (actor as { sessionId: string }).sessionId },
    include: { scheduleRun: true },
  });
  assert.equal(row.runSource, 'SCHEDULE');
  assert.equal(row.scheduleRun?.scheduleId, s.id);
});

test(`§3 at most ${SCHEDULE_LIMIT} schedules that are not ENDED per account (SCHEDULE_LIMIT), also under concurrent creates`, { skip }, async () => {
  const w = await world('limit');
  assert.equal(SCHEDULE_LIMIT, 50);
  for (let i = 0; i < SCHEDULE_LIMIT - 2; i++) await created(w, { title: `s${i}` });
  // An ENDED schedule does not count.
  const ended = await created(w, { title: 'ended' });
  await service.end(w.owner, ended.id);
  // 48 live now: of three concurrent creates two fit.
  const results = await Promise.allSettled([1, 2, 3].map((i) => created(w, { title: `race${i}` })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal((refused.reason as { getResponse(): { code: string } }).getResponse().code, 'SCHEDULE_LIMIT');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId, state: { not: 'ENDED' } } }), SCHEDULE_LIMIT);
  // A session's create is refused at once rather than waiting on a card that could not be allowed.
  await refusedWith(service.create(w.session, input()), 'SCHEDULE_LIMIT');
  // Undoing the end would bring a 51st back.
  const endRevision = (await db.schedule.findUniqueOrThrow({ where: { id: ended.id } })).revision;
  await refusedWith(service.undo(w.owner, ended.id, endRevision), 'SCHEDULE_LIMIT');
});

// ---------------------------------------------------------------------------------------------------------------
// §4 the envelope
// ---------------------------------------------------------------------------------------------------------------

test('§4 the envelope is workspace, access, runs per week (ONCE 1, DAILY 7, WEEKLY its weekdays) and run limit (default 30, at most 120)', { skip }, async () => {
  const w = await world('measure');
  const daily = await created(w);
  assert.deepEqual(
    [daily.envelopeWorkspaceId, daily.envelopeAccessLevel, daily.envelopeRunsPerWeek, daily.envelopeRunLimitMinutes],
    [w.workspaceId, 'CHECK_ONLY', 7, 30],
  );
  assert.equal(daily.runLimitMinutes, 30);
  const weekly = await created(w, { rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'WED', 'FRI', 'MON'] } });
  assert.equal(weekly.envelopeRunsPerWeek, 3);
  const once = await created(w, { rule: { kind: 'ONCE', at: '2026-11-20T18:00' } });
  assert.equal(once.envelopeRunsPerWeek, 1);
  const long = await created(w, { runLimitMinutes: 120 });
  assert.equal(long.envelopeRunLimitMinutes, 120);
  await refusedWith(service.create(w.owner, { workspaceId: w.workspaceId, ...input({ runLimitMinutes: 121 }) }), 'SCHEDULE_RUN_LIMIT_INVALID');
});

test('§4 inside the envelope a change applies at once, writes a revision naming who made it, and Undo restores it', { skip }, async () => {
  const w = await world('inside');
  const s = await created(w, { accessLevel: 'OPEN_PR', runLimitMinutes: 60 });
  const result = await service.update(w.session, s.id, {
    prompt: 'Check the releases page instead.',
    title: 'Codex stable',
    rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] },
    timezone: 'Europe/Berlin',
    runLimitMinutes: 45,
    accessLevel: 'CHECK_ONLY',
  });
  assert.equal(result.outcome, 'APPLIED');
  const after = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(after.prompt, 'Check the releases page instead.');
  assert.equal(after.timezone, 'Europe/Berlin');
  assert.equal(after.revision, 2);
  const revision = await db.scheduleRevision.findUniqueOrThrow({
    where: { scheduleId_revision: { scheduleId: s.id, revision: 2 } },
  });
  assert.equal(revision.changedBy, 'SESSION');
  assert.equal(revision.sessionId, w.session.sessionId);
  const fields = revision.fields as { before: Record<string, unknown>; after: Record<string, unknown> };
  assert.equal(fields.before.prompt, s.prompt);
  assert.equal(fields.after.prompt, 'Check the releases page instead.');
  assert.deepEqual(fields.before.rule, { kind: 'DAILY', time: '10:00' });

  // Undo, by the owner: every field back, a new revision that says what it undid.
  const undone = await service.undo(w.owner, s.id, 2);
  assert.equal(undone.outcome, 'APPLIED');
  const back = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(back.prompt, s.prompt);
  assert.equal(back.title, s.title);
  assert.deepEqual(back.rule, s.rule);
  assert.equal(back.timezone, s.timezone);
  assert.equal(back.accessLevel, 'OPEN_PR');
  assert.equal(back.runLimitMinutes, 60);
  assert.deepEqual(
    [back.envelopeAccessLevel, back.envelopeRunsPerWeek, back.envelopeRunLimitMinutes],
    ['OPEN_PR', 7, 60],
  );
  const undoRow = await db.scheduleRevision.findUniqueOrThrow({
    where: { scheduleId_revision: { scheduleId: s.id, revision: 3 } },
  });
  assert.equal(undoRow.undoOfRevision, 2);
  assert.equal(undoRow.changedBy, 'USER');
  await refusedWith(service.undo(w.owner, s.id, 2), 'SCHEDULE_ALREADY_UNDONE');
});

test('§4 a change outside the envelope does not apply and waits for a decision, for each of the four parts', { skip }, async () => {
  const w = await world('outside');
  const s = await created(w, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['WORKSPACE', { workspaceId: w.otherWorkspaceId }],
    ['ACCESS_LEVEL', { accessLevel: 'OPEN_PR' }],
    ['RUNS_PER_WEEK', { rule: { kind: 'DAILY', time: '10:00' } }],
    ['RUN_LIMIT', { runLimitMinutes: 60 }],
  ];
  for (const [part, patch] of cases) {
    const result = await service.update(w.session, s.id, patch);
    assert.equal(result.outcome, 'PENDING', part);
    if (result.outcome !== 'PENDING') continue;
    assert.deepEqual(result.request.widens, [part]);
    assert.equal(result.request.state, 'PENDING');
    assert.equal(result.request.askedBySessionId, w.session.sessionId);
    const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
    assert.equal(now.revision, 1, `${part} changed nothing`);
    assert.deepEqual(
      [now.workspaceId, now.accessLevel, now.runLimitMinutes, now.envelopeWorkspaceId, now.envelopeAccessLevel, now.envelopeRunsPerWeek, now.envelopeRunLimitMinutes],
      [w.workspaceId, 'CHECK_ONLY', 30, w.workspaceId, 'CHECK_ONLY', 1, 30],
    );
    assert.deepEqual(now.rule, { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] });
  }
  // A newer request for the same schedule takes the older one's place.
  const states = await db.scheduleChangeRequest.findMany({ where: { scheduleId: s.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(states.map((r) => r.state), ['SUPERSEDED', 'SUPERSEDED', 'SUPERSEDED', 'PENDING']);
  assert.equal(await db.scheduleRevision.count({ where: { scheduleId: s.id } }), 1);
});

test('§4 only the owner channel decides: a session and a PAT are refused, Allow applies the change and writes the envelope, Decline changes nothing', { skip }, async () => {
  const w = await world('decide');
  const s = await created(w);
  const asked = await service.update(w.session, s.id, { runLimitMinutes: 90, prompt: 'longer' });
  assert.equal(asked.outcome, 'PENDING');
  if (asked.outcome !== 'PENDING') return;
  await refusedWith(service.decide(w.session, asked.request.id, 'ALLOW'), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  await refusedWith(service.decide(w.pat, asked.request.id, 'ALLOW'), 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  const unchanged = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(unchanged.envelopeRunLimitMinutes, 30);
  assert.equal(unchanged.revision, 1);

  const allowed = await service.decide(w.owner, asked.request.id, 'ALLOW');
  assert.equal(allowed.request.state, 'ALLOWED');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(now.runLimitMinutes, 90);
  assert.equal(now.prompt, 'longer');
  assert.equal(now.envelopeRunLimitMinutes, 90);
  assert.equal(now.revision, 2);
  assert.equal(allowed.request.resultRevision, 2);
  await refusedWith(service.decide(w.owner, asked.request.id, 'ALLOW'), 'SCHEDULE_REQUEST_DECIDED');

  const second = await service.update(w.session, s.id, { accessLevel: 'OPEN_PR' });
  assert.equal(second.outcome, 'PENDING');
  if (second.outcome !== 'PENDING') return;
  const declined = await service.decide(w.owner, second.request.id, 'DECLINE');
  assert.equal(declined.request.state, 'DECLINED');
  const still = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(still.accessLevel, 'CHECK_ONLY');
  assert.equal(still.envelopeAccessLevel, 'CHECK_ONLY');
  assert.equal(still.revision, 2);
});

test('§4 a session\'s create waits for the owner\'s Create, which writes the schedule and its envelope; a PAT cannot create', { skip }, async () => {
  const w = await world('create');
  const asked = await service.create(w.session, input({ accessLevel: 'OPEN_PR' }));
  assert.equal(asked.outcome, 'PENDING');
  if (asked.outcome !== 'PENDING') return;
  assert.equal(asked.request.kind, 'CREATE');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0);
  await refusedWith(service.decide(w.session, asked.request.id, 'ALLOW'), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  await refusedWith(service.create(w.pat, { workspaceId: w.workspaceId, ...input() }), 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  const allowed = await service.decide(w.owner, asked.request.id, 'ALLOW');
  const s = await db.schedule.findUniqueOrThrow({ where: { id: allowed.request.scheduleId! } });
  assert.equal(s.workspaceId, w.workspaceId, 'the asking session\'s workspace');
  assert.equal(s.createdFromSessionId, w.session.sessionId);
  assert.deepEqual([s.envelopeAccessLevel, s.envelopeRunsPerWeek, s.envelopeRunLimitMinutes], ['OPEN_PR', 7, 30]);
});

test('§4 an ordinary session\'s narrowing shrinks the envelope, and widening back needs a decision', { skip }, async () => {
  const w = await world('narrow');
  const s = await created(w, { accessLevel: 'OPEN_PR' });
  const stop = await service.update(w.session, s.id, { accessLevel: 'CHECK_ONLY' }); // "stop opening PRs"
  assert.equal(stop.outcome, 'APPLIED');
  const fewer = await service.update(w.session, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  assert.equal(fewer.outcome, 'APPLIED');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual([now.envelopeAccessLevel, now.envelopeRunsPerWeek], ['CHECK_ONLY', 1]);
  // A prompt rewrite narrows nothing and shrinks nothing.
  await service.update(w.session, s.id, { prompt: 'reworded' });
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeRunsPerWeek, 1);

  const back = await service.update(w.session, s.id, { accessLevel: 'OPEN_PR' });
  assert.equal(back.outcome, 'PENDING');
  const daily = await service.update(w.session, s.id, { rule: { kind: 'DAILY', time: '10:00' } });
  assert.equal(daily.outcome, 'PENDING');
});

test('§4 the run\'s own back-off leaves the envelope as it was, and returning needs no decision', { skip }, async () => {
  const w = await world('runs');
  const s = await created(w);
  const run = await runSession(w, s.id);
  const backOff = await service.update(run, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  assert.equal(backOff.outcome, 'APPLIED');
  const backed = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(backed.envelopeRunsPerWeek, 7);
  const revision = await db.scheduleRevision.findUniqueOrThrow({
    where: { scheduleId_revision: { scheduleId: s.id, revision: 2 } },
  });
  assert.equal(revision.changedBy, 'RUN');
  assert.equal(revision.sessionId, (run as { sessionId: string }).sessionId);

  const resumed = await service.update(run, s.id, { rule: { kind: 'DAILY', time: '10:00' } });
  assert.equal(resumed.outcome, 'APPLIED');
  // Any session may return to what was allowed, too.
  await service.update(run, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  const byPerson = await service.update(w.session, s.id, { rule: { kind: 'DAILY', time: '11:00' } });
  assert.equal(byPerson.outcome, 'APPLIED');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeRunsPerWeek, 7);

  // A session serving another schedule's run is an ordinary session here: its narrowing shrinks.
  const other = await created(w);
  const foreign = await runSession(w, other.id);
  await service.update(foreign, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON', 'TUE'] } });
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeRunsPerWeek, 2);
  // And a run asking to widen its own envelope waits like anyone else.
  const widen = await service.update(run, s.id, { accessLevel: 'OPEN_PR' });
  assert.equal(widen.outcome, 'PENDING');
  if (widen.outcome === 'PENDING') assert.equal(widen.request.askedBy, 'RUN');
});

test('§4 a session cannot ask for an envelope wider than its own permission mode (PERMISSION_MODE_WIDER_THAN_SESSION)', { skip }, async () => {
  const w = await world('mode');
  await refusedWith(service.create(w.planSession, input({ accessLevel: 'OPEN_PR' })), 'PERMISSION_MODE_WIDER_THAN_SESSION');
  const ok = await service.create(w.planSession, input({ accessLevel: 'CHECK_ONLY' }));
  assert.equal(ok.outcome, 'PENDING');
  const s = await created(w);
  await refusedWith(service.update(w.planSession, s.id, { accessLevel: 'OPEN_PR' }), 'PERMISSION_MODE_WIDER_THAN_SESSION');
  assert.equal(await db.scheduleChangeRequest.count({ where: { scheduleId: s.id } }), 0);
  // A Default session may ask for OPEN_PR (Accept Edits is not wider than Default): it waits on a card.
  const asked = await service.update(w.session, s.id, { accessLevel: 'OPEN_PR' });
  assert.equal(asked.outcome, 'PENDING');
  // The session's own mode is what counts, not the account default: a session with none stored falls back to it.
  await db.user.update({ where: { id: w.ownerId }, data: { preferences: { defaultPermissionMode: PermissionMode.PLAN } } });
  const unset = await makeSession(w.ownerId, w.workspaceId, null as unknown as string);
  await refusedWith(
    service.create({ kind: 'SESSION', ownerId: w.ownerId, sessionId: unset }, input({ accessLevel: 'OPEN_PR' })),
    'PERMISSION_MODE_WIDER_THAN_SESSION',
  );
});

// ---------------------------------------------------------------------------------------------------------------
// §8 intent and baseline; §8.4 direct controls; §5.1 nextDueAt
// ---------------------------------------------------------------------------------------------------------------

test('§8.1 the intent is kept verbatim, and a baseline becomes a finding already marked as told', { skip }, async () => {
  const w = await world('baseline');
  const intent = '  每天北京时间 10 点检查 Codex 官方稳定版…\n有新版本才告诉我  ';
  const asked = await service.create(w.session, input({
    intent,
    baseline: { key: 'codex@0.48.0', summary: 'Codex 0.48.0, same as pinned.', links: ['https://example.invalid/r'] },
  }));
  assert.equal(asked.outcome, 'PENDING');
  if (asked.outcome !== 'PENDING') return;
  const allowed = await service.decide(w.owner, asked.request.id, 'ALLOW');
  const s = await db.schedule.findUniqueOrThrow({ where: { id: allowed.request.scheduleId! }, include: { findings: true } });
  assert.equal(s.intent, intent);
  assert.equal(s.findings.length, 1);
  assert.equal(s.findings[0].key, 'codex@0.48.0');
  assert.equal(s.findings[0].summary, 'Codex 0.48.0, same as pinned.');
  assert.ok(s.findings[0].notifiedAt, 'already told');
  assert.equal(s.findings[0].firstRunId, null);
  // A prompt rewrite leaves the intent as it was.
  await service.update(w.session, s.id, { prompt: 'new wording' });
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).intent, intent);
  // Without a baseline there is no finding.
  const bare = await created(w);
  assert.equal(await db.scheduleFinding.count({ where: { scheduleId: bare.id } }), 0);
});

test('§8.4 pause, resume, end and delete; each a revision, and Undo of an end resumes', { skip }, async () => {
  const w = await world('controls');
  clockNow = new Date('2026-11-14T08:00:00Z');
  const s = await created(w);
  assert.equal(s.nextDueAt?.toISOString(), '2026-11-15T02:00:00.000Z');
  await insertRun(s.id, 'SCHEDULED', 'QUEUED', '2026-11-14T02:00:00Z');
  const paused = await service.pause(w.owner, s.id);
  assert.equal(paused.state, 'PAUSED');
  assert.equal(paused.nextDueAt, null);
  assert.equal((await db.scheduleRun.findFirstOrThrow({ where: { scheduleId: s.id } })).state, 'CANCELLED');
  clockNow = new Date('2026-11-16T03:00:00Z');
  const resumed = await service.resume(w.session, s.id);
  assert.equal(resumed.state, 'ACTIVE');
  assert.equal(resumed.nextDueAt?.toISOString(), '2026-11-17T02:00:00.000Z', 'next slot after now, nothing caught up');
  const ended = await service.end(w.session, s.id);
  assert.equal(ended.state, 'ENDED');
  assert.equal(ended.endedReason, 'GOAL_REACHED');
  assert.equal(ended.nextDueAt, null);
  const undo = await service.undo(w.owner, s.id, ended.revision);
  assert.equal(undo.outcome, 'APPLIED');
  const back = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(back.state, 'ACTIVE');
  assert.equal(back.endedReason, null);
  assert.equal(back.nextDueAt?.toISOString(), '2026-11-17T02:00:00.000Z');
  const deleted = await service.remove(w.owner, s.id);
  assert.equal(deleted.state, 'ENDED');
  assert.equal(deleted.endedReason, 'DELETED');
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id } }), 1, 'runs are kept');
  await refusedWith(service.update(w.session, s.id, { prompt: 'x' }), 'SCHEDULE_ENDED');
  const kinds = await db.scheduleRevision.findMany({ where: { scheduleId: s.id }, orderBy: { revision: 'asc' } });
  assert.deepEqual(kinds.map((r) => (r.fields as { after: { state?: string } }).after.state ?? null), [
    'ACTIVE', 'PAUSED', 'ACTIVE', 'ENDED', 'ACTIVE', 'ENDED',
  ]);
  clockNow = new Date('2026-11-14T08:00:00Z');
});

test('§5.1 nextDueAt keeps local time across both daylight-saving change days (a skipped time moves on, a repeated one fires first)', { skip }, async () => {
  const w = await world('dst');
  // New York, 2026-03-08: 02:00 jumps to 03:00, so 02:30 does not exist that day and fires at 03:00 EDT.
  clockNow = new Date('2026-03-07T12:00:00Z');
  const spring = await created(w, { rule: { kind: 'DAILY', time: '02:30' }, timezone: 'America/New_York' });
  assert.equal(spring.nextDueAt?.toISOString(), '2026-03-08T07:00:00.000Z');
  // New York, 2026-11-01: 02:00 falls back to 01:00, so 01:30 happens twice and fires on the first, 01:30 EDT.
  clockNow = new Date('2026-10-31T12:00:00Z');
  const autumn = await created(w, { rule: { kind: 'DAILY', time: '01:30' }, timezone: 'America/New_York' });
  assert.equal(autumn.nextDueAt?.toISOString(), '2026-11-01T05:30:00.000Z');
  // 10:00 stays 10:00 after the change: the day after the fall-back is on EST.
  clockNow = new Date('2026-11-01T06:00:00Z');
  const ten = await created(w, { rule: { kind: 'DAILY', time: '10:00' }, timezone: 'America/New_York' });
  assert.equal(ten.nextDueAt?.toISOString(), '2026-11-01T15:00:00.000Z');
  clockNow = new Date('2026-11-14T08:00:00Z');
});
