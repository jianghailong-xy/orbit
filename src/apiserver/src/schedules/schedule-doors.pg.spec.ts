/**
 * The doors of scheduled tasks (docs/scheduled-tasks-design.md §4, §8, §9.1), driven through the controllers
 * themselves against a real PostgreSQL: the runner doors behind a session's `schedule_*` tools
 * (RunnerSchedulesController) and the REST doors (SchedulesController).
 *
 *   * every tool door and every REST door on its allowed path;
 *   * the create card: before the press there is no schedule, after it there is one whose envelope is the card's;
 *     the pressing device's time zone, and the cases it is refused;
 *   * a change inside the envelope applies at once and leaves a record with Undo in the session; outside it leaves
 *     an envelope card; a stale card is withdrawn, not applied;
 *   * OWNER CHANNEL ONLY — every case is named "owner channel:": a PAT, an acting session and a run's session are
 *     refused Create, Allow and Decline;
 *   * a run's session: it may change and end only the schedule it serves, its widen request is a PENDING card in the
 *     owner's list while the run goes on, and only it may report;
 *   * Run now after ENDED is refused.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-doors.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode, SCHEDULE_COPY } from '@orbit/shared';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin, SessionRunSource, type Runner } from '@prisma/client';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerSchedulesController } from '../runner-api/runner-schedules.controller';
import { SessionsService } from '../sessions/sessions.service';
import { ScheduleReadsService } from './schedule-reads.service';
import { ScheduleRunsService, type ScheduleRunSessionPort } from './schedule-runs.service';
import { ScheduleChangeConversations } from './schedule-change-conversation';
import { SchedulePageChats } from './schedule-page-chat';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);

let db: PrismaClient;
let pg: Client;
let schedules: SchedulesService;
let runs: ScheduleRunsService;
let reads: ScheduleReadsService;
let tools: RunnerSchedulesController;
let rest: SchedulesController;
const interrupted: string[] = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL!);
  pg = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await pg.connect();
  await verifyCoordinatorPgIdentity(pg);
  db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  // The run side's session doors: no runner here, and what is under test is the rows the doors write.
  const port: ScheduleRunSessionPort = {
    land: async () => undefined,
    open: async () => undefined,
    interrupt: async (_owner, sessionId) => void interrupted.push(sessionId),
    complete: async () => undefined,
    end: async () => undefined,
  };
  schedules = new SchedulesService(prisma);
  runs = new ScheduleRunsService(prisma, port);
  reads = new ScheduleReadsService(prisma);
  tools = new RunnerSchedulesController(prisma, schedules, runs, reads);
  // The real create door, as the quick-add line uses it; its runner and realtime sides are no-ops here.
  const quiet = new Proxy({}, { get: () => () => undefined });
  const sessions = new SessionsService(db as never, quiet as never, quiet as never);
  rest = new SchedulesController(
    schedules, runs, reads, sessions, new ScheduleChangeConversations(prisma, sessions), new SchedulePageChats(prisma, sessions),
  );
});

after(async () => {
  if (skip) return;
  await db.$disconnect();
  await pg.end();
});

// -----------------------------------------------------------------------------------------------------------------
// The world
// -----------------------------------------------------------------------------------------------------------------

interface World {
  ownerId: string;
  runner: Runner;
  workspaceId: string;
  workspaceName: string;
  otherWorkspaceId: string;
  /** An ordinary session in Default mode, hosted by `runner`. */
  sessionId: string;
  user: AuthUser;
  pat: AuthUser;
}

const NO_SESSION = { headers: {} };
const acting = (sessionId: string) => ({ headers: { 'x-orbit-session-id': sessionId } });

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-doors.invalid`, name: label, passwordHash: 'x' },
  });
  const runner = await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceName = `${label}-ws`;
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: workspaceName, enabled: true } });
  await db.workspace.create({ data: { id: otherWorkspaceId, ownerId, runnerId, name: `${label}-other`, enabled: true } });
  const sessionId = await makeSession(ownerId, workspaceId, PermissionMode.DEFAULT, runnerId);
  return {
    ownerId,
    runner,
    workspaceId,
    workspaceName,
    otherWorkspaceId,
    sessionId,
    user: { userId: ownerId, email: 'owner@x', credential: { kind: 'LOGIN' } },
    pat: { userId: ownerId, email: 'owner@x', credential: { kind: 'PAT', tokenId: randomUUID(), scopes: ['sessions:write'], workspaceIds: [] } },
  };
}

async function makeSession(
  ownerId: string,
  workspaceId: string,
  permissionMode: string,
  runnerId: string | null,
  extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId, creatorId: ownerId, workspaceId, title: 'chat', prompt: 'p', provider: 'claude', engine: 'claude',
      providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, permissionMode,
      assignedRunnerId: runnerId, ...extra,
    },
  });
  return id;
}

const CREATE = {
  intent: '每天北京时间 10 点检查 Codex 官方稳定版，有新版本才告诉我',
  title: 'Codex stable check',
  readBack: 'Every day at 10:00 I check the latest stable Codex against the pinned version, and tell you only when there is a new one.',
  prompt: 'Check the latest stable Codex release against the version the apiserver pins.',
  rule: { kind: 'DAILY', time: '10:00' },
  accessLevel: 'CHECK_ONLY' as const,
  baseline: { key: 'codex@0.48.0', summary: 'Codex 0.48.0, same as pinned. Nothing to report.' },
};

/** A schedule made the only way there is: a session's create card, and the owner's Create. */
async function createdThroughCard(w: World, over: Record<string, unknown> = {}) {
  const pending = await tools.create(w.runner, w.sessionId, { ...CREATE, timezone: 'Asia/Shanghai', ...over } as never);
  assert.equal(pending.outcome, 'PENDING');
  const allowed = await rest.allow(w.user, (pending as { card: { id: string } }).card.id, {}, NO_SESSION);
  assert.equal(allowed.outcome, 'ALLOWED');
  return allowed.schedule!;
}

/** A session serving a RUNNING run of `scheduleId`, hosted by the world's runner. */
async function runSession(w: World, scheduleId: string): Promise<{ sessionId: string; runId: string }> {
  const run = await db.scheduleRun.create({
    data: { scheduleId, scheduleRevision: 1, plannedAt: new Date(), trigger: 'MANUAL', state: 'RUNNING', startedAt: new Date() },
  });
  const sessionId = await makeSession(w.ownerId, w.workspaceId, PermissionMode.PLAN, w.runner.id, {
    runSource: SessionRunSource.SCHEDULE,
    scheduleRunId: run.id,
  });
  await db.scheduleRun.update({ where: { id: run.id }, data: { sessionId } });
  return { sessionId, runId: run.id };
}

async function refusedWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const body = (err as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
    assert.equal(body?.code, code, `expected ${code}, got ${JSON.stringify(body ?? String(err))}`);
    return true;
  });
}

// -----------------------------------------------------------------------------------------------------------------
// The create card
// -----------------------------------------------------------------------------------------------------------------

test('schedule_create: a card, no schedule; Create writes one whose envelope is the card\'s, in the pressing device\'s zone', { skip }, async () => {
  const w = await world('create');
  const pending = await tools.create(w.runner, w.sessionId, CREATE as never);
  assert.equal(pending.outcome, 'PENDING');
  const { card, note, scheduled } = pending as unknown as {
    card: {
      id: string; kind: string; state: string; title: string; readBack: string; askedBySessionId: string;
      when: { text: string; timezone: string | null; firstRunAt: string | null };
      runsIn: { workspaceId: string; text: string };
      may: { accessLevel: string; text: string };
      costs: { runsPerWeek: number; runLimitMinutes: number; text: string };
      today: { key: string; text: string } | null;
      notice: string;
    };
    note: string;
    scheduled: boolean;
  };
  // In words, so an agent cannot report the card as a schedule.
  assert.equal(scheduled, false);
  assert.match(note, /^Nothing is scheduled yet\./);
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0, 'before the press there is no schedule');
  assert.equal(card.kind, 'CREATE');
  assert.equal(card.state, 'PENDING');
  assert.equal(card.title, 'Codex stable check');
  assert.equal(card.readBack, CREATE.readBack);
  assert.equal(card.askedBySessionId, w.sessionId);
  assert.equal(card.when.text, 'Daily 10:00 · your time zone', 'no zone yet: no first run either');
  assert.equal(card.when.timezone, null);
  assert.equal(card.runsIn.workspaceId, w.workspaceId);
  assert.equal(card.runsIn.text, `${w.workspaceName} · Claude agent`);
  assert.equal(card.may.text, 'Check only · reads and reports, edits nothing');
  assert.equal(card.costs.text, 'Up to 7 runs a week, 30 min each');
  assert.equal(card.today?.text, CREATE.baseline.summary);
  assert.equal(card.notice, "You'll hear about new findings and failures only.");

  // The card is the session's, and it is the owner's to answer.
  const cards = await rest.sessionCards(w.user, w.sessionId);
  assert.deepEqual(cards.cards.map((c) => c.id), [card.id]);
  const owed = await rest.requests(w.user);
  assert.deepEqual(owed.requests.map((c) => c.id), [card.id]);

  // Create, from a device in Beijing.
  const allowed = await rest.allow(w.user, card.id, { timezone: 'Asia/Shanghai' }, NO_SESSION);
  assert.equal(allowed.outcome, 'ALLOWED');
  const schedule = await db.schedule.findFirstOrThrow({ where: { ownerId: w.ownerId } });
  assert.equal(schedule.id, allowed.schedule!.id);
  assert.equal(schedule.timezone, 'Asia/Shanghai');
  assert.equal(schedule.workspaceId, w.workspaceId);
  assert.equal(schedule.createdFromSessionId, w.sessionId);
  assert.deepEqual(
    {
      workspaceId: schedule.envelopeWorkspaceId,
      accessLevel: schedule.envelopeAccessLevel,
      runsPerWeek: schedule.envelopeRunsPerWeek,
      runLimitMinutes: schedule.envelopeRunLimitMinutes,
    },
    {
      workspaceId: card.runsIn.workspaceId,
      accessLevel: card.may.accessLevel,
      runsPerWeek: card.costs.runsPerWeek,
      runLimitMinutes: card.costs.runLimitMinutes,
    },
    'the envelope is what the card showed',
  );
  const baseline = await db.scheduleFinding.findFirstOrThrow({ where: { scheduleId: schedule.id } });
  assert.equal(baseline.key, 'codex@0.48.0');
  assert.ok(baseline.notifiedAt, 'the baseline is already told');
  const detail = await rest.get(w.user, schedule.id);
  assert.equal(detail.readBack, CREATE.readBack, 'the inspector reads back what the card did');
});

test('schedule_create: Not now leaves nothing; a card naming its zone refuses another, one naming none needs one', { skip }, async () => {
  const w = await world('create-zone');
  const declined = await tools.create(w.runner, w.sessionId, CREATE as never);
  const no = await rest.decline(w.user, (declined as { card: { id: string } }).card.id, NO_SESSION);
  assert.equal(no.outcome, 'DECLINED');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0);
  await refusedWith(rest.allow(w.user, (declined as { card: { id: string } }).card.id, {}, NO_SESSION), 'SCHEDULE_REQUEST_DECIDED');

  const zoned = await tools.create(w.runner, w.sessionId, { ...CREATE, timezone: 'Asia/Shanghai' } as never);
  const zonedId = (zoned as { card: { id: string; when: { text: string } } }).card.id;
  assert.match(
    (zoned as { card: { when: { text: string } } }).card.when.text,
    /^Daily 10:00 · Asia\/Shanghai · first run (today|tomorrow)$/,
  );
  await refusedWith(rest.allow(w.user, zonedId, { timezone: 'Europe/Berlin' }, NO_SESSION), 'SCHEDULE_TIMEZONE_ALREADY_SET');
  const unzoned = await tools.create(w.runner, w.sessionId, CREATE as never);
  await refusedWith(rest.allow(w.user, (unzoned as { card: { id: string } }).card.id, {}, NO_SESSION), 'SCHEDULE_TIMEZONE_REQUIRED');
  await refusedWith(rest.allow(w.user, (unzoned as { card: { id: string } }).card.id, { timezone: 'Mars/Olympus' }, NO_SESSION), 'SCHEDULE_TIMEZONE_INVALID');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0, 'no refused press wrote a schedule');
  // Its own zone, pressed with the same one, is fine.
  const ok = await rest.allow(w.user, zonedId, { timezone: 'Asia/Shanghai' }, NO_SESSION);
  assert.equal(ok.schedule?.timezone, 'Asia/Shanghai');
});

test('runner doors need a session this runner hosts', { skip }, async () => {
  const w = await world('host');
  const elsewhere = await makeSession(w.ownerId, w.workspaceId, PermissionMode.DEFAULT, null);
  await assert.rejects(tools.create(w.runner, elsewhere, CREATE as never), /names no session this runner hosts/);
  await assert.rejects(tools.create(w.runner, undefined, CREATE as never), /needs X-Orbit-Session-Id/);
});

// -----------------------------------------------------------------------------------------------------------------
// Owner channel only
// -----------------------------------------------------------------------------------------------------------------

test('owner channel: a PAT cannot Create, Allow or Decline a card', { skip }, async () => {
  const w = await world('oc-pat');
  const pending = await tools.create(w.runner, w.sessionId, { ...CREATE, timezone: 'UTC' } as never);
  const id = (pending as { card: { id: string } }).card.id;
  await refusedWith(rest.allow(w.pat, id, {}, NO_SESSION), 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  await refusedWith(rest.decline(w.pat, id, NO_SESSION), 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  const s = await createdThroughCard(w);
  const widen = await tools.update(w.runner, w.sessionId, s.id, { runLimitMinutes: 90 } as never);
  await refusedWith(rest.allow(w.pat, (widen as { card: { id: string } }).card.id, {}, NO_SESSION), 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id } })).state, 'PENDING');
});

test('owner channel: a request carrying an acting session cannot Create, Allow or Decline a card', { skip }, async () => {
  const w = await world('oc-session');
  const pending = await tools.create(w.runner, w.sessionId, { ...CREATE, timezone: 'UTC' } as never);
  const id = (pending as { card: { id: string } }).card.id;
  await refusedWith(rest.allow(w.user, id, {}, acting(w.sessionId)), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  await refusedWith(rest.decline(w.user, id, acting(w.sessionId)), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  // The service itself, as any other door would call it.
  await refusedWith(schedules.decide({ kind: 'SESSION', ownerId: w.ownerId, sessionId: w.sessionId }, id, 'ALLOW'), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id } })).state, 'PENDING');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0);
});

test('owner channel: a run\'s session cannot Allow its own widen card', { skip }, async () => {
  const w = await world('oc-run');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  const widen = await tools.update(w.runner, run.sessionId, s.id, { accessLevel: 'OPEN_PR' } as never);
  const id = (widen as { card: { id: string } }).card.id;
  await refusedWith(rest.allow(w.user, id, {}, acting(run.sessionId)), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  await refusedWith(rest.decline(w.user, id, acting(run.sessionId)), 'SCHEDULE_DECISION_OWNER_CHANNEL_ONLY');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeAccessLevel, 'CHECK_ONLY');
});

// -----------------------------------------------------------------------------------------------------------------
// Changing: inside the envelope with Undo, outside on a card
// -----------------------------------------------------------------------------------------------------------------

test('schedule_update inside the envelope applies at once and leaves a record with Undo in the session', { skip }, async () => {
  const w = await world('inside');
  const s = await createdThroughCard(w);
  const applied = await tools.update(w.runner, w.sessionId, s.id, { rule: { kind: 'DAILY', time: '09:00' } } as never);
  assert.equal(applied.outcome, 'APPLIED');
  const record = (applied as { record: { revision: number; changedBy: string; changed: string[]; undo: { path: string; body: { revision: number } } } }).record;
  assert.equal(record.changedBy, 'SESSION');
  assert.ok(record.changed.includes('rule'));
  assert.equal(record.undo.path, `/api/schedules/${s.id}/undo`);
  assert.equal(record.undo.body.revision, record.revision);
  assert.equal(await db.scheduleChangeRequest.count({ where: { scheduleId: s.id, state: 'PENDING' } }), 0, 'no card');

  const cards = await rest.sessionCards(w.user, w.sessionId);
  const line = cards.records.find((r) => r.scheduleId === s.id && r.revision === record.revision)!;
  assert.ok(line.undo, 'the session shows the change with Undo');

  const undone = await rest.undo(w.user, s.id, { revision: record.revision }, NO_SESSION);
  assert.equal(undone.outcome, 'APPLIED');
  assert.deepEqual((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).rule, { kind: 'DAILY', time: '10:00' });
  const after = await rest.sessionCards(w.user, w.sessionId);
  const again = after.records.find((r) => r.revision === record.revision)!;
  assert.equal(again.undo, null, 'an undone change offers no second Undo');
  assert.equal(again.undoneByRevision, record.revision + 1);
});

test('schedule_update outside the envelope leaves an envelope card (Now / Asked); Allow writes the envelope', { skip }, async () => {
  const w = await world('outside');
  const s = await createdThroughCard(w);
  const pending = await tools.update(w.runner, w.sessionId, s.id, { runLimitMinutes: 60 } as never);
  assert.equal(pending.outcome, 'PENDING');
  const { card, note } = pending as unknown as {
    card: { id: string; kind: string; envelope: { widens: string[]; now: { costs: { text: string } }; asked: { costs: { text: string } } } };
    note: string;
  };
  assert.match(note, /^Not changed yet/);
  assert.equal(card.kind, 'UPDATE');
  assert.deepEqual(card.envelope.widens, ['RUN_LIMIT']);
  assert.equal(card.envelope.now.costs.text, 'Up to 7 runs a week, 30 min each');
  assert.equal(card.envelope.asked.costs.text, 'Up to 7 runs a week, 60 min each');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).runLimitMinutes, 30, 'nothing applied yet');
  const allowed = await rest.allow(w.user, card.id, {}, NO_SESSION);
  assert.equal(allowed.outcome, 'ALLOWED');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(now.runLimitMinutes, 60);
  assert.equal(now.envelopeRunLimitMinutes, 60);
  // An envelope card takes no zone: only a create card does.
  const next = await tools.update(w.runner, w.sessionId, s.id, { runLimitMinutes: 90 } as never);
  await refusedWith(rest.allow(w.user, (next as { card: { id: string } }).card.id, { timezone: 'UTC' }, NO_SESSION), 'SCHEDULE_TIMEZONE_NOT_TAKEN');
});

test('Allow re-judges: a card asked of an older revision is withdrawn, not applied', { skip }, async () => {
  const w = await world('stale');
  const s = await createdThroughCard(w);
  const pending = await tools.update(w.runner, w.sessionId, s.id, { runLimitMinutes: 60 } as never);
  const id = (pending as { card: { id: string } }).card.id;
  await tools.update(w.runner, w.sessionId, s.id, { title: 'Codex check' } as never);
  await refusedWith(rest.allow(w.user, id, {}, NO_SESSION), 'SCHEDULE_REQUEST_STALE');
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id } })).state, 'SUPERSEDED');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(now.runLimitMinutes, 30);
  assert.equal(now.envelopeRunLimitMinutes, 30);
});

// -----------------------------------------------------------------------------------------------------------------
// A run's own session (§8.3)
// -----------------------------------------------------------------------------------------------------------------

test('a run may change and end its own schedule inside the envelope; its widen is a card the owner is owed', { skip }, async () => {
  const w = await world('run-own');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  const backedOff = await tools.update(w.runner, run.sessionId, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } } as never);
  assert.equal(backedOff.outcome, 'APPLIED');
  assert.equal((backedOff as { record: { changedBy: string } }).record.changedBy, 'RUN');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).envelopeRunsPerWeek, 7, 'a run\'s own narrowing keeps the envelope');

  const widen = await tools.update(w.runner, run.sessionId, s.id, { accessLevel: 'OPEN_PR' } as never);
  assert.equal(widen.outcome, 'PENDING');
  const card = (widen as { card: { id: string; askedBy: string; askedBySessionId: string } }).card;
  assert.equal(card.askedBy, 'RUN');
  assert.equal(card.askedBySessionId, run.sessionId);
  // What the owner is owed (the Waiting on you item itself is S3's, filed from this same request).
  const owed = await rest.requests(w.user, 'PENDING');
  assert.ok(owed.requests.some((r) => r.id === card.id && r.askedBy === 'RUN'), 'the run\'s widen is among the owner\'s pending cards');
  const runRow = await db.scheduleRun.findUniqueOrThrow({ where: { id: run.runId } });
  assert.equal(runRow.state, 'RUNNING', 'the run goes on under the access it has');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).accessLevel, 'CHECK_ONLY');

  const ended = await tools.end(w.runner, run.sessionId, s.id);
  assert.equal(ended.schedule.state, 'ENDED');
  assert.equal(ended.schedule.endedReason, 'GOAL_REACHED');
  assert.equal(ended.record?.changedBy, 'RUN');
});

test('a run\'s session may not change, end or control another schedule, nor create one, nor use the controls on its own', { skip }, async () => {
  const w = await world('run-scope');
  const mine = await createdThroughCard(w);
  const other = await createdThroughCard(w, { title: 'Other check', intent: 'Check the other thing every day' });
  const run = await runSession(w, mine.id);
  const before = await db.schedule.findUniqueOrThrow({ where: { id: other.id } });
  await refusedWith(tools.update(w.runner, run.sessionId, other.id, { title: 'mine now' } as never), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.end(w.runner, run.sessionId, other.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.pause(w.runner, run.sessionId, other.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.remove(w.runner, run.sessionId, other.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.runNow(w.runner, run.sessionId, other.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.create(w.runner, run.sessionId, { ...CREATE, timezone: 'UTC' } as never), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.pause(w.runner, run.sessionId, mine.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.remove(w.runner, run.sessionId, mine.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.stop(w.runner, run.sessionId, run.runId), 'SCHEDULE_RUN_SESSION_SCOPE');
  const after = await db.schedule.findUniqueOrThrow({ where: { id: other.id } });
  assert.deepEqual(after, before, 'the other schedule is untouched');
});

test('schedule_run_report: the run\'s own session reports once; an ordinary session is refused', { skip }, async () => {
  const w = await world('report');
  const s = await createdThroughCard(w);
  await refusedWith(
    tools.report(w.runner, w.sessionId, { outcome: 'NO_CHANGE', summary: 'nothing' } as never),
    'SCHEDULE_RUN_REPORT_NOT_A_RUN',
  );
  const run = await runSession(w, s.id);
  const reported = await tools.report(w.runner, run.sessionId, { outcome: 'CHANGED', key: 'codex@0.49.0', summary: 'New: 0.49.0' } as never);
  assert.equal(reported.run.state, 'CHANGED');
  assert.equal(reported.newFinding, true);
  await refusedWith(
    tools.report(w.runner, run.sessionId, { outcome: 'NO_CHANGE', summary: 'again' } as never),
    'SCHEDULE_RUN_ALREADY_REPORTED',
  );
});

// -----------------------------------------------------------------------------------------------------------------
// Reads and controls, every door
// -----------------------------------------------------------------------------------------------------------------

test('tool doors: list, get, pause, resume, run now, stop, end, delete', { skip }, async () => {
  const w = await world('tools');
  const s = await createdThroughCard(w);
  const listed = await tools.list(w.runner);
  assert.deepEqual(listed.schedules.map((x) => x.id), [s.id]);
  const got = await tools.get(w.runner, s.id);
  assert.equal(got.schedule.id, s.id);
  assert.equal((await tools.pause(w.runner, w.sessionId, s.id)).schedule.state, 'PAUSED');
  assert.equal((await tools.resume(w.runner, w.sessionId, s.id)).schedule.state, 'ACTIVE');
  const manual = await tools.runNow(w.runner, w.sessionId, s.id);
  assert.equal(manual.run.trigger, 'MANUAL');
  await db.scheduleRun.update({ where: { id: manual.run.id }, data: { state: 'RUNNING', startedAt: new Date() } });
  assert.equal((await tools.stop(w.runner, w.sessionId, manual.run.id)).run.state, 'CANCELLED');
  assert.equal((await tools.end(w.runner, w.sessionId, s.id)).schedule.endedReason, 'GOAL_REACHED');
  await refusedWith(tools.runNow(w.runner, w.sessionId, s.id), 'SCHEDULE_ENDED');
  const t = await createdThroughCard(w);
  assert.equal((await tools.remove(w.runner, w.sessionId, t.id)).schedule.endedReason, 'DELETED');
  assert.deepEqual((await tools.list(w.runner)).schedules.map((x) => x.id), [], 'ended ones are listed only when asked for');
  assert.equal((await tools.list(w.runner, 'all')).schedules.length, 2);
});

test('REST doors: list, detail with this month\'s use, runs, pause, resume, run, undo, delete, stop; a PAT uses the controls as the person', { skip }, async () => {
  const w = await world('rest');
  const s = await createdThroughCard(w);
  assert.deepEqual((await rest.list(w.user)).schedules.map((x) => x.id), [s.id]);

  // Two runs this month, one with a cost the engine reported.
  const now = Date.now();
  for (const [minutes, cost] of [[3, 0.25], [2, 0]] as const) {
    const sessionId = await makeSession(w.ownerId, w.workspaceId, PermissionMode.PLAN, null, { costUsd: cost });
    await db.scheduleRun.create({
      data: {
        scheduleId: s.id, scheduleRevision: 1, plannedAt: new Date(now - minutes * 60_000), trigger: 'MANUAL',
        state: 'NO_CHANGE', startedAt: new Date(now - minutes * 60_000), endedAt: new Date(now), sessionId,
      },
    });
  }
  const detail = await rest.get(w.user, s.id);
  assert.equal(detail.usage.runs, 2);
  assert.equal(detail.usage.minutes, 5);
  assert.equal(detail.usage.costUsd, 0.25);
  assert.equal(detail.usage.text, '2 runs · 5 min', 'This month is the block\'s title, and the cost its own field');
  assert.equal((await rest.listRuns(w.user, s.id)).runs.length, 2);

  const paused = await rest.pause(w.pat, s.id, NO_SESSION);
  assert.equal(paused.schedule.state, 'PAUSED');
  assert.equal(paused.record?.changedBy, 'USER', 'a token is recorded as the person');
  const resumed = await rest.resume(w.user, s.id, NO_SESSION);
  assert.equal(resumed.schedule.state, 'ACTIVE');
  const run = await rest.runNow(w.user, s.id, NO_SESSION);
  assert.equal(run.run.trigger, 'MANUAL');
  await db.scheduleRun.update({ where: { id: run.run.id }, data: { state: 'RUNNING', startedAt: new Date() } });
  assert.equal((await rest.stop(w.user, run.run.id, NO_SESSION)).run.failureReason, 'CANCELLED_BY_OWNER');
  // The pause has been resumed since, so undoing it is stale; undoing the resume is not.
  await refusedWith(rest.undo(w.user, s.id, { revision: paused.record!.revision }, NO_SESSION), 'SCHEDULE_UNDO_STALE');
  const undo = await rest.undo(w.user, s.id, { revision: resumed.record!.revision }, NO_SESSION);
  assert.equal(undo.outcome, 'APPLIED');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).state, 'PAUSED');
  assert.equal((await rest.remove(w.user, s.id, NO_SESSION)).schedule.endedReason, 'DELETED');
  await refusedWith(rest.runNow(w.user, s.id, NO_SESSION), 'SCHEDULE_ENDED');
  await refusedWith(rest.runNow(w.pat, s.id, NO_SESSION), 'SCHEDULE_ENDED');
  assert.ok((await rest.get(w.user, s.id)).history.length >= 4, 'an ended schedule keeps its history');
});

test('the Scheduled page\'s quick-add: a sentence opens an ordinary session; its create card is a draft', { skip }, async () => {
  const w = await world('drafts');
  const opened = await rest.draft(w.user, { workspaceId: w.workspaceId, text: 'every weekday at 9 summarise open PRs' });
  // Opened through the real SessionsService.create: an ordinary session, the person's, in the line's workspace.
  const session = await db.session.findUniqueOrThrow({ where: { id: opened.sessionId } });
  assert.equal(session.workspaceId, w.workspaceId);
  assert.equal(session.ownerId, w.ownerId);
  assert.ok(session.prompt.includes('every weekday at 9 summarise open PRs'));
  assert.ok(session.prompt.includes('mcp__orbit__schedule_create'));
  assert.equal(session.runSource, SessionRunSource.MANUAL, 'an ordinary session');
  assert.equal(session.scheduleRunId, null);
  assert.notEqual(session.openedBy, 'SCHEDULE');
  // Another account's workspace opens nothing.
  const stranger = await world('drafts-stranger');
  await assert.rejects(rest.draft(stranger.user, { workspaceId: w.workspaceId, text: 'mine now' }));
  await db.session.update({ where: { id: opened.sessionId }, data: { assignedRunnerId: w.runner.id } });
  const pending = await tools.create(w.runner, opened.sessionId, { ...CREATE, rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] } } as never);
  const id = (pending as { card: { id: string } }).card.id;
  const { drafts } = await rest.drafts(w.user);
  assert.deepEqual(drafts.map((d) => [d.id, d.askedBySessionId]), [[id, opened.sessionId]]);
  assert.equal(drafts[0].when?.text, 'Weekdays at 09:00 · your time zone');
  await rest.decline(w.user, id, NO_SESSION);
  assert.deepEqual((await rest.drafts(w.user)).drafts, [], 'Not now takes the draft away');
});

// -----------------------------------------------------------------------------------------------------------------
// Review round 1 (2026-11-15): re-judging at the press, a run and the intent, two accounts, races, a run's own controls
// -----------------------------------------------------------------------------------------------------------------

test('Allow re-checks the workspace: a create card whose workspace was deleted since the ask is withdrawn, not applied', { skip }, async () => {
  const w = await world('gone-create');
  const pending = await tools.create(w.runner, w.sessionId, { ...CREATE, timezone: 'UTC' } as never);
  const id = (pending as { card: { id: string } }).card.id;
  await db.workspace.update({ where: { id: w.workspaceId }, data: { deletedAt: new Date() } });
  await assert.rejects(rest.allow(w.user, id, {}, NO_SESSION), (err: unknown) => {
    const body = (err as { getResponse: () => { code: string; reason: string } }).getResponse();
    assert.equal(body.code, 'SCHEDULE_REQUEST_STALE');
    assert.equal(body.reason, 'WORKSPACE_GONE');
    return true;
  });
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id } })).state, 'SUPERSEDED');
  assert.equal(await db.schedule.count({ where: { ownerId: w.ownerId } }), 0, 'no schedule in a deleted workspace');
});

test('Allow re-checks the workspace: an envelope card moving to a workspace deleted since the ask is withdrawn', { skip }, async () => {
  const w = await world('gone-move');
  const s = await createdThroughCard(w);
  const pending = await tools.update(w.runner, w.sessionId, s.id, { workspaceId: w.otherWorkspaceId } as never);
  const id = (pending as { card: { id: string } }).card.id;
  await db.workspace.update({ where: { id: w.otherWorkspaceId }, data: { deletedAt: new Date() } });
  await refusedWith(rest.allow(w.user, id, {}, NO_SESSION), 'SCHEDULE_REQUEST_STALE');
  const now = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(now.workspaceId, w.workspaceId);
  assert.equal(now.envelopeWorkspaceId, w.workspaceId);
  // A workspace that is not the owner's at all is refused at the ask.
  const stranger = await world('gone-move-stranger');
  await refusedWith(tools.update(w.runner, w.sessionId, s.id, { workspaceId: stranger.workspaceId } as never), 'WORKSPACE_NOT_FOUND');
});

test('a run may not restate the intent; its prompt, rule, end and ending stay its own', { skip }, async () => {
  const w = await world('run-intent');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  await refusedWith(
    tools.update(w.runner, run.sessionId, s.id, { intent: 'something else entirely' } as never),
    'SCHEDULE_RUN_MAY_NOT_RESTATE_INTENT',
  );
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).intent, CREATE.intent);
  const ok = await tools.update(w.runner, run.sessionId, s.id, {
    prompt: 'Check the releases page instead.', rule: { kind: 'DAILY', time: '11:00' }, endAt: '2027-01-01T00:00:00Z',
  } as never);
  assert.equal(ok.outcome, 'APPLIED');
  // The person restating the goal, from a session, still may.
  assert.equal((await tools.update(w.runner, w.sessionId, s.id, { intent: 'check it hourly-ish' } as never)).outcome, 'APPLIED');
});

test('a run on its OWN schedule may not resume it, run it now or undo, through the tools or the REST doors', { skip }, async () => {
  const w = await world('run-own-controls');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  const backedOff = await tools.update(w.runner, run.sessionId, s.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } } as never);
  const revision = (backedOff as { record: { revision: number } }).record.revision;
  await rest.pause(w.user, s.id, NO_SESSION);
  await refusedWith(tools.resume(w.runner, run.sessionId, s.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(tools.runNow(w.runner, run.sessionId, s.id), 'SCHEDULE_RUN_SESSION_SCOPE');
  // The REST doors with the run's acting-session header are that run, and refuse it the same.
  await refusedWith(rest.resume(w.user, s.id, acting(run.sessionId)), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(rest.runNow(w.user, s.id, acting(run.sessionId)), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(rest.undo(w.user, s.id, { revision }, acting(run.sessionId)), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(rest.pause(w.user, s.id, acting(run.sessionId)), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(rest.remove(w.user, s.id, acting(run.sessionId)), 'SCHEDULE_RUN_SESSION_SCOPE');
  await refusedWith(rest.stop(w.user, run.runId, acting(run.sessionId)), 'SCHEDULE_RUN_SESSION_SCOPE');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).state, 'PAUSED');
});

test('two accounts: another account\'s ids name nothing on every door and every tool', { skip }, async () => {
  const a = await world('two-a');
  const b = await world('two-b');
  const s = await createdThroughCard(a);
  const pending = await tools.update(a.runner, a.sessionId, s.id, { runLimitMinutes: 90 } as never);
  const card = (pending as { card: { id: string } }).card.id;
  const run = await db.scheduleRun.create({
    data: { scheduleId: s.id, scheduleRevision: 1, plannedAt: new Date(), trigger: 'MANUAL', state: 'RUNNING', startedAt: new Date() },
  });
  const before = JSON.stringify(await db.schedule.findUniqueOrThrow({ where: { id: s.id } }));
  // REST, as B.
  assert.deepEqual((await rest.requests(b.user, 'all')).requests, []);
  assert.deepEqual((await rest.list(b.user, 'all')).schedules, []);
  assert.deepEqual((await rest.drafts(b.user)).drafts, []);
  await refusedWith(rest.request(b.user, card), 'SCHEDULE_REQUEST_NOT_FOUND');
  await refusedWith(rest.allow(b.user, card, {}, NO_SESSION), 'SCHEDULE_REQUEST_NOT_FOUND');
  await refusedWith(rest.decline(b.user, card, NO_SESSION), 'SCHEDULE_REQUEST_NOT_FOUND');
  await assert.rejects(rest.sessionCards(b.user, a.sessionId), /session not found/);
  await refusedWith(rest.get(b.user, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.listRuns(b.user, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.pause(b.user, s.id, NO_SESSION), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.resume(b.user, s.id, NO_SESSION), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.runNow(b.user, s.id, NO_SESSION), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.undo(b.user, s.id, { revision: 2 }, NO_SESSION), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.remove(b.user, s.id, NO_SESSION), 'SCHEDULE_NOT_FOUND');
  await refusedWith(rest.stop(b.user, run.id, NO_SESSION), 'SCHEDULE_RUN_NOT_FOUND');
  // Every tool, as B's own session on B's own runner.
  await refusedWith(tools.get(b.runner, s.id), 'SCHEDULE_NOT_FOUND');
  assert.deepEqual((await tools.list(b.runner, 'all')).schedules, []);
  await refusedWith(tools.update(b.runner, b.sessionId, s.id, { title: 'mine' } as never), 'SCHEDULE_NOT_FOUND');
  await refusedWith(tools.pause(b.runner, b.sessionId, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(tools.resume(b.runner, b.sessionId, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(tools.runNow(b.runner, b.sessionId, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(tools.end(b.runner, b.sessionId, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(tools.remove(b.runner, b.sessionId, s.id), 'SCHEDULE_NOT_FOUND');
  await refusedWith(tools.stop(b.runner, b.sessionId, run.id), 'SCHEDULE_RUN_NOT_FOUND');
  await refusedWith(tools.report(b.runner, b.sessionId, { outcome: 'NO_CHANGE', summary: 'x' } as never), 'SCHEDULE_RUN_REPORT_NOT_A_RUN');
  // B's runner cannot speak as A's session.
  await assert.rejects(tools.update(b.runner, a.sessionId, s.id, { title: 'mine' } as never), /names no session this runner hosts/);
  assert.equal(JSON.stringify(await db.schedule.findUniqueOrThrow({ where: { id: s.id } })), before, 'nothing of A\'s changed');
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id: card } })).state, 'PENDING');
});

test('presses at once: Allow with Decline, and Allow with Allow, apply exactly one outcome', { skip }, async () => {
  const w = await world('race');
  for (const pair of [['allow', 'decline'], ['allow', 'allow']] as const) {
    // A schedule of its own per pair: the same session asking again for one it created is answered EXISTS.
    const own = { title: `Race ${pair.join('+')}`, intent: `Race ${pair.join('+')}` };
    const pending = await tools.create(w.runner, w.sessionId, { ...CREATE, ...own, timezone: 'UTC' } as never);
    const id = (pending as { card: { id: string } }).card.id;
    const before = await db.schedule.count({ where: { ownerId: w.ownerId } });
    const press = (verb: 'allow' | 'decline') =>
      verb === 'allow' ? rest.allow(w.user, id, {}, NO_SESSION) : rest.decline(w.user, id, NO_SESSION);
    const settled = await Promise.allSettled(pair.map(press));
    const won = settled.filter((r) => r.status === 'fulfilled');
    const lost = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(won.length, 1, `${pair.join('+')}: exactly one press wins`);
    assert.equal((lost[0].reason as { getResponse: () => { code: string } }).getResponse().code, 'SCHEDULE_REQUEST_DECIDED');
    const state = (await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id } })).state;
    const created = (await db.schedule.count({ where: { ownerId: w.ownerId } })) - before;
    assert.ok((state === 'ALLOWED' && created === 1) || (state === 'DECLINED' && created === 0), `${pair.join('+')}: ${state}, ${created} written`);
  }
});

test('Allow on a card whose schedule has ended, or whose envelope was narrowed since, applies nothing', { skip }, async () => {
  const w = await world('after-ask');
  const ended = await createdThroughCard(w);
  const widen = await tools.update(w.runner, w.sessionId, ended.id, { runLimitMinutes: 60 } as never);
  await rest.remove(w.user, ended.id, NO_SESSION);
  await refusedWith(rest.allow(w.user, (widen as { card: { id: string } }).card.id, {}, NO_SESSION), 'SCHEDULE_REQUEST_DECIDED');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: ended.id } })).runLimitMinutes, 30);

  const narrowed = await createdThroughCard(w, { accessLevel: 'CHECK_ONLY', runLimitMinutes: 60 });
  const ask = await tools.update(w.runner, w.sessionId, narrowed.id, { runLimitMinutes: 90 } as never);
  // The person narrows it after the ask: the envelope shrinks to 20 minutes.
  await tools.update(w.runner, w.sessionId, narrowed.id, { runLimitMinutes: 20 } as never);
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: narrowed.id } })).envelopeRunLimitMinutes, 20);
  await refusedWith(rest.allow(w.user, (ask as { card: { id: string } }).card.id, {}, NO_SESSION), 'SCHEDULE_REQUEST_STALE');
  const after = await db.schedule.findUniqueOrThrow({ where: { id: narrowed.id } });
  assert.equal(after.runLimitMinutes, 20);
  assert.equal(after.envelopeRunLimitMinutes, 20, 'not applied blind over the narrowing');
});

// -----------------------------------------------------------------------------------------------------------------
// The seam with S3 (schedule-attention.ts): a run's widen card is a Waiting on you item, closed by the owner's press
// -----------------------------------------------------------------------------------------------------------------

async function widenItem(scheduleChangeRequestId: string) {
  return db.ownerRequest.findFirst({ where: { kind: 'SCHEDULE_WIDEN', scheduleChangeRequestId } });
}

test('a run\'s widen through the tool is a Waiting on you item; Allow and Decline through the REST door leave it DONE', { skip }, async () => {
  const w = await world('seam-press');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  for (const verb of ['allow', 'decline'] as const) {
    const asked = await tools.update(w.runner, run.sessionId, s.id, { runLimitMinutes: verb === 'allow' ? 45 : 90 } as never);
    const card = (asked as { card: { id: string } }).card.id;
    const item = await widenItem(card);
    assert.ok(item, `${verb}: the run's widen is filed in Waiting on you`);
    assert.equal(item!.state, 'PENDING');
    assert.equal(item!.ownerId, w.ownerId);
    assert.equal(item!.scheduleId, s.id);
    if (verb === 'allow') await rest.allow(w.user, card, {}, NO_SESSION);
    else await rest.decline(w.user, card, NO_SESSION);
    assert.equal((await widenItem(card))!.state, 'DONE', `${verb}: the press closes the item`);
  }
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).runLimitMinutes, 45);
});

test('a widen card the press finds stale is superseded, and its Waiting on you item WITHDRAWN', { skip }, async () => {
  const w = await world('seam-stale');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  // REVISION_MOVED: the schedule changed inside its envelope after the ask.
  const moved = await tools.update(w.runner, run.sessionId, s.id, { runLimitMinutes: 60 } as never);
  const movedCard = (moved as { card: { id: string } }).card.id;
  await tools.update(w.runner, w.sessionId, s.id, { title: 'Renamed after the ask' } as never);
  await refusedWith(rest.allow(w.user, movedCard, {}, NO_SESSION), 'SCHEDULE_REQUEST_STALE');
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id: movedCard } })).state, 'SUPERSEDED');
  assert.equal((await widenItem(movedCard))!.state, 'WITHDRAWN');
  // WORKSPACE_GONE: the run asked to move to a workspace deleted since.
  const away = await tools.update(w.runner, run.sessionId, s.id, { workspaceId: w.otherWorkspaceId } as never);
  const awayCard = (away as { card: { id: string } }).card.id;
  assert.equal((await widenItem(awayCard))!.state, 'PENDING');
  await db.workspace.update({ where: { id: w.otherWorkspaceId }, data: { deletedAt: new Date() } });
  await refusedWith(rest.allow(w.user, awayCard, {}, NO_SESSION), 'SCHEDULE_REQUEST_STALE');
  assert.equal((await widenItem(awayCard))!.state, 'WITHDRAWN');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).workspaceId, w.workspaceId);
});

test('over the weekly budget: schedule_run_now from a session and a PAT\'s run are refused SCHEDULE_OVER_BUDGET; the owner\'s POST run starts; the run list says why', { skip }, async () => {
  const w = await world('budget');
  const s = await createdThroughCard(w);
  assert.equal(s.envelope.runsPerWeek, 7);
  // Seven Run now presses by sessions or tokens in the past 7 days: their budget is used (§8.4).
  const now = Date.now();
  for (let i = 1; i <= 7; i++) {
    const at = new Date(now - i * 60 * 60_000);
    // Delivered: only a run whose first turn reached its engine counts toward the budget (§4).
    const runId = randomUUID();
    await db.scheduleRun.create({
      data: { id: runId, scheduleId: s.id, scheduleRevision: 1, plannedAt: at, trigger: 'MANUAL', state: 'NO_CHANGE', startedAt: at, endedAt: at },
    });
    const sessionId = await makeSession(w.ownerId, w.workspaceId, PermissionMode.PLAN, null, { scheduleRunId: runId });
    await db.conversationTurn.create({
      data: { sessionId, seq: 1, clientTurnId: `initial-${sessionId}`, content: 'x', status: 'IN_FLIGHT', deliveredAt: at },
    });
  }
  // A slot the start found over budget, as the run list reads it.
  await db.scheduleRun.create({
    data: {
      scheduleId: s.id, scheduleRevision: 1, plannedAt: new Date(now - 60_000), trigger: 'SCHEDULED', state: 'MISSED',
      failureReason: 'OVER_BUDGET', endedAt: new Date(now - 60_000),
    },
  });
  const over = (await rest.listRuns(w.user, s.id)).runs.find((r) => r.failureReason === 'OVER_BUDGET')!;
  assert.equal(over.reasonText, SCHEDULE_COPY.runReasonTexts.OVER_BUDGET, 'the sentence the clients share');
  const got = await tools.get(w.runner, s.id);
  const seen = got.recentRuns.find((r) => r.failureReason === 'OVER_BUDGET')!;
  assert.equal(seen.reasonText, over.reasonText, 'schedule_get carries the reason too');
  const timeline = (await rest.list(w.user)) as unknown as { runs: Array<{ failureReason: string | null; reasonText: string | null }> };
  const onTimeline = timeline.runs.find((r) => r.failureReason === 'OVER_BUDGET')!;
  assert.equal(onTimeline.reasonText, over.reasonText, "the Scheduled page's timeline carries it too");

  const before = await db.scheduleRun.count({ where: { scheduleId: s.id } });
  await refusedWith(tools.runNow(w.runner, w.sessionId, s.id), 'SCHEDULE_OVER_BUDGET');
  await refusedWith(rest.runNow(w.user, s.id, acting(w.sessionId)), 'SCHEDULE_OVER_BUDGET');
  await refusedWith(rest.runNow(w.pat, s.id, NO_SESSION), 'SCHEDULE_OVER_BUDGET');
  assert.equal(await db.scheduleRun.count({ where: { scheduleId: s.id } }), before, 'a refused run now writes no run');

  const pressed = await rest.runNow(w.user, s.id, NO_SESSION);
  assert.equal(pressed.run.trigger, 'MANUAL');
  const started = await db.scheduleRun.findUniqueOrThrow({ where: { id: pressed.run.id } });
  assert.equal(started.state, 'RUNNING', "the owner's own press starts over budget");
  assert.equal(started.byOwner, true, 'and counts toward no budget');
});

// -----------------------------------------------------------------------------------------------------------------
// The Scheduled page's one read, and a run's session knowing its run (W2)
// -----------------------------------------------------------------------------------------------------------------

test('GET /api/schedules carries the timeline: runs under way and the last day\'s, their finding facts, when paused — the caller\'s rows only', { skip }, async () => {
  const a = await world('timeline-a');
  const b = await world('timeline-b');
  const sa = await createdThroughCard(a);
  const paused = await createdThroughCard(a, { title: 'Paused one', intent: 'Check the paused one every day' });
  await rest.pause(a.user, paused.id, NO_SESSION);
  const sb = await createdThroughCard(b);
  const hour = 60 * 60_000;
  const at = (ago: number) => new Date(Date.now() - ago);
  const mk = (scheduleId: string, ago: number, state: 'RUNNING' | 'CHANGED' | 'NO_CHANGE', key: string | null = null) =>
    db.scheduleRun.create({
      data: {
        scheduleId, scheduleRevision: 1, plannedAt: at(ago), trigger: 'SCHEDULED', state, startedAt: at(ago), key,
        endedAt: state === 'RUNNING' ? null : at(ago - 60_000),
      },
    });
  const running = await mk(sa.id, 2 * hour, 'RUNNING');
  const changed = await mk(sa.id, 3 * hour, 'CHANGED', 'codex@0.49.0');
  const old = await mk(sa.id, 30 * hour, 'NO_CHANGE');
  // One run in progress per schedule: the old one under way is the paused schedule's (a pause lets it finish).
  const oldRunning = await mk(paused.id, 50 * hour, 'RUNNING');
  await db.scheduleFinding.create({
    data: { scheduleId: sa.id, key: 'codex@0.49.0', firstRunId: changed.id, lastSeenRunId: changed.id, notifiedAt: new Date() },
  });
  const theirs = await mk(sb.id, hour, 'CHANGED');

  const answer = await rest.list(a.user) as unknown as {
    schedules: Array<{ id: string; pausedAt: string | null }>;
    runs: Array<{ id: string; scheduleId: string; newFinding: boolean; notified: boolean }>;
  };
  assert.deepEqual(answer.schedules.map((s) => s.id).sort(), [sa.id, paused.id].sort(), 'only the caller\'s schedules');
  const ids = answer.runs.map((r) => r.id);
  assert.ok(ids.includes(running.id) && ids.includes(changed.id), 'today\'s runs');
  assert.ok(ids.includes(oldRunning.id), 'a run under way, however old');
  assert.ok(!ids.includes(old.id), 'an ended run older than a day is not the page\'s');
  assert.ok(!ids.includes(theirs.id), 'no other account\'s run');
  assert.ok(answer.runs.every((r) => r.scheduleId === sa.id || r.scheduleId === paused.id), 'every run is of the caller\'s rows');
  const facts = answer.runs.find((r) => r.id === changed.id)!;
  assert.deepEqual([facts.newFinding, facts.notified], [true, true]);
  assert.deepEqual(
    [answer.runs.find((r) => r.id === running.id)!.newFinding, answer.runs.find((r) => r.id === running.id)!.notified],
    [false, false],
  );
  const pausedRow = answer.schedules.find((s) => s.id === paused.id)!;
  const pauseRecord = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: paused.id }, orderBy: { revision: 'desc' } });
  assert.equal(pausedRow.pausedAt, pauseRecord.createdAt.toISOString());
  assert.equal(answer.schedules.find((s) => s.id === sa.id)!.pausedAt, null);

  // The other account reads its own and nothing of the first's.
  const other = await rest.list(b.user) as unknown as typeof answer;
  assert.deepEqual(other.schedules.map((s) => s.id), [sb.id]);
  assert.deepEqual(other.runs.map((r) => r.id), [theirs.id]);
  // The runner door (a session's schedule_list) keeps its plain answer.
  assert.equal('runs' in (await tools.list(a.runner)), false);
});

test('a run\'s session\'s schedule-cards name its run however old; another session and another account get none', { skip }, async () => {
  const w = await world('run-of-session');
  const s = await createdThroughCard(w);
  const { sessionId, runId } = await runSession(w, s.id);
  // Older than the schedule's last 50 runs.
  await db.scheduleRun.update({ where: { id: runId }, data: { plannedAt: new Date('2025-06-02T02:00:00Z'), state: 'NO_CHANGE', endedAt: new Date('2025-06-02T02:03:00Z') } });
  for (let i = 0; i < 55; i += 1) {
    await db.scheduleRun.create({
      data: { scheduleId: s.id, scheduleRevision: 1, plannedAt: new Date(Date.now() - i * 60_000), trigger: 'MANUAL', state: 'NO_CHANGE', endedAt: new Date() },
    });
  }
  const cards = await rest.sessionCards(w.user, sessionId);
  assert.equal(cards.run?.id, runId);
  assert.equal(cards.run?.scheduleId, s.id);
  assert.equal((await rest.sessionCards(w.user, w.sessionId)).run, null, 'an ordinary session serves no run');
  const b = await world('run-of-session-b');
  await assert.rejects(rest.sessionCards(b.user, sessionId), /session not found/);
});

// -----------------------------------------------------------------------------------------------------------------
// Changing a schedule the session made (§8.1, §8.2, §9.2): no second card, the intent stays, the read-back follows
// -----------------------------------------------------------------------------------------------------------------

test('schedule_create for a schedule this session already created names it instead of raising a second card', { skip }, async () => {
  const w = await world('dup-create');
  const s = await createdThroughCard(w);
  const creates = () => db.scheduleChangeRequest.count({ where: { ownerId: w.ownerId, kind: 'CREATE' } });
  assert.equal(await creates(), 1);

  // "Make it weekly instead: Mondays at 09:00", filed as a create: same title, the correction as its intent.
  const again = await tools.create(w.runner, w.sessionId, {
    ...CREATE,
    intent: 'Make the check weekly instead: Mondays at 09:00',
    rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON'] },
    timezone: 'Asia/Shanghai',
  } as never);
  assert.equal(again.outcome, 'EXISTS');
  const exists = again as unknown as { scheduled: boolean; note: string; scheduleId: string; schedule: { id: string } };
  assert.equal(exists.scheduled, false);
  assert.equal(exists.scheduleId, s.id);
  assert.equal(exists.schedule.id, s.id);
  assert.match(exists.note, /^Not created: .*schedule_update/);
  assert.equal(await creates(), 1, 'no second create card');
  assert.equal(await db.scheduleChangeRequest.count({ where: { ownerId: w.ownerId, state: 'PENDING' } }), 0);

  // The same words under another title are the same schedule too.
  const sameIntent = await tools.create(w.runner, w.sessionId, { ...CREATE, title: 'Codex check (weekly)', timezone: 'UTC' } as never);
  assert.equal(sameIntent.outcome, 'EXISTS');
  assert.equal(await creates(), 1);

  // A different schedule from the same session, and the same one from another session, still get their card.
  const other = await tools.create(w.runner, w.sessionId, { ...CREATE, title: 'Kimi stable check', intent: 'Check Kimi every day', timezone: 'UTC' } as never);
  assert.equal(other.outcome, 'PENDING');
  const elsewhere = await makeSession(w.ownerId, w.workspaceId, PermissionMode.DEFAULT, w.runner.id);
  assert.equal((await tools.create(w.runner, elsewhere, { ...CREATE, timezone: 'UTC' } as never)).outcome, 'PENDING');

  // Once it has ended, asking again is a new schedule.
  await rest.remove(w.user, s.id, NO_SESSION);
  assert.equal((await tools.create(w.runner, w.sessionId, { ...CREATE, timezone: 'UTC' } as never)).outcome, 'PENDING');
});

test('schedule_update: a correction of the time does not overwrite what was asked; a restated goal does', { skip }, async () => {
  const w = await world('intent-kept');
  const s = await createdThroughCard(w);
  const weekly = await tools.update(w.runner, w.sessionId, s.id, {
    rule: { kind: 'WEEKLY', time: '09:00', weekdays: ['MON'] },
    intent: "That's more often than I need. Make it weekly instead: Mondays at 09:00.",
  } as never);
  assert.equal(weekly.outcome, 'APPLIED');
  const applied = weekly as unknown as { intentKept: boolean; note: string; record: { changed: string[] } };
  assert.equal(applied.intentKept, true);
  assert.match(applied.note, /intent\) was left as it was/);
  assert.deepEqual(applied.record.changed.filter((k) => k !== 'envelope'), ['rule', 'readBack']);
  let row = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual(row.rule, { kind: 'WEEKLY', time: '09:00', weekdays: ['MON'] });
  assert.equal(row.intent, CREATE.intent, 'what was asked is the original goal');

  // Inside what the weekly change left allowed (one run a week), so it applies at once too.
  const back = await tools.update(w.runner, w.sessionId, s.id, {
    rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['TUE'] },
    timezone: 'Asia/Shanghai',
    runLimitMinutes: 20,
    intent: 'On second thought, Monday is a bad day. Move it to Tuesdays at 10:00 Beijing time.',
  } as never);
  assert.equal(back.outcome, 'APPLIED');
  row = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.equal(row.intent, CREATE.intent);
  assert.equal((await rest.get(w.user, s.id)).schedule.intent, CREATE.intent, 'the inspector\'s What was asked');

  // A restated goal comes with what the runs now do, and is written.
  const restated = 'Watch the stable Kimi CLI instead, and tell me only when its version line changes';
  const goal = await tools.update(w.runner, w.sessionId, s.id, { intent: restated, prompt: 'Check the Kimi CLI release page.' } as never);
  assert.equal(goal.outcome, 'APPLIED');
  assert.equal((goal as { intentKept?: boolean }).intentKept, undefined);
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).intent, restated);
});

test('a timing change without readBack keeps what the check does and reads the current timing', { skip }, async () => {
  const w = await world('read-back');
  const at0900 = 'Every day at 09:00 Beijing time, check X and tell me only when Y changes.';
  const what = 'Check X and tell me only when Y changes.';
  const s = await createdThroughCard(w, {
    rule: { kind: 'DAILY', time: '09:00' }, readBack: at0900,
    prompt: `${what} Read watched.txt to find Y.`,
  });
  assert.equal((await rest.get(w.user, s.id)).readBack, at0900);

  // A rule change that brings no read-back: the read derives When from the rule as it is now.
  const moved = await tools.update(w.runner, w.sessionId, s.id, { rule: { kind: 'DAILY', time: '23:46' } } as never);
  assert.equal(moved.outcome, 'APPLIED');
  const derived = (await rest.get(w.user, s.id)).readBack;
  assert.match(derived, /^Every day at 23:46/);
  assert.ok(derived.includes(what), `the read-back lost what the check does: ${derived}`);
  assert.ok(!derived.includes('09:00'), `the read-back still names the old time: ${derived}`);
  assert.equal((moved as { readBack: string }).readBack, derived, 'the update answers with the same read-back');
  const movedRevision = (moved as { record: { revision: number } }).record.revision;

  // One the agent writes with the change is kept as the latest.
  const at2346 = 'Every day at 23:46 Beijing time I check X, and tell you only when Y changes.';
  const reworded = await tools.update(w.runner, w.sessionId, s.id, { readBack: at2346 } as never);
  assert.equal(reworded.outcome, 'APPLIED', 'a read-back alone is an undoable revision');
  const rewordedRevision = (reworded as { record: { revision: number } }).record.revision;
  const row = await db.scheduleRevision.findUniqueOrThrow({ where: { scheduleId_revision: { scheduleId: s.id, revision: rewordedRevision } } });
  assert.deepEqual(row.fields, { before: { readBack: null }, after: { readBack: at2346 } });
  assert.equal((reworded as { readBack: string }).readBack, at2346);
  assert.equal((await rest.undo(w.user, s.id, { revision: rewordedRevision }, NO_SESSION)).outcome, 'APPLIED');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).readBack, null);
  await tools.update(w.runner, w.sessionId, s.id, { readBack: at2346 });
  assert.equal((await rest.get(w.user, s.id)).readBack, at2346);

  // A timezone-only change also keeps what the check does.
  await tools.update(w.runner, w.sessionId, s.id, { timezone: 'Europe/London' } as never);
  const rezoned = (await rest.get(w.user, s.id)).readBack;
  assert.equal(rezoned, `Every day at 23:46 · Europe/London · ${what}`);

  const weekly = 'Every Monday at 08:00 London time I check X, and tell you only when Y changes.';
  await tools.update(w.runner, w.sessionId, s.id, { rule: { kind: 'WEEKLY', time: '08:00', weekdays: ['MON'] }, readBack: weekly } as never);
  assert.equal((await rest.get(w.user, s.id)).readBack, weekly);
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).readBack, weekly);
  await refusedWith(tools.update(w.runner, w.sessionId, s.id, { readBack: 'x'.repeat(501) } as never), 'SCHEDULE_FIELD_INVALID');

  // Undo moves the rule back, and the read-back moves with it.
  const latest = await db.scheduleRevision.findFirstOrThrow({ where: { scheduleId: s.id }, orderBy: { revision: 'desc' } });
  assert.ok(latest.revision > movedRevision);
  assert.equal((await rest.undo(w.user, s.id, { revision: latest.revision }, NO_SESSION)).outcome, 'APPLIED');
  assert.equal((await rest.get(w.user, s.id)).readBack, rezoned);
});

// -----------------------------------------------------------------------------------------------------------------
// Rename (§8.4, owner 2026-11-26): the one REST door that changes a schedule, and the title alone
// -----------------------------------------------------------------------------------------------------------------

const revisionsOf = (scheduleId: string) => db.scheduleRevision.findMany({ where: { scheduleId }, orderBy: { revision: 'asc' } });

test('rename writes a USER revision of the title alone, and the list and the schedule read the new one', { skip }, async () => {
  const w = await world('rename');
  const s = await createdThroughCard(w);
  const answer = await rest.rename(w.user, s.id, { title: '  Codex releases  ' }, NO_SESSION);
  assert.equal(answer.outcome, 'APPLIED');
  const applied = answer as unknown as {
    schedule: { title: string };
    record: { revision: number; changedBy: string; before: unknown; after: unknown; undo: unknown };
  };
  assert.equal(applied.schedule.title, 'Codex releases', 'trimmed');
  assert.equal(applied.record.changedBy, 'USER');
  assert.ok(applied.record.undo, 'the record offers Undo');
  const revision = (await revisionsOf(s.id)).at(-1)!;
  assert.equal(revision.revision, 2);
  assert.equal(revision.changedBy, 'USER');
  assert.equal(revision.sessionId, null);
  assert.deepEqual(revision.fields, { before: { title: CREATE.title }, after: { title: 'Codex releases' } });
  assert.equal((await rest.get(w.user, s.id)).schedule.title, 'Codex releases');
  assert.equal((await rest.list(w.user)).schedules.find((row) => row.id === s.id)!.title, 'Codex releases');
  // Nothing waits on a card, and nothing else of the schedule moved.
  assert.equal(await db.scheduleChangeRequest.count({ where: { scheduleId: s.id, kind: 'UPDATE' } }), 0);
  const row = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual(
    [row.intent, row.prompt, row.readBack, row.nextDueAt?.toISOString()],
    [CREATE.intent, CREATE.prompt, CREATE.readBack, s.nextDueAt],
  );
});

test('rename: the same text after trimming writes nothing, and an empty one is refused', { skip }, async () => {
  const w = await world('rename-same');
  const s = await createdThroughCard(w);
  const answer = await rest.rename(w.user, s.id, { title: `  ${CREATE.title} ` }, NO_SESSION);
  assert.equal(answer.outcome, 'UNCHANGED');
  assert.equal(answer.changed, false);
  await refusedWith(rest.rename(w.user, s.id, { title: '   ' }, NO_SESSION), 'SCHEDULE_FIELD_INVALID');
  assert.equal((await revisionsOf(s.id)).length, 1);
});

test('rename is refused once the schedule has ENDED', { skip }, async () => {
  const w = await world('rename-ended');
  const s = await createdThroughCard(w);
  await rest.remove(w.user, s.id, NO_SESSION);
  await refusedWith(rest.rename(w.user, s.id, { title: 'Codex releases' }, NO_SESSION), 'SCHEDULE_ENDED');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).title, CREATE.title);
  assert.equal((await revisionsOf(s.id)).length, 2);
});

test('Undo restores the old title, and a later schedule_update from a session still applies: no hold', { skip }, async () => {
  const w = await world('rename-undo');
  const s = await createdThroughCard(w);
  await rest.rename(w.user, s.id, { title: 'Codex releases' }, NO_SESSION);
  assert.equal((await rest.undo(w.user, s.id, { revision: 2 }, NO_SESSION)).outcome, 'APPLIED');
  assert.equal((await rest.get(w.user, s.id)).schedule.title, CREATE.title);
  await rest.rename(w.user, s.id, { title: 'My Codex watch' }, NO_SESSION);
  const byAgent = await tools.update(w.runner, w.sessionId, s.id, { title: 'Codex stable releases' } as never);
  assert.equal(byAgent.outcome, 'APPLIED');
  assert.equal((await rest.get(w.user, s.id)).schedule.title, 'Codex stable releases');
  const last = (await revisionsOf(s.id)).at(-1)!;
  assert.equal(last.changedBy, 'SESSION');
  assert.deepEqual(last.fields, { before: { title: 'My Codex watch' }, after: { title: 'Codex stable releases' } });
});

test('rename: a token is the person; allowed paused, held and while a run is under way, leaving a due slot due', { skip }, async () => {
  const w = await world('rename-states');
  const s = await createdThroughCard(w);
  const run = await runSession(w, s.id);
  // A slot that has come round and not been taken yet: a new name must not move the schedule past it.
  const due = new Date(Date.now() - 60_000);
  await db.schedule.update({ where: { id: s.id }, data: { nextDueAt: due } });
  assert.equal((await rest.rename(w.pat, s.id, { title: 'While running' }, NO_SESSION)).outcome, 'APPLIED');
  assert.equal((await revisionsOf(s.id)).at(-1)!.changedBy, 'USER');
  assert.equal((await db.schedule.findUniqueOrThrow({ where: { id: s.id } })).nextDueAt?.toISOString(), due.toISOString());
  const underWay = await db.scheduleRun.findUniqueOrThrow({ where: { id: run.runId } });
  assert.deepEqual([underWay.state, underWay.scheduleRevision], ['RUNNING', 1], 'the run keeps its revision');
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: run.sessionId } })).title, 'chat');

  await rest.pause(w.user, s.id, NO_SESSION);
  assert.equal((await rest.rename(w.user, s.id, { title: 'While paused' }, NO_SESSION)).outcome, 'APPLIED');
  await db.schedule.update({ where: { id: s.id }, data: { state: 'HELD', heldReason: 'AGENT_DISABLED' } });
  assert.equal((await rest.rename(w.user, s.id, { title: 'While held' }, NO_SESSION)).outcome, 'APPLIED');
  const row = await db.schedule.findUniqueOrThrow({ where: { id: s.id } });
  assert.deepEqual([row.title, row.state, row.heldReason, row.nextDueAt], ['While held', 'HELD', 'AGENT_DISABLED', null]);
});
