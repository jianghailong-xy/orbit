/**
 * Who hears about a run and where a run's session is seen (docs/scheduled-tasks-design.md §6.4, §7.3, §7.4, §12.1),
 * against a real PostgreSQL migrated from empty, on a clock the spec moves:
 *
 *   * §7.3: every row of the table — what is pushed, where a tap goes, and which Waiting on you item is written;
 *     a creation baseline is not news, and neither is the first run reporting the same key;
 *   * Waiting on you: the four SCHEDULE_* items (failed, held, a run's approval, a run's widen) filed and closed;
 *   * §6.4: Always allow on a run's card writes the workspace rule the next run's session is dispatched with;
 *   * §6.2 (S2e): through the runner's approval door, a CHECK_ONLY run on Claude Code asks only about a shell command;
 *     anything else it asks about is DENIED at once with no card, item or push, and its next claim carries only the
 *     workspace's Bash rules;
 *   * §7.4 / §12.1: run sessions are in none of the session queries, the run still names its session, and a run
 *     whose session was trashed or purged is kept and says so.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/schedules/schedule-attention.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { PermissionMode } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import { firstValueFrom, take, timeout, toArray } from 'rxjs';

import { ALWAYS_ALLOWED_TOOLS } from '../common/permission-mode';
import { dispatchAllowedTools } from '../common/permission-rules';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { readOwnerDecisionsBySession } from '../projects/owner-decision-signal';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { factsSql, wikiSessionsOfSpace } from '../wiki/wiki-maintenance';
import { lastActiveByWorkspace, workspaceSessionCount } from '../workspaces/workspace-usage';
import {
  CHECK_ONLY_CLAUDE_ALLOWED_TOOLS,
  CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS,
  CHECK_ONLY_REFUSED_MESSAGE,
  runAccessLevel,
  SCHEDULE_CHECK_ONLY_RULE_REFUSED,
  scheduleRunAgentFields,
  scheduleRunAllowedTools,
  scheduleRunDisallowedTools,
  scheduleRunPermissionMode,
} from './schedule-access';
import type { ScheduleAlert, ScheduleNotifier } from './schedule-attention';
import { SessionsScheduleRunPort } from './schedule-run-sessions';
import { SCHEDULE_IDLE_SETTLE_MS, ScheduleRunsService, type ScheduleRunSessionPort } from './schedule-runs.service';
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
let sessionsService: SessionsService;
let schedules: SchedulesService;
let runs: ScheduleRunsService;
let ownerRequests: OwnerRequestsService;
let realtime: RealtimeService;
let alerts: ScheduleAlert[] = [];

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
  const quiet = new Proxy({}, { get: () => () => undefined });
  sessionsService = new SessionsService(db as never, quiet as never, quiet as never);
  const real = new SessionsScheduleRunPort(sessionsService);
  const port: ScheduleRunSessionPort = {
    land: (owner, sessionId) => real.land(owner, sessionId),
    open: (input) => real.open(input),
    interrupt: async () => undefined,
    complete: async (_owner, sessionId) => {
      await db.session.update({ where: { id: sessionId }, data: { completedAt: clockNow } });
    },
    end: (owner, sessionId) => real.end(owner, sessionId),
  };
  const notifier: ScheduleNotifier = { notify: async (alert) => void alerts.push(alert) };
  schedules = new SchedulesService(db as unknown as PrismaService, clock, notifier);
  runs = new ScheduleRunsService(db as unknown as PrismaService, port, clock, notifier);
  ownerRequests = new OwnerRequestsService(db as unknown as PrismaService, quiet as never);
  realtime = new RealtimeService(db as unknown as PrismaService, { scheduleBadgeSync: () => undefined } as never);
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

async function world(label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@schedule-attention.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: FUTURE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, repoUrl: 'https://github.com/example/repo.git' },
  });
  return { ownerId, runnerId, workspaceId, owner: { kind: 'OWNER', ownerId } };
}

function input(over: Partial<ScheduleCreateInput> = {}): ScheduleCreateInput {
  return {
    intent: 'Check the latest stable Codex every day at 10:00 Beijing time and tell me only when there is a new one',
    title: 'Codex stable check',
    prompt: 'Check the latest stable Codex release against the pinned version.',
    rule: { kind: 'DAILY', time: '10:00' },
    timezone: 'Asia/Shanghai',
    accessLevel: 'CHECK_ONLY',
    ...over,
  };
}

/** A person's conversation in the workspace: where a schedule is created from, and what the lists must show. */
async function conversation(w: World, title = 'A conversation', engine?: string): Promise<string> {
  const id = randomUUID();
  await sessionsService.create(w.ownerId, { workspaceId: w.workspaceId, title, prompt: 'hello', ...(engine ? { engine, provider: engine } : {}) }, { id });
  return id;
}

/** The way a schedule is born in v1: a session's create card, pressed Create by the owner. */
async function created(w: World, over: Partial<ScheduleCreateInput> = {}, engine?: string) {
  const from = await conversation(w, `Origin ${randomUUID().slice(0, 4)}`, engine);
  const asked = await schedules.create({ kind: 'SESSION', ownerId: w.ownerId, sessionId: from }, input(over));
  assert.equal(asked.outcome, 'PENDING');
  const decided = await schedules.decide(w.owner, (asked as { request: { id: string } }).request.id, 'ALLOW');
  return { schedule: decided.schedule!, from };
}

async function scheduleOf(id: string) {
  return db.schedule.findUniqueOrThrow({ where: { id } });
}

async function runOf(id: string) {
  return db.scheduleRun.findUniqueOrThrow({ where: { id } });
}

async function delivered(sessionId: string, deliveredAt: Date) {
  await db.conversationTurn.upsert({
    where: { sessionId_clientTurnId: { sessionId, clientTurnId: `initial-${sessionId}` } },
    create: { sessionId, seq: 1, clientTurnId: `initial-${sessionId}`, content: 'x', status: 'IN_FLIGHT', deliveredAt },
    update: { deliveredAt },
  });
}

/** Fire the schedule's next slot and start it, its first turn delivered. */
async function nextRun(scheduleId: string) {
  const s = await scheduleOf(scheduleId);
  at(s.nextDueAt!.toISOString());
  assert.equal(await runs.fire(scheduleId), 'FIRED');
  const started = await runs.startDue(25, scheduleId);
  assert.equal(started[0]?.outcome, 'STARTED', 'the run starts');
  const run = await runOf(started[0].runId);
  await delivered(run.sessionId!, clockNow);
  return { run, sessionId: run.sessionId! };
}

async function report(w: World, sessionId: string, r: Parameters<ScheduleRunsService['report']>[2]) {
  return runs.report(w.ownerId, sessionId, r);
}

async function items(scheduleId: string) {
  return db.ownerRequest.findMany({ where: { scheduleId }, orderBy: { createdAt: 'asc' } });
}

async function pendingItems(scheduleId: string) {
  return db.ownerRequest.findMany({ where: { scheduleId, state: 'PENDING' }, orderBy: { createdAt: 'asc' } });
}

function alertsOf(scheduleId: string): ScheduleAlert[] {
  return alerts.filter((a) => a.scheduleId === scheduleId);
}

async function pendingCard(sessionId: string, toolName = 'Bash', command = 'curl -s https://api.github.com/repos/openai/codex/releases/latest') {
  return db.approval.create({
    data: { sessionId, toolName, input: { command }, status: 'PENDING', createdAt: clockNow },
  });
}

// =============================================================================================================
// §7.3 — each row of the table
// =============================================================================================================

test('§8.1/§7.3 creating with a baseline tells nobody, and the first run reporting the same key is not news', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('baseline');
  const { schedule } = await created(w, { baseline: { key: 'codex@0.48.0', summary: 'Codex 0.48.0, same as pinned.' } });
  assert.deepEqual(alertsOf(schedule.id), [], 'the create card\'s Create pushes nothing');
  const baseline = await db.scheduleFinding.findUniqueOrThrow({ where: { scheduleId_key: { scheduleId: schedule.id, key: 'codex@0.48.0' } } });
  assert.ok(baseline.notifiedAt, 'the baseline is recorded as already told');

  const { run, sessionId } = await nextRun(schedule.id);
  const result = await report(w, sessionId, { outcome: 'CHANGED', key: 'codex@0.48.0', summary: 'Codex 0.48.0 is out.', links: ['https://x/1'] });
  assert.equal(result.newFinding, false);
  assert.deepEqual(alertsOf(schedule.id), [], 'the first run naming the baseline\'s key notifies nobody');
  const after = await db.scheduleFinding.findUniqueOrThrow({ where: { id: baseline.id } });
  assert.equal(after.lastSeenRunId, run.id, 'lastSeenRunId moves');
  assert.equal(after.notifiedAt!.toISOString(), baseline.notifiedAt!.toISOString(), 'notifiedAt is the baseline\'s');
  assert.deepEqual(after.links, ['https://x/1']);
  assert.deepEqual(await items(schedule.id), [], 'and nothing waits on the owner');
});

test('§7.3 NO_CHANGE notifies nobody, files nothing and its session is completed', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('no-change');
  const { schedule } = await created(w);
  const { sessionId } = await nextRun(schedule.id);
  await db.session.update({ where: { id: sessionId }, data: { turnState: null } });
  await report(w, sessionId, { outcome: 'NO_CHANGE', summary: 'Still 0.48.0.' });
  assert.deepEqual(alertsOf(schedule.id), []);
  assert.deepEqual(await items(schedule.id), []);
  // §7.4: the worker's pass completes it, once nothing works in it.
  assert.ok((await runs.completeNoChangeSessions(1000)).includes(sessionId), 'the pass completes the run\'s session');
  assert.ok((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).completedAt, 'the session is completed');
});

test('§7.3 CHANGED with a new key: one push that opens the run\'s session, notifiedAt set; the known key again: no push, links merge', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('changed');
  const { schedule } = await created(w);
  const first = await nextRun(schedule.id);
  await report(w, first.sessionId, { outcome: 'CHANGED', key: 'codex@0.49.0', summary: 'Codex 0.49.0 is out.', links: ['https://a'] });
  const pushed = alertsOf(schedule.id);
  assert.equal(pushed.length, 1, 'once');
  assert.equal(pushed[0].kind, 'FINDING');
  assert.deepEqual(pushed[0].opens, { sessionId: first.sessionId }, 'the tap opens the run\'s session');
  assert.equal(pushed[0].ownerRequestId, null, 'a finding is news, not something waiting on the owner');
  assert.match(pushed[0].body, /0\.49\.0/);
  const finding = await db.scheduleFinding.findUniqueOrThrow({ where: { scheduleId_key: { scheduleId: schedule.id, key: 'codex@0.49.0' } } });
  assert.ok(finding.notifiedAt, 'notifiedAt is set');
  const session = await db.session.findUniqueOrThrow({ where: { id: first.sessionId } });
  assert.equal(session.completedAt, null, 'a CHANGED run\'s session stays open');

  const second = await nextRun(schedule.id);
  await report(w, second.sessionId, { outcome: 'CHANGED', key: 'codex@0.49.0', summary: 'Still 0.49.0.', links: ['https://a', 'https://b'] });
  assert.equal(alertsOf(schedule.id).length, 1, 'a known key is not pushed again');
  const again = await db.scheduleFinding.findUniqueOrThrow({ where: { id: finding.id } });
  assert.equal(again.lastSeenRunId, second.run.id);
  assert.deepEqual(again.links, ['https://a', 'https://b'], 'links merge');
  assert.equal(again.notifiedAt!.toISOString(), finding.notifiedAt!.toISOString());
  assert.deepEqual(await items(schedule.id), []);
});

test('§7.3 FAILED: push and Waiting on you; the third in a row says "failed 3 runs in a row"; one item at a time; a success closes it', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('failed');
  const { schedule } = await created(w);

  const one = await nextRun(schedule.id);
  await report(w, one.sessionId, { outcome: 'FAILED', summary: 'The releases page returned 503.' });
  let pending = await pendingItems(schedule.id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'SCHEDULE_FAILED');
  assert.equal(pending[0].scheduleRunId, one.run.id);
  assert.equal(pending[0].askedBySessionId, one.sessionId, 'shown with the run\'s session');
  let pushed = alertsOf(schedule.id);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].kind, 'FAILED');
  assert.equal(pushed[0].ownerRequestId, pending[0].id, 'the push announces the item');
  assert.deepEqual(pushed[0].opens, { sessionId: one.sessionId });
  assert.doesNotMatch(pushed[0].title, /in a row/);
  assert.equal(
    pushed[0].body,
    'The last run reported a failure: The releases page returned 503. It keeps running until you pause it.',
    'the push says what the run reported',
  );
  assert.match(pending[0].why, /^The last run reported a failure: The releases page returned 503 \(Nov \d+, \d\d:\d\d\)\. /);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: one.sessionId } })).completedAt, null, 'a FAILED run\'s session stays open');

  // The second fails without a report (its turn settled idle), the third past its limit.
  const two = await nextRun(schedule.id);
  await db.conversationTurn.updateMany({ where: { sessionId: two.sessionId }, data: { status: 'ANSWERED' } });
  await db.session.update({ where: { id: two.sessionId }, data: { turnState: null } });
  // §7.1: idle fails the run only once it has read so for the settle time.
  assert.equal(await runs.reconcileRun(two.run.id), 'UNCHANGED', 'idle is not settled at once');
  advance(SCHEDULE_IDLE_SETTLE_MS);
  assert.equal(await runs.reconcileRun(two.run.id), 'FAILED');
  assert.equal((await runOf(two.run.id)).failureReason, 'NO_REPORT');
  const three = await nextRun(schedule.id);
  advance(31 * MINUTE);
  assert.equal(await runs.reconcileRun(three.run.id), 'FAILED');
  assert.equal((await runOf(three.run.id)).failureReason, 'RUN_LIMIT');

  pushed = alertsOf(schedule.id);
  assert.deepEqual(pushed.map((a) => a.kind), ['FAILED', 'FAILED', 'FAILED']);
  assert.match(pushed[2].title, / failed 3 runs in a row$/);
  assert.equal(pushed[2].body, 'The last run ran past its run limit. It keeps running until you pause it.');
  pending = await pendingItems(schedule.id);
  assert.equal(pending.length, 1, 'one failure item at a time: the newest');
  assert.equal(pending[0].scheduleRunId, three.run.id);
  assert.match(pending[0].title, / failed 3 runs in a row$/);
  assert.match(pending[0].why, /^The last run ran past its run limit \(Nov \d+, \d\d:\d\d\)\. It keeps running on schedule until you pause it\./);
  assert.equal((await scheduleOf(schedule.id)).state, 'ACTIVE', 'failures never pause the schedule');

  const four = await nextRun(schedule.id);
  await report(w, four.sessionId, { outcome: 'NO_CHANGE', summary: 'Back to normal.' });
  assert.deepEqual(await pendingItems(schedule.id), [], 'a run that succeeds closes the failure');
  const closed = await db.ownerRequest.findUniqueOrThrow({ where: { id: pending[0].id } });
  assert.equal(closed.state, 'WITHDRAWN');
  assert.equal(alertsOf(schedule.id).length, 3, 'and is not itself news');
});

test('§7.3 HELD: push opens the schedule and Waiting on you holds it until the schedule is resumed', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('held');
  const { schedule, from } = await created(w);
  await db.workspace.update({ where: { id: w.workspaceId }, data: { enabled: false } });
  const s = await scheduleOf(schedule.id);
  at(s.nextDueAt!.toISOString());
  await runs.fire(schedule.id);
  const started = await runs.startDue(25, schedule.id);
  assert.equal(started[0].outcome, 'HELD');
  const pushed = alertsOf(schedule.id);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].kind, 'HELD');
  assert.deepEqual(pushed[0].opens, { scheduleId: schedule.id }, 'a hold has no session: the tap opens the schedule');
  const [held] = await pendingItems(schedule.id);
  assert.equal(held.kind, 'SCHEDULE_HELD');
  assert.equal(pushed[0].ownerRequestId, held.id);
  assert.equal(held.askedBySessionId, from, 'shown with the conversation the schedule came from');
  assert.match(held.title, / is held$/);
  assert.match(held.why, /^It could not start on .+: the workspace .+ is disabled\. Nothing runs until it is enabled and you resume\.$/);
  assert.equal(pushed[0].body, held.why, 'the push says what the item says');

  // A replay of the start (the held run, or another pass) files nothing more.
  await runs.startDue(25, schedule.id);
  assert.equal((await items(schedule.id)).length, 1);

  await assert.rejects(schedules.resume(w.owner, schedule.id));
  await assert.rejects(ownerRequests.decline(w.ownerId, held.id, 'ignore it'), 'a hold is ended by resuming, not by declining its item');
  assert.equal((await pendingItems(schedule.id)).length, 1, 'still held: the item stays');
  await db.workspace.update({ where: { id: w.workspaceId }, data: { enabled: true } });
  await schedules.resume(w.owner, schedule.id);
  assert.deepEqual(await pendingItems(schedule.id), [], 'resumed: the item closes');
  assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: held.id } })).state, 'WITHDRAWN');
});

test('§6.4/§7.3 AWAITING_APPROVAL: push and an item that says what Always allow writes; answering closes it, and the next run carries the rule', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('approval');
  const { schedule } = await created(w);
  const { run, sessionId } = await nextRun(schedule.id);
  advance(MINUTE);
  const card = await pendingCard(sessionId);
  assert.equal(await runs.reconcileRun(run.id), 'AWAITING_APPROVAL');
  const [item] = await pendingItems(schedule.id);
  assert.equal(item.kind, 'SCHEDULE_APPROVAL');
  assert.equal(item.approvalId, card.id);
  assert.equal(item.scheduleRunId, run.id);
  assert.equal(item.askedBySessionId, sessionId);
  assert.match(item.title, / wants to run a command$/);
  assert.match(item.why, /^If nobody answers by \d\d:\d\d this run fails; the next one starts .+\./);
  assert.match(item.why, / in .+: later runs won't ask for this\.$/, 'it says what Always allow covers');
  const pushed = alertsOf(schedule.id);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].kind, 'AWAITING_APPROVAL');
  assert.deepEqual(pushed[0].opens, { sessionId });
  assert.equal(pushed[0].ownerRequestId, item.id);
  await runs.reconcileRun(run.id);
  assert.equal(alertsOf(schedule.id).length, 1, 'the next pass does not ring again');
  // Waiting on you cannot end it in place of the card: done and declined are both refused, and the item still waits.
  await assert.rejects(ownerRequests.complete(w.ownerId, item.id, {}));
  await assert.rejects(ownerRequests.decline(w.ownerId, item.id, 'not now'));
  assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: item.id } })).state, 'PENDING');

  // Needs you counts the run once: the badge's sessions hold it once, and its row counts the card, not the card and its item.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.update({ where: { id: sessionId }, data: { turnState: 'IN_FLIGHT' } });
  });
  const badges = new PushService(db as unknown as PrismaService, { get: () => undefined } as never);
  const needing = await badges.needsYouSessions(w.ownerId);
  assert.equal(needing.filter((id) => id === sessionId).length, 1, 'the badge counts the run once');
  const decisions = await readOwnerDecisionsBySession(db as never, w.ownerId, { sessionIds: [sessionId] });
  assert.equal(decisions.get(sessionId)?.count ?? 0, 0, 'its SCHEDULE_APPROVAL item is not a second count beside the card');
  const waiting = (await ownerRequests.list(w.ownerId, 'open')).requests.filter((r) => r.scheduleRunId === run.id);
  assert.equal(waiting.length, 1, 'and Waiting on you shows it once');

  // The owner answers the card itself with Always allow: the workspace rule, as in any session.
  await sessionsService.decideApproval(w.ownerId, sessionId, card.id, {
    behavior: 'allow',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'curl:*' }],
  });
  assert.equal(await runs.reconcileRun(run.id), 'RUNNING');
  assert.ok(!(await badges.needsYouSessions(w.ownerId)).includes(sessionId), 'answered: the badge lets it go');
  const answered = await db.ownerRequest.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(answered.state, 'DONE', 'the card was answered');
  await report(w, sessionId, { outcome: 'NO_CHANGE', summary: 'Same.' });

  const next = await nextRun(schedule.id);
  const dispatched = await db.session.findUniqueOrThrow({
    where: { id: next.sessionId },
    include: { workspace: { include: { permissionRules: { orderBy: { createdAt: 'asc' } } } } },
  });
  assert.equal(dispatched.workspaceId, w.workspaceId, 'the next run is a session of the same workspace');
  const allowed = dispatchAllowedTools(dispatched.provider ?? 'claude', ALWAYS_ALLOWED_TOOLS, dispatched.workspace!.permissionRules);
  const [rule] = dispatched.workspace!.permissionRules;
  assert.equal(rule.ruleContent, card.input && (card.input as { command: string }).command);
  assert.equal(rule.fromScheduleRun, true);
  assert.ok(!allowed.includes('Bash(curl:*)'), 'scheduled grants are matched literally at the approval door');
});

/** The runner's approval door with spies where a card is announced: the session's stream and the push. */
function approvalDoor() {
  const published: Array<{ sessionId: string; type: string }> = [];
  const pushed: Array<{ sessionId: string; toolName: string }> = [];
  const realtimeSpy = new Proxy({}, {
    get: (_t, key) => key === 'publish'
      ? (sessionId: string, event: { type: string }) => void published.push({ sessionId, type: event.type })
      : () => undefined,
  });
  const pushSpy = new Proxy({}, {
    get: (_t, key) => key === 'notifyApprovalRequest'
      ? async (sessionId: string, _approvalId: string, toolName: string) => void pushed.push({ sessionId, toolName })
      : () => undefined,
  });
  const inert = new Proxy({}, { get: () => () => undefined });
  const controller = new RunnerApiController(
    db as unknown as PrismaService, inert as never, realtimeSpy as never, pushSpy as never, inert as never, inert as never,
  );
  return { controller, published, pushed };
}

/** The run's session as a runner holds it: assigned to the world's runner, on Claude Code. */
async function heldByRunner(w: World, sessionId: string, engine = 'claude') {
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.session.update({ where: { id: sessionId }, data: { assignedRunnerId: w.runnerId, engine, provider: engine } });
  });
}

test('§6.2 S2e: a CHECK_ONLY run on Claude Code asks only about a shell command; Always allow remembers the exact command across runs', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('s2e-check-only');
  const { schedule } = await created(w);
  const { run, sessionId } = await nextRun(schedule.id);
  assert.equal((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).permissionMode, PermissionMode.AUTO,
    'CHECK_ONLY on Claude Code is opened in Auto, the mode its claim hands the runner (schedule-access.ts)');
  await heldByRunner(w, sessionId);
  const door = approvalDoor();
  const ask = (toolName: string, input: Record<string, unknown>, extra: Record<string, string> = {}) =>
    door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, sessionId,
      { toolName, input, toolUseId: `tu-${randomUUID()}`, ...extra } as never);
  advance(MINUTE);

  // A shell command: the ordinary card, announced and pushed, and the run's Waiting on you item.
  const command = `python3 -c "print(open('watched.txt').read())"`;
  const bash = await ask('Bash', { command });
  assert.equal(bash.status, 'PENDING');
  assert.deepEqual(door.published.map((p) => p.type), ['approval_request']);
  assert.deepEqual(door.pushed, [{ sessionId, toolName: 'Bash' }]);
  assert.equal(await runs.reconcileRun(run.id), 'AWAITING_APPROVAL');
  const [item] = await pendingItems(schedule.id);
  assert.equal(item.kind, 'SCHEDULE_APPROVAL');
  assert.equal(item.approvalId, bash.id);
  assert.ok(item.why.includes(command), 'the card says the exact command');
  assert.ok(!item.why.includes('python3:*'));
  const [shown] = await sessionsService.listApprovals(w.ownerId, sessionId);
  assert.equal((shown.input as { orbitScheduleCheckOnly?: boolean }).orbitScheduleCheckOnly, true);
  assert.match(item.why, / in .+: later runs won't ask for this\.$/, 'the item says Always allow is a workspace rule');
  assert.equal(alertsOf(schedule.id).filter((a) => a.kind === 'AWAITING_APPROVAL').length, 1);

  // Anything else: DENIED at once, with the refusal the engine reads; no card, no item, no push.
  for (const [toolName, input, extra] of [
    ['Edit', { file_path: 'README.md', old_string: 'hello', new_string: 'x' }, {}],
    ['Write', { file_path: 'x.txt', content: 'x' }, {}],
    ['mcp__orbit__bg_run', { command: 'touch x', kind: 'job' }, {}],
    ['mcp__orbit__task_update', { taskId: 'x', title: 'y' }, {}],
    ['mcp__docs__write', { page: 'x' }, {}],
    ['AskUserQuestion', { questions: [{ question: 'Go on?', options: [{ label: 'Yes' }] }] }, {}],
    ['Bash', { command: 'touch x' }, { backgroundJobId: 'bgj_s2e' }],
  ] as const) {
    const refused = await ask(toolName, input, extra);
    assert.equal(refused.status, 'DENIED', toolName);
    const row = await db.approval.findUniqueOrThrow({ where: { id: refused.id } });
    assert.equal(row.message, CHECK_ONLY_REFUSED_MESSAGE, toolName);
    assert.equal(row.decidedById, null, `${toolName}: nobody decided it`);
    assert.ok(row.decidedAt, toolName);
  }
  assert.equal(door.published.length, 1, 'no card was announced for any of them');
  assert.equal(door.pushed.length, 1, 'and no push');
  assert.equal(await runs.reconcileRun(run.id), 'UNCHANGED', 'still waiting on the shell command\'s card only');
  assert.deepEqual((await pendingItems(schedule.id)).map((i) => i.approvalId), [bash.id], 'no item for any of them');
  assert.equal(alertsOf(schedule.id).filter((a) => a.kind === 'AWAITING_APPROVAL').length, 1);

  // The workspace already holds rules a person's interactive sessions wrote, and rules for other tools.
  await db.workspacePermissionRule.createMany({
    data: [
      { workspaceId: w.workspaceId, toolName: 'Edit', ruleContent: '' },
      { workspaceId: w.workspaceId, toolName: 'mcp__orbit__bg_run', ruleContent: '' },
      { workspaceId: w.workspaceId, toolName: 'Bash', ruleContent: '' },
      { workspaceId: w.workspaceId, toolName: 'Bash', ruleContent: 'python:*' },
      { workspaceId: w.workspaceId, toolName: 'Bash', ruleContent: 'python3:*', fromScheduleRun: true },
    ],
  });
  // H5: Always allow on this card writes only this card's command's rule. Anything else is refused by name, and the
  // card is not decided.
  for (const rule of [
    { toolName: 'Bash', ruleContent: 'python:*' },
    { toolName: 'Bash', ruleContent: '' },
    { toolName: 'Edit', ruleContent: '' },
    { toolName: 'mcp__orbit__bg_run', ruleContent: '' },
  ]) {
    await assert.rejects(
      sessionsService.decideApproval(w.ownerId, sessionId, bash.id, { behavior: 'allow', rememberRules: [rule] }),
      (e: { getResponse?: () => { code?: string } }) => e.getResponse?.().code === SCHEDULE_CHECK_ONLY_RULE_REFUSED,
      JSON.stringify(rule),
    );
  }
  assert.equal((await db.approval.findUniqueOrThrow({ where: { id: bash.id } })).status, 'PENDING', 'a refused answer decides nothing');
  await sessionsService.decideApproval(w.ownerId, sessionId, bash.id, {
    behavior: 'allow',
    rememberRules: [{ toolName: 'Bash', ruleContent: 'python3:*' }],
  });
  // H1: a new exact command is scheduled data; the interactive python:* keeps its origin.
  const marked = await db.workspacePermissionRule.findMany({ where: { workspaceId: w.workspaceId, toolName: 'Bash' } });
  assert.deepEqual(
    marked.map((r) => [r.ruleContent, r.fromScheduleRun]).sort(),
    [['', false], [command, true], ['python:*', false], ['python3:*', true]].sort(),
  );
  const decision = await door.controller.pollApproval({ id: w.runnerId } as never, sessionId, bash.id);
  assert.equal(decision.rememberRules, undefined, 'literal data never becomes an engine permission pattern');
  assert.equal(await runs.reconcileRun(run.id), 'RUNNING');
  await report(w, sessionId, { outcome: 'NO_CHANGE', summary: 'Same.' });

  // The next run's claim: the same rows and the same expressions both claim paths use (QueueService.buildSession and
  // the reclaim in RunnerApiController; schedule-access.spec.ts pins them in their source).
  const next = await nextRun(schedule.id);
  const lists = await claimLists(next.sessionId);
  assert.equal(lists.permissionMode, PermissionMode.AUTO, 'claimed in Auto, as every scheduled run on Claude Code is');
  assert.deepEqual(lists.allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS],
    'the run\'s allow list and the rule a scheduled card wrote; not python:*, Edit, bg_run, the whole shell or mcp__orbit__*');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'mcp__orbit__bg_run', 'mcp__orbit__task_update', 'mcp__orbit__session_merge', 'Bash(*/orbit *)']) {
    assert.ok(lists.denied.includes(tool), `${tool} is denied`);
  }
  assert.deepEqual(lists.agentFields, { scheduledCheckOnly: true });
  await heldByRunner(w, next.sessionId);
  const repeated = await door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, next.sessionId,
    { toolName: 'Bash', input: { command }, toolUseId: `tu-${randomUUID()}` });
  assert.equal(repeated.status, 'ALLOWED', 'the same command on the next run passes with no card');
  assert.equal(door.published.length, 1, 'no new card for the same command');
  const different = await door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, next.sessionId,
    { toolName: 'Bash', input: { command: `python3 -c "open('watched.txt', 'w').write('changed')"` }, toolUseId: `tu-${randomUUID()}` });
  assert.equal(different.status, 'PENDING', 'a different python3 command still asks, even with an old marked prefix');
  assert.equal(door.published.length, 2);
});

/** What both claim paths hand the runner for a session claimed by a runner with these capabilities. */
async function claimLists(sessionId: string, runnerCapabilities: readonly string[] = []) {
  const dispatched = await db.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      workspace: { include: { permissionRules: { orderBy: { createdAt: 'asc' } } } },
      scheduleRun: { select: { accessLevel: true, schedule: { select: { accessLevel: true } } } },
    },
  });
  const provider = dispatched.provider ?? 'claude';
  const level = runAccessLevel(dispatched.scheduleRun);
  const rules = dispatched.workspace?.permissionRules ?? [];
  return {
    permissionMode: scheduleRunPermissionMode(dispatched.permissionMode as PermissionMode, level, provider),
    level,
    allowed: scheduleRunAllowedTools(
      dispatchAllowedTools(provider, ALWAYS_ALLOWED_TOOLS, rules), level, provider, rules, runnerCapabilities,
    ),
    denied: scheduleRunDisallowedTools((dispatched.workspace?.disallowedTools as string[] | null) ?? [], level, provider),
    agentFields: scheduleRunAgentFields(level),
  };
}

test('§6.2 S2e H6: a check is held to the level it started with when the schedule moves to OPEN_PR or is deleted mid-run', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('s2e-started-level');
  const { schedule } = await created(w);
  const { run, sessionId } = await nextRun(schedule.id);
  await heldByRunner(w, sessionId);
  assert.equal((await runOf(run.id)).accessLevel, 'CHECK_ONLY', 'the run records the level it started with');
  const door = approvalDoor();
  const ask = (toolName: string, extra: Record<string, string> = {}) =>
    door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, sessionId,
      { toolName, input: { file_path: 'x' }, toolUseId: `tu-${randomUUID()}`, ...extra } as never);

  // The schedule is moved to OPEN_PR while the check runs: the check is still a check.
  await db.schedule.update({ where: { id: schedule.id }, data: { accessLevel: 'OPEN_PR', envelopeAccessLevel: 'OPEN_PR' } });
  assert.equal((await ask('Edit')).status, 'DENIED', 'no card for Edit');
  assert.equal((await ask('mcp__orbit__bg_run')).status, 'DENIED');
  let lists = await claimLists(sessionId);
  assert.equal(lists.level, 'CHECK_ONLY');
  assert.ok(!lists.allowed.includes('mcp__orbit__*'), 'a reclaim does not hand back the Orbit wildcard');
  assert.deepEqual(lists.allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS]);

  // A SubAgent of the run asks under its session: its Edit is refused the same way.
  const sub = await db.subagentRun.create({ data: {
    ownerId: w.ownerId, sessionId, toolUseId: 'toolu_sub', type: 'general', definitionSource: 'builtin', decision: {},
    targetRunnerId: w.runnerId,
  } });
  const subEdit = await ask('Edit', { subagentRunId: sub.id });
  assert.equal(subEdit.status, 'DENIED', 'a SubAgent of a check gets no card for Edit');
  assert.equal((await db.approval.findUniqueOrThrow({ where: { id: subEdit.id } })).subagentRunId, sub.id);

  // The schedule is deleted while the check runs: its session is not an ordinary session on reclaim.
  await schedules.remove(w.owner, schedule.id);
  assert.equal((await scheduleOf(schedule.id)).state, 'ENDED');
  const linked = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { scheduleRunId: true } });
  assert.equal(linked.scheduleRunId, run.id, 'the session still names its run');
  lists = await claimLists(sessionId);
  assert.equal(lists.level, 'CHECK_ONLY');
  assert.deepEqual(lists.allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS]);
  assert.deepEqual(lists.agentFields, { scheduledCheckOnly: true });
  assert.equal((await ask('Write')).status, 'DENIED');
  assert.equal(door.published.length, 0, 'no card was announced');
  assert.equal(door.pushed.length, 0, 'and nothing was pushed');
});

test('§6.2 S2e: an OPEN_PR run\'s Always allow is never carried by a check, and a check runs in Auto on any runner', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('s2e-open-pr-rule');
  const pr = await created(w, { accessLevel: 'OPEN_PR' });
  const prRun = await nextRun(pr.schedule.id);
  await heldByRunner(w, prRun.sessionId);
  const door = approvalDoor();
  const card = await door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, prRun.sessionId,
    { toolName: 'Bash', input: { command: 'git push origin HEAD' }, toolUseId: `tu-${randomUUID()}` } as never);
  assert.equal(card.status, 'PENDING');
  // The client sends whatever it likes for an OPEN_PR card: stored as before, and not marked.
  await sessionsService.decideApproval(w.ownerId, prRun.sessionId, card.id, {
    behavior: 'allow', rememberRules: [{ toolName: 'Bash', ruleContent: 'git:*' }],
  });
  const rule = await db.workspacePermissionRule.findFirstOrThrow({ where: { workspaceId: w.workspaceId, ruleContent: 'git:*' } });
  assert.equal(rule.fromScheduleRun, false, 'an OPEN_PR card\'s rule is not a check\'s');

  const check = await created(w);
  const checkRun = await nextRun(check.schedule.id);
  const lists = await claimLists(checkRun.sessionId);
  assert.equal(lists.permissionMode, PermissionMode.AUTO, 'every scheduled run on Claude Code runs in Auto');
  assert.deepEqual(lists.allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS], 'git:* from the OPEN_PR card is not carried');

  // Any runner, whatever it advertises: Auto, and the full deny list, since Auto runs what is not denied.
  const old = await claimLists(checkRun.sessionId, ['claude-account-move/v1']);
  assert.equal(old.permissionMode, PermissionMode.AUTO);
  assert.deepEqual(old.allowed, [...CHECK_ONLY_CLAUDE_ALLOWED_TOOLS]);
  assert.deepEqual(old.denied, [...CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS]);
  assert.ok(old.denied.includes('EnterWorktree') && old.denied.includes('mcp__orbit__bg_run'));
  assert.deepEqual(old.agentFields, { scheduledCheckOnly: true });
});

test('§6.2 S2e: an ordinary session and an OPEN_PR run ask as before: an Edit or bg_run request is a card', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('s2e-unaffected');
  const door = approvalDoor();
  const ordinary = await db.session.create({
    data: {
      id: randomUUID(), ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 'ordinary',
      prompt: 'p', provider: 'claude', engine: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
      permissionMode: PermissionMode.DEFAULT, assignedRunnerId: w.runnerId,
    },
  });
  const { schedule } = await created(w, { accessLevel: 'OPEN_PR' });
  const { run, sessionId: prSession } = await nextRun(schedule.id);
  await heldByRunner(w, prSession);
  for (const sessionId of [ordinary.id, prSession]) {
    for (const toolName of ['Edit', 'mcp__orbit__bg_run']) {
      const card = await door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, sessionId,
        { toolName, input: { file_path: 'x' }, toolUseId: `tu-${randomUUID()}` } as never);
      assert.equal(card.status, 'PENDING', `${toolName} on ${sessionId === ordinary.id ? 'an ordinary session' : 'an OPEN_PR run'}`);
    }
  }
  assert.equal(door.published.length, 4);
  assert.equal(door.pushed.length, 4);
  assert.equal(await runs.reconcileRun(run.id), 'AWAITING_APPROVAL');
  assert.equal((await pendingItems(schedule.id)).filter((i) => i.kind === 'SCHEDULE_APPROVAL').length, 2, 'the OPEN_PR run\'s two cards are items');
});

test('§6.4 an approval item closes when its run ends, even with the card unanswered', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('approval-end');
  const { schedule } = await created(w);
  const { run, sessionId } = await nextRun(schedule.id);
  await pendingCard(sessionId);
  await runs.reconcileRun(run.id);
  assert.equal((await pendingItems(schedule.id)).length, 1);
  advance(2 * HOUR + MINUTE);
  assert.equal(await runs.reconcileRun(run.id), 'FAILED');
  assert.equal((await runOf(run.id)).failureReason, 'APPROVAL_TIMEOUT');
  const pending = await pendingItems(schedule.id);
  assert.deepEqual(pending.map((i) => i.kind), ['SCHEDULE_FAILED'], 'the approval item closed with the run; the failure waits');
  const approval = (await items(schedule.id)).find((i) => i.kind === 'SCHEDULE_APPROVAL')!;
  assert.equal(approval.state, 'WITHDRAWN');
});

test('§8.3/Waiting on you: a run asking for a wider envelope files an item; Allow closes it; a newer ask replaces it', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('widen');
  const { schedule } = await created(w, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON'] } });
  const { run, sessionId } = await nextRun(schedule.id);
  const asRun: ScheduleActor = { kind: 'SESSION', ownerId: w.ownerId, sessionId };
  const asked = await schedules.update(asRun, schedule.id, { rule: { kind: 'DAILY', time: '10:00' } });
  assert.equal(asked.outcome, 'PENDING');
  const requestId = (asked as { request: { id: string } }).request.id;
  const [item] = await pendingItems(schedule.id);
  assert.equal(item.kind, 'SCHEDULE_WIDEN');
  assert.equal(item.scheduleChangeRequestId, requestId);
  assert.equal(item.scheduleRunId, run.id);
  assert.equal(item.askedBySessionId, sessionId);
  assert.match(item.title, /^Let .+ run more often\?$/);
  assert.match(item.why, /Now: Mondays 10:00 · up to 1 run a week\. Asked: Daily 10:00 · up to 7 runs a week, 30 min each$/);
  const pushed = alertsOf(schedule.id);
  assert.deepEqual(pushed.map((a) => a.kind), ['WIDEN']);
  assert.equal(pushed[0].ownerRequestId, item.id);

  const newer = await schedules.update(asRun, schedule.id, { rule: { kind: 'WEEKLY', time: '10:00', weekdays: ['MON', 'TUE', 'WED'] } });
  assert.equal(newer.outcome, 'PENDING');
  const pending = await pendingItems(schedule.id);
  assert.equal(pending.length, 1, 'the superseded ask closed');
  assert.equal(pending[0].scheduleChangeRequestId, (newer as { request: { id: string } }).request.id);
  assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: item.id } })).state, 'WITHDRAWN');

  await schedules.decide(w.owner, pending[0].scheduleChangeRequestId!, 'ALLOW');
  assert.deepEqual(await pendingItems(schedule.id), [], 'Allow closes it');
  assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: pending[0].id } })).state, 'DONE');

  // Decline closes it the same way, through the same decide code S4's door calls.
  const declinedAsk = await schedules.update(asRun, schedule.id, { runLimitMinutes: 90 });
  assert.equal(declinedAsk.outcome, 'PENDING');
  const [toDecline] = await pendingItems(schedule.id);
  assert.equal(toDecline.kind, 'SCHEDULE_WIDEN');
  await assert.rejects(ownerRequests.complete(w.ownerId, toDecline.id, {}), 'Waiting on you cannot mark it done: the answer is Allow or Decline');
  await assert.rejects(ownerRequests.decline(w.ownerId, toDecline.id, 'no'), 'nor decline the item beside a request left PENDING');
  assert.equal((await db.scheduleChangeRequest.findUniqueOrThrow({ where: { id: toDecline.scheduleChangeRequestId! } })).state, 'PENDING');
  await schedules.decide(w.owner, toDecline.scheduleChangeRequestId!, 'DECLINE');
  assert.deepEqual(await pendingItems(schedule.id), [], 'Decline closes it');
  const declinedItem = await db.ownerRequest.findUniqueOrThrow({ where: { id: toDecline.id } });
  assert.equal(declinedItem.state, 'DONE');
  assert.equal(declinedItem.resolutionNote, 'Declined.');

  // A person's own ask from a conversation is the card in that conversation, not an item in Waiting on you.
  const person = await conversation(w);
  const own = await schedules.update({ kind: 'SESSION', ownerId: w.ownerId, sessionId: person }, schedule.id, { runLimitMinutes: 60 });
  assert.equal(own.outcome, 'PENDING');
  assert.deepEqual(await pendingItems(schedule.id), []);
});

test('§8.3/§7.3 a run ending its own schedule pushes once and opens the schedule; a person ending it pushes nothing', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('goal');
  const { schedule } = await created(w);
  const { sessionId } = await nextRun(schedule.id);
  await schedules.end({ kind: 'SESSION', ownerId: w.ownerId, sessionId }, schedule.id);
  const pushed = alertsOf(schedule.id);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].kind, 'GOAL_REACHED');
  assert.deepEqual(pushed[0].opens, { scheduleId: schedule.id });
  await assert.rejects(schedules.end({ kind: 'SESSION', ownerId: w.ownerId, sessionId }, schedule.id));
  assert.equal(alertsOf(schedule.id).length, 1, 'once');

  const other = (await created(w)).schedule;
  await schedules.end(w.owner, other.id);
  const person = await conversation(w);
  const third = (await created(w)).schedule;
  await schedules.end({ kind: 'SESSION', ownerId: w.ownerId, sessionId: person }, third.id);
  assert.deepEqual([...alertsOf(other.id), ...alertsOf(third.id)], [], 'only a run ending its own schedule is news');
});

test('§5.2/§7.3 a missed ONCE notifies once and opens the schedule', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('once');
  const { schedule } = await created(w, { rule: { kind: 'ONCE', at: '2026-11-14T18:00' } });
  at('2026-11-16T12:00:00Z');
  assert.equal(await runs.fire(schedule.id), 'MISSED');
  assert.equal((await scheduleOf(schedule.id)).state, 'ENDED');
  await runs.fire(schedule.id);
  const pushed = alertsOf(schedule.id);
  assert.equal(pushed.length, 1, 'once');
  assert.equal(pushed[0].kind, 'ONCE_MISSED');
  assert.deepEqual(pushed[0].opens, { scheduleId: schedule.id });

  // A missed slot of a recurring rule is not news: the next one runs.
  const daily = (await created(w)).schedule;
  const s = await scheduleOf(daily.id);
  at(new Date(s.nextDueAt!.getTime() + 25 * HOUR + 5 * MINUTE).toISOString());
  await runs.fire(daily.id);
  assert.deepEqual(alertsOf(daily.id), []);
});

test('Waiting on you: the owner ending a schedule closes what waited on it, and its items deliver nothing to a session', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('closing');
  const { schedule } = await created(w);
  const { sessionId } = await nextRun(schedule.id);
  await report(w, sessionId, { outcome: 'FAILED', summary: 'No network.' });
  const [failed] = await pendingItems(schedule.id);
  // The owner dismisses the failure from Waiting on you: no turn is queued on the run's session.
  await ownerRequests.complete(w.ownerId, failed.id, {});
  assert.equal(await db.watchDelivery.count({ where: { ownerRequestId: failed.id } }), 0, 'nothing is delivered to the run\'s session');

  const two = await nextRun(schedule.id);
  await report(w, two.sessionId, { outcome: 'FAILED', summary: 'No network.' });
  assert.equal((await pendingItems(schedule.id)).length, 1);
  await schedules.remove(w.owner, schedule.id);
  assert.deepEqual(await pendingItems(schedule.id), [], 'deleting the schedule closes its items');
  // Items the view reads carry what they are about.
  const view = await ownerRequests.list(w.ownerId, 'all');
  const mine = view.requests.find((r) => r.id === failed.id) as unknown as Record<string, unknown>;
  assert.equal(mine.scheduleId, schedule.id);
  assert.ok('scheduleRunId' in mine && 'approvalId' in mine && 'scheduleChangeRequestId' in mine);
});

// =============================================================================================================
// §7.4 / §12.1 — run sessions are in none of the session queries
// =============================================================================================================

test('§7.4/§12.1 a run\'s session is in no list but its Scheduled runs folder, no search, count, orchestration list, folder count or session.created push; the run names it', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('hidden');
  const { schedule, from } = await created(w, { title: 'Hiddenrun probe' });
  const manual = await conversation(w, 'Hiddenrun person');
  const { run, sessionId } = await nextRun(schedule.id);
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  const open = await sessionsService.list(w.ownerId, { view: 'open' });
  assert.ok(ids(open).includes(manual) && ids(open).includes(from), 'the people\'s conversations are listed');
  assert.ok(!ids(open).includes(sessionId), 'list (Open) leaves the run out');
  assert.ok(!ids(await sessionsService.list(w.ownerId, { view: 'open', workspaceId: w.workspaceId })).includes(sessionId), 'the workspace\'s list too');
  assert.deepEqual(ids(await sessionsService.list(w.ownerId, { view: 'open', workspaceId: w.workspaceId, scheduled: true })),
    [sessionId], 'the workspace\'s Scheduled runs folder lists the run, and only runs');
  assert.equal((await sessionsService.list(w.ownerId, { view: 'open', workspaceId: w.workspaceId, scheduled: true }))[0]?.runSource,
    'SCHEDULE', 'a row says it is a run, which every client\'s folder keeps by');

  const delta = await sessionsService.listOpenSince(w.ownerId, {}, undefined);
  assert.equal(delta.full, true);
  assert.ok(!ids((delta as { sessions: Array<{ id: string }> }).sessions).includes(sessionId), 'listOpenSince');
  const byIds = await sessionsService.listRowsByIds(w.ownerId, [sessionId, manual]);
  assert.deepEqual(new Set(ids(byIds)), new Set([sessionId, manual]), 'listRowsByIds names its sessions: a link card to a run is by id');

  const found = await sessionsService.search(w.ownerId, 'Hiddenrun', 20);
  assert.ok(found.hits.some((h) => h.id === manual), 'search finds the person\'s conversation');
  assert.ok(!found.hits.some((h) => h.id === sessionId), 'search leaves the run out');
  const recents = await sessionsService.search(w.ownerId, '', 50);
  assert.ok(!recents.hits.some((h) => h.id === sessionId), 'and so do the recents');

  const counts = await sessionsService.workspaceSessionCounts(w.ownerId);
  const row = counts.find((c) => c.workspaceId === w.workspaceId);
  const people = await db.session.count({
    where: { workspaceId: w.workspaceId, completedAt: null, deletedAt: null, status: { in: ['RUNNING', 'PENDING'] }, runSource: { not: 'SCHEDULE' } },
  });
  assert.equal(row?.active ?? 0, people, 'workspaceSessionCounts counts only the people\'s');

  assert.equal(await workspaceSessionCount(db as never, w.workspaceId), await db.session.count({
    where: { workspaceId: w.workspaceId, parentSessionId: null, deletedAt: null, runSource: { not: 'SCHEDULE' } },
  }), 'the workspace page\'s "N sessions" leaves the run out');
  await db.session.update({ where: { id: sessionId }, data: { lastTurnAt: new Date('2026-12-01T00:00:00Z') } });
  const lastActive = (await lastActiveByWorkspace(db as never, [w.workspaceId])).get(w.workspaceId);
  assert.ok(!lastActive || lastActive < new Date('2026-12-01T00:00:00Z'), 'a run does not make the workspace "last used"');
  // v1 feeds no run to the wiki: no session_settled fact, and a backfill does not read it.
  await db.session.update({ where: { id: sessionId }, data: { turnState: null } });
  const scope = { ownerId: w.ownerId, spaceId: randomUUID(), workspaceIds: [w.workspaceId], projectIds: [], foreignSessionIds: [], maintenanceListId: null };
  const facts = await db.$queryRaw<Array<{ kind: string; sessionId: string | null }>>(factsSql(scope, null));
  assert.ok(!facts.some((f) => f.sessionId === sessionId), 'no wiki fact names the run');
  assert.deepEqual([...await wikiSessionsOfSpace(db as never, scope, [sessionId])], [], 'wikiSessionsOfSpace leaves it out');
  const orchestration = await sessionsService.listForOrchestration(w.ownerId, {});
  assert.ok(!ids(orchestration).includes(sessionId), 'listForOrchestration (session_list)');

  const folder = await db.sessionFolder.create({ data: { ownerId: w.ownerId, workspaceId: w.workspaceId, name: 'F' } });
  await db.session.updateMany({ where: { id: { in: [sessionId, manual] } }, data: { folderId: folder.id } });
  const targets = await sessionsService.moveTargets(w.ownerId, from);
  assert.equal(targets.folders.find((f) => f.id === folder.id)?.sessionCount, 1, 'the folder counts the person\'s session only');
  assert.ok(!ids(await sessionsService.list(w.ownerId, { view: 'open', workspaceId: w.workspaceId })).includes(sessionId), 'nor the folder view');

  const seen = firstValueFrom(realtime.streamForUser(w.ownerId).pipe(take(1), timeout(5_000), toArray()));
  realtime.publishSessionCreated(sessionId);
  realtime.publishSessionCreated(manual);
  const events = await seen;
  assert.deepEqual(events.map((e) => [e.type, e.sessionId]), [['session.created', manual]], 'no session.created for the run');

  // Reached by id, as the schedule's history and the notification open it.
  assert.equal((await sessionsService.getForOrchestration(w.ownerId, sessionId))?.id, sessionId);
  const history = await runs.history(w.ownerId, schedule.id);
  assert.deepEqual(history.find((h) => h.id === run.id)?.session, { id: sessionId, state: 'OPEN' });

  // A NO_CHANGE run's completed session is not in Completed either.
  await db.session.update({ where: { id: sessionId }, data: { turnState: null } });
  await report(w, sessionId, { outcome: 'NO_CHANGE', summary: 'Same.' });
  assert.ok((await runs.completeNoChangeSessions(1000)).includes(sessionId), 'the worker\'s pass completes it');
  assert.ok(!ids(await sessionsService.list(w.ownerId, { view: 'completed' })).includes(sessionId), 'list (Completed)');
  assert.deepEqual(ids(await sessionsService.list(w.ownerId, { view: 'completed', workspaceId: w.workspaceId, scheduled: true })),
    [sessionId], 'the Scheduled runs folder\'s Completed lists it');
  assert.deepEqual((await runs.history(w.ownerId, schedule.id)).find((h) => h.id === run.id)?.session, { id: sessionId, state: 'COMPLETED' });
});

test('§7.4 trashing or purging a run\'s session keeps the run, which says its session is gone', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('gone');
  const { schedule } = await created(w);
  const { run, sessionId } = await nextRun(schedule.id);
  await report(w, sessionId, { outcome: 'CHANGED', key: 'k1', summary: 'New.' });

  await db.session.update({ where: { id: sessionId }, data: { deletedAt: clockNow } });
  assert.ok(!(await sessionsService.list(w.ownerId, { view: 'trash' })).some((r) => r.id === sessionId), 'not in Trash either');
  assert.ok((await sessionsService.list(w.ownerId, { view: 'trash', scheduled: true })).some((r) => r.id === sessionId),
    'but in the Scheduled runs folder\'s Trash');
  let h = (await runs.history(w.ownerId, schedule.id)).find((r) => r.id === run.id)!;
  assert.deepEqual(h.session, { id: sessionId, state: 'TRASH' });

  await db.session.delete({ where: { id: sessionId } });
  const kept = await runOf(run.id);
  assert.equal(kept.state, 'CHANGED', 'the run row is kept');
  assert.equal(kept.sessionId, sessionId, 'and still names the session it had');
  h = (await runs.history(w.ownerId, schedule.id)).find((r) => r.id === run.id)!;
  assert.deepEqual(h.session, { id: sessionId, state: 'GONE' });
});

test('§7.3 a run that outlives its ended schedule and then fails is pushed but files no item nothing would close', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('ended-then-failed');
  const { schedule } = await created(w);
  const { sessionId } = await nextRun(schedule.id);
  await schedules.remove(w.owner, schedule.id);
  assert.equal((await scheduleOf(schedule.id)).state, 'ENDED');
  await report(w, sessionId, { outcome: 'FAILED', summary: 'Gave up.' });
  assert.deepEqual(alertsOf(schedule.id).map((a) => [a.kind, a.ownerRequestId]), [['FAILED', null]]);
  assert.deepEqual(await items(schedule.id), [], 'no SCHEDULE_FAILED for a deleted schedule');
});

test('§7.3 two reports racing on the same new key push once', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('race');
  const { schedule } = await created(w);
  const { sessionId } = await nextRun(schedule.id);
  const r = { outcome: 'CHANGED' as const, key: 'codex@0.50.0', summary: 'Codex 0.50.0 is out.' };
  const settled = await Promise.allSettled([report(w, sessionId, r), report(w, sessionId, r)]);
  assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 1, 'one report wins; the other is refused');
  assert.equal(alertsOf(schedule.id).filter((a) => a.kind === 'FINDING').length, 1, 'one push');
  assert.equal(await db.scheduleFinding.count({ where: { scheduleId: schedule.id, key: 'codex@0.50.0' } }), 1);
});

test('Waiting on you: an item whose run session was purged stays readable and still closes', { skip }, async () => {
  alerts = [];
  at('2026-11-14T00:00:00Z');
  const w = await world('purged');
  const { schedule } = await created(w);
  const one = await nextRun(schedule.id);
  await report(w, one.sessionId, { outcome: 'FAILED', summary: 'Down.' });
  const [failed] = await pendingItems(schedule.id);
  await db.session.delete({ where: { id: one.sessionId } });
  const open = (await ownerRequests.list(w.ownerId, 'open')).requests.map((r) => r.id);
  assert.ok(open.includes(failed.id), 'the item outlives its session');
  assert.equal((await ownerRequests.get(w.ownerId, failed.id)).scheduleRunId, one.run.id);
  const two = await nextRun(schedule.id);
  await report(w, two.sessionId, { outcome: 'NO_CHANGE', summary: 'Up.' });
  assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: failed.id } })).state, 'WITHDRAWN');
  // A failure may be dismissed with a reason; that is the one item kind Waiting on you ends itself.
  const three = await nextRun(schedule.id);
  await report(w, three.sessionId, { outcome: 'FAILED', summary: 'Down again.' });
  const [again] = await pendingItems(schedule.id);
  assert.equal((await ownerRequests.decline(w.ownerId, again.id, 'known outage')).state, 'DECLINED');
});

for (const accessLevel of ['OPEN_PR', 'LAND'] as const) {
  test(`scheduled ${accessLevel} Codex approvals deny level restrictions before workspace grants`, { skip }, async () => {
    at('2026-11-14T00:00:00Z');
    const w = await world(`deny-level-${accessLevel}`);
    await db.workspace.update({ where: { id: w.workspaceId }, data: { enableWorktree: true } });
    const { schedule, from } = await created(w, { accessLevel }, 'codex');
    const { sessionId } = await nextRun(schedule.id);
    await heldByRunner(w, sessionId, 'codex');
    await heldByRunner(w, from, 'codex');
    await db.workspacePermissionRule.createMany({ data: [
      { workspaceId: w.workspaceId, toolName: 'Bash', ruleContent: 'gh pr:*' },
      { workspaceId: w.workspaceId, toolName: 'mcp__orbit__session_merge', ruleContent: '' },
    ] });
    const door = approvalDoor();
    const ask = (id: string, toolName: string, input: Record<string, unknown>) =>
      door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, id,
        { toolName, input, toolUseId: randomUUID() });
    assert.equal((await ask(from, 'Bash', { command: 'gh pr merge 12' })).status, 'ALLOWED');
    assert.equal((await ask(from, 'Bash', { command: "/bin/bash -lc 'gh pr merge 12'" })).status, 'PENDING',
      'interactive wrapper matching is unchanged');
    for (const command of [
      "/bin/bash -lc 'gh pr merge 12'", 'gh pr merge 12', 'sh -c "gh pr merge 12"',
      "echo safe && gh pr merge 12", "git push origin HEAD:main", "gh release create v1",
      "npm publish", "docker push example/image",
    ]) {
      assert.equal((await ask(sessionId, 'Bash', { command })).status, 'DENIED', command);
    }
    for (const [toolName, input] of [
      ['mcp__orbit__session_merge', {}], ['mcp__orbit__integration_example', {}],
      ['Skill', { skill: 'release' }], ['Skill', { skill: 'upgrade' }],
    ] as const) {
      assert.equal((await ask(sessionId, toolName, input)).status, 'DENIED', toolName);
    }
    assert.equal((await ask(sessionId, 'Bash', { command: 'gh pr view 12' })).status, 'ALLOWED');
  });
}

test("a scheduled check's Always allow preserves an identical interactive rule's origin", { skip }, async () => {
  at('2026-11-14T00:00:00Z');
  const w = await world('preserve-rule-origin');
  const { schedule, from } = await created(w);
  const { sessionId } = await nextRun(schedule.id);
  await heldByRunner(w, sessionId);
  await db.workspacePermissionRule.create({ data: {
    workspaceId: w.workspaceId, toolName: 'Bash', ruleContent: 'npm test', createdById: w.ownerId,
  } });
  const door = approvalDoor();
  const ask = () => door.controller.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, sessionId,
    { toolName: 'Bash', input: { command: 'npm test' }, toolUseId: randomUUID() });
  const card = await ask();
  assert.equal(card.status, 'PENDING');
  await sessionsService.decideApproval(w.ownerId, sessionId, card.id, {
    behavior: 'allow', rememberRules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  });
  const rules = await db.workspacePermissionRule.findMany({ where: { workspaceId: w.workspaceId } });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].fromScheduleRun, false, 'a duplicate insert must not change the existing origin');
  assert.ok((await claimLists(from)).allowed.includes('Bash(npm test)'), 'interactive dispatch retains the rule');
  assert.equal((await ask()).status, 'PENDING', 'the existing interactive rule remains outside scheduled exact grants');
});
