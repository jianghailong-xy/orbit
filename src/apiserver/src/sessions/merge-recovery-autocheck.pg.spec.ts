/**
 * A REPAIR SESSION STOPS, AND THE SERVER CHECKS ITS PARENT'S MERGE RECOVERY AGAIN — OVER A REAL POSTGRESQL.
 *
 * S1 of the merge-recovery repair loop (project 34hIv3wbdtsxpc5RzDlOk). Every turn of a repair session
 * (`source: 'merge-repair'`, its parent the session whose merge it repairs) ends at a settle — the runner's
 * /turn-complete, or a /finalize that ends a turn still running — and the parent's recovery is then checked
 * again by a preview queued the way the owner's Check again queues one: once per turn, while no client is
 * there, and only when the check could tell anybody something new. The cases are the task's named scenarios,
 * each through the real runner doors (events, turn-complete, finalize, the heartbeat's merge drain and the
 * merge result) rather than a call to the check by name; the one seam is a SessionsService that records the
 * checks those doors start, so a case can wait for a check that is fire-and-forget by design and can say that
 * a door started none.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/merge-recovery-autocheck.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  RunEventType,
  RunStatus as SharedRunStatus,
  SESSION_MERGE_RECOVERY_V1,
  type MergeRecovery,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService, type RepairTurnCheck } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The production SessionsService, recording each check a runner door starts with what it answered. */
class WatchedSessions extends SessionsService {
  readonly checks: Array<{ id: string; turnEndedAt: Date | null; outcome: Promise<RepairTurnCheck> }> = [];

  override checkAfterRepairTurn(id: string, turnEndedAt: Date | null): Promise<RepairTurnCheck> {
    const outcome = super.checkAfterRepairTurn(id, turnEndedAt);
    this.checks.push({ id, turnEndedAt, outcome });
    return outcome;
  }

  /** What every check started so far answered, in the order the doors started them. */
  async outcomes(): Promise<Array<{ id: string; outcome: RepairTurnCheck }>> {
    return Promise.all(this.checks.map(async (c) => ({ id: c.id, outcome: await c.outcome })));
  }
}

/** One API replica: its own client, realtime, sessions and runner doors, as a second process has. */
function replica(url: string) {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const push = {
    scheduleBadgeSync: () => undefined,
    notifySessionSettled: async () => undefined,
  } as unknown as PushService;
  const realtime = new RealtimeService(prisma, push);
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new WatchedSessions(prisma, queue, realtime);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
  );
  return { db, realtime, sessions, api };
}

/** The runner's own clock format for `checkedAt`: RFC 3339 to the second, as merge_recovery.go writes it. */
const rfc3339 = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What a check that found a conflict in the repair's replay leaves on the session it is about. */
function conflictRecovery(checkedAt: Date | null): MergeRecovery {
  const previewId = randomUUID().replace(/-/g, '');
  return {
    code: 'CONFLICT', targetBranch: 'main', repoRoot: '/repo', previewId,
    sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40),
    repairBranch: `orbit/recovery/${previewId}`, repairWorktree: `/worktrees/recovery-${previewId}`,
    phase: 'SOURCE_REPLAY', conflicts: ['src/app.ts'],
    ...(checkedAt ? { checkedAt: rfc3339(checkedAt) } : {}),
  };
}

const HOUR = 3_600_000;

interface World { ownerId: string; runnerId: string; workspaceId: string }

/** One owner, one runner (able to check recoveries unless told otherwise) and one workspace. */
async function world(db: PrismaClient, label: string, capabilities = [SESSION_MERGE_RECOVERY_V1]): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@merge-autocheck.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/repo' },
  });
  return { ownerId, runnerId, workspaceId };
}

/** A conversation with one message turn out on delivery to its runner, as the inbox leaves one. */
async function turnOutOnDelivery(db: PrismaClient, sessionId: string, label: string): Promise<string> {
  const turn = await db.conversationTurn.create({
    data: {
      sessionId, seq: 1, clientTurnId: `${label}-${randomUUID()}`, kind: 'message', content: 'go on',
      status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
      leaseGeneration: randomUUID(),
    },
    select: { id: true },
  });
  return turn.id;
}

/**
 * The session whose merge needs recovering: a finished run with a worktree branch, its recovery as the
 * last check left it. `running` gives it a turn of its own in flight instead, under a runner process's lease.
 */
async function parentSession(
  db: PrismaClient,
  w: World,
  label: string,
  opts: { recovery: MergeRecovery | null; running?: { leaseOwner: string }; merge?: Record<string, unknown> },
): Promise<{ id: string; turnId: string | null }> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: `${label} parent`, prompt: 'ship the feature', provider: 'claude', providerBuiltin: true,
      dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), runtimeSessionId: randomUUID(),
      branch: `orbit/${label}-${id.slice(0, 8)}`, isolationStatus: 'worktree',
      ...(opts.running
        ? { status: RunStatus.RUNNING, engineTurnActive: true, inboxLeaseOwner: opts.running.leaseOwner }
        : { status: RunStatus.SUCCEEDED, finishedAt: new Date() }),
      ...(opts.recovery ? { mergeRecovery: opts.recovery as never, mergeStatus: 'conflict', mergeRecoveryAction: 'preview' } : {}),
      ...(opts.merge ?? {}),
    },
  });
  return { id, turnId: opts.running ? await turnOutOnDelivery(db, id, label) : null };
}

/** A repair session of `parentId` — or, given another `source`, an ordinary child — running its turn. */
async function childSession(
  db: PrismaClient,
  w: World,
  parentId: string,
  label: string,
  source = 'merge-repair',
): Promise<{ id: string; turnId: string }> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: `${label} child`, prompt: 'Resolve this merge recovery for main.', provider: 'claude', providerBuiltin: true,
      status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(), runtimeSessionId: randomUUID(), source, parentSessionId: parentId,
    },
  });
  return { id, turnId: await turnOutOnDelivery(db, id, label) };
}

/** The runner's events for a turn: the reply it streamed, through the real ingest, from the process that
 *  holds the session's lease when one does. */
function reply(api: RunnerApiController, runnerId: string, sessionId: string, turnId: string, text: string, leaseOwner?: string) {
  return api.events({ id: runnerId }, sessionId, {
    events: [{ seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId, payload: { text } }],
    ...(leaseOwner ? { leaseOwner } : {}),
  });
}

/** The completion a runner reports for a turn its engine answered. */
function completed(turnId: string, extra: Record<string, unknown> = {}) {
  return { turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0, ...extra } as never;
}

/** The merge columns of a session, over a connection of the spec's own. */
async function mergeRow(sql: Client, id: string) {
  const r = await sql.query(
    `SELECT merge_status, merge_recovery_action, merge_operation_id, merge_target, merge_recovery,
            extract(epoch FROM merge_repair_turn_ended_at)::float8 * 1000 AS owed_ms
       FROM "session" WHERE id = $1::uuid`,
    [id],
  );
  return r.rows[0] as {
    merge_status: string | null;
    merge_recovery_action: string | null;
    merge_operation_id: string | null;
    merge_target: string | null;
    merge_recovery: MergeRecovery | null;
    owed_ms: number | null;
  };
}

test('S1 a repair session\'s turn has its parent\'s merge recovery checked again on PostgreSQL', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const one = replica(url);
  const other = replica(url);
  t.after(async () => {
    await one.db.$disconnect().catch(() => undefined);
    await other.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const { db, api, sessions, realtime } = one;

  await t.test('S1 a repair turn that ends after the recovery was checked queues exactly one preview, which the runner is handed with the recovery', async () => {
    const w = await world(db, 'later');
    const recovery = conflictRecovery(new Date(Date.now() - HOUR));
    const parent = await parentSession(db, w, 'later', { recovery });
    const repair = await childSession(db, w, parent.id, 'later');
    const before = sessions.checks.length;

    await reply(api, w.runnerId, repair.id, repair.turnId, 'Resolved src/app.ts and committed the repair.');
    await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));

    const started = (await sessions.outcomes()).slice(before);
    assert.deepEqual(started, [{ id: parent.id, outcome: 'QUEUED' }], 'one check, of the parent, queued');
    const row = await mergeRow(sql, parent.id);
    assert.equal(row.merge_status, 'pending');
    assert.equal(row.merge_recovery_action, 'preview');
    assert.equal(row.merge_target, 'main', 'into the recovery\'s own target, as Check again sends it');
    assert.ok(row.merge_operation_id, 'a fresh operation for the runner to fence its result to');
    assert.deepEqual(row.merge_recovery, recovery, 'the recovery is left for the preview to carry the repair from');
    assert.equal(row.owed_ms, null, 'and nothing is left owed');

    // The heartbeat hands the runner exactly that one preview, with the recovery it checks again.
    const leaseOwner = randomUUID();
    const commands = await realtime.drainMergeRequests(w.runnerId, leaseOwner, true);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, parent.id);
    assert.equal(commands[0].recoveryAction, 'preview');
    assert.equal(commands[0].operationId, row.merge_operation_id);
    assert.equal(commands[0].targetBranch, 'main');
    assert.deepEqual(commands[0].recovery, recovery);
    // A runner that cannot check is handed nothing, as for the owner's own preview.
    assert.deepEqual(await realtime.drainMergeRequests(w.runnerId, leaseOwner, false), []);

    // A recovery no check has stamped yet (an early error carries no checkedAt) reads as checked before
    // the turn: it is queued too.
    const unstamped = await parentSession(db, w, 'unstamped', { recovery: { ...conflictRecovery(null), code: 'FETCH_FAILED' } });
    const unstampedRepair = await childSession(db, w, unstamped.id, 'unstamped');
    const mark = sessions.checks.length;
    await reply(api, w.runnerId, unstampedRepair.id, unstampedRepair.turnId, 'Fixed it.');
    await api.turnComplete({ id: w.runnerId }, unstampedRepair.id, completed(unstampedRepair.turnId));
    assert.deepEqual((await sessions.outcomes()).slice(mark), [{ id: unstamped.id, outcome: 'QUEUED' }]);
    assert.equal((await mergeRow(sql, unstamped.id)).merge_recovery_action, 'preview');
  });

  await t.test('S1 the same turn reported twice, by two replicas at once, queues one preview, and a failed check is not queued again', async () => {
    const w = await world(db, 'twice');
    const parent = await parentSession(db, w, 'twice', { recovery: conflictRecovery(new Date(Date.now() - HOUR)) });
    const repair = await childSession(db, w, parent.id, 'twice');
    const beforeOne = one.sessions.checks.length;
    const beforeOther = other.sessions.checks.length;
    await reply(api, w.runnerId, repair.id, repair.turnId, 'Committed the repair.');

    // A runner that lost the first reply re-posts while the first is still being settled, and the two
    // land on different replicas. Only the completion that answers the turn applies; the other is a no-op.
    const answers = await Promise.all([
      one.api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId)),
      other.api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId)),
    ]);
    assert.deepEqual(answers.map((a) => a.ok), [true, true]);
    const started = [
      ...(await one.sessions.outcomes()).slice(beforeOne),
      ...(await other.sessions.outcomes()).slice(beforeOther),
    ];
    assert.deepEqual(started, [{ id: parent.id, outcome: 'QUEUED' }], 'one check between the two replicas');
    const queued = await mergeRow(sql, parent.id);
    assert.equal(queued.merge_status, 'pending');
    assert.equal(queued.merge_recovery_action, 'preview');

    // The check fails before it reaches the repair, as a fetch can: an early error, which carries no
    // checkedAt, so by time alone the same turn would qualify again.
    const leaseOwner = randomUUID();
    const [command] = await realtime.drainMergeRequests(w.runnerId, leaseOwner, true);
    assert.equal(command.operationId, queued.merge_operation_id);
    const failed: MergeRecovery = { ...command.recovery!, code: 'FETCH_FAILED' };
    delete failed.checkedAt;
    await api.mergeResult({ id: w.runnerId }, parent.id, {
      status: 'error', operationId: command.operationId, leaseOwner, sourceSha: failed.sourceSha,
      targetBranch: 'main', recovery: failed, message: 'could not check origin/main',
    });
    assert.equal((await mergeRow(sql, parent.id)).merge_status, 'error');

    // The same completion arriving a third time changes nothing and checks nothing.
    await one.api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));
    assert.equal(one.sessions.checks.length + other.sessions.checks.length - beforeOne - beforeOther, 1);
    const after = await mergeRow(sql, parent.id);
    assert.equal(after.merge_status, 'error', 'the failed check stands as that turn\'s answer');
    assert.equal(after.merge_operation_id, queued.merge_operation_id, 'and no second operation was queued');
  });

  await t.test('S1 a repair turn that ended before the recovery was checked queues nothing', async () => {
    const w = await world(db, 'earlier');
    // The check ran after the turn ended: it already saw everything the turn did.
    const recovery = conflictRecovery(new Date(Date.now() + 10 * 60_000));
    const parent = await parentSession(db, w, 'earlier', { recovery });
    const repair = await childSession(db, w, parent.id, 'earlier');
    const before = sessions.checks.length;
    await reply(api, w.runnerId, repair.id, repair.turnId, 'Nothing more to do.');
    await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));
    assert.deepEqual((await sessions.outcomes()).slice(before), [{ id: parent.id, outcome: 'ALREADY_CHECKED' }]);
    const row = await mergeRow(sql, parent.id);
    assert.equal(row.merge_status, 'conflict', 'no preview queued');
    assert.deepEqual(row.merge_recovery, recovery);
    assert.equal(row.owed_ms, null);
  });

  await t.test('S1 while the parent runs a turn the check waits, and the end of that turn queues it', async () => {
    const w = await world(db, 'deferred');
    const parentLease = randomUUID();
    const recovery = conflictRecovery(new Date(Date.now() - HOUR));
    const parent = await parentSession(db, w, 'deferred', { recovery, running: { leaseOwner: parentLease } });
    const repair = await childSession(db, w, parent.id, 'deferred');
    const before = sessions.checks.length;
    await reply(api, w.runnerId, repair.id, repair.turnId, 'Committed the repair.');
    const ended = Date.now();
    await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));

    // mergeToMain would refuse a merge now ("wait for the current turn to finish"): nothing is queued,
    // and the repair turn's end is kept on the parent.
    assert.deepEqual((await sessions.outcomes()).slice(before), [{ id: parent.id, outcome: 'DEFERRED' }]);
    const waiting = await mergeRow(sql, parent.id);
    assert.equal(waiting.merge_status, 'conflict', 'no preview while the parent runs');
    assert.ok(waiting.owed_ms !== null && Math.abs(waiting.owed_ms - ended) < 60_000, 'the turn\'s end is kept');
    await assert.rejects(
      () => sessions.mergeToMain(w.ownerId, parent.id, 'main', undefined, { recoveryAction: 'preview' }),
      /wait for the current turn to finish/,
      'the owner\'s Check again is refused for the same reason',
    );

    // The parent's own turn ends: the check it was owed is queued at that moment.
    await reply(api, w.runnerId, parent.id, parent.turnId!, 'Done with that question.', parentLease);
    const mark = sessions.checks.length;
    await api.turnComplete({ id: w.runnerId }, parent.id, completed(parent.turnId!, { leaseOwner: parentLease }));
    assert.deepEqual((await sessions.outcomes()).slice(mark), [{ id: parent.id, outcome: 'QUEUED' }]);
    const queued = await mergeRow(sql, parent.id);
    assert.equal(queued.merge_status, 'pending');
    assert.equal(queued.merge_recovery_action, 'preview');
    assert.equal(queued.owed_ms, null, 'what was owed is taken up');
    const [command] = await realtime.drainMergeRequests(w.runnerId, parentLease, true);
    assert.equal(command.sessionId, parent.id);
    assert.equal(command.recoveryAction, 'preview');
    assert.deepEqual(command.recovery, recovery);
  });

  await t.test('S1 a merge operation in flight on the parent queues nothing', async () => {
    const w = await world(db, 'inflight');
    const operationId = randomUUID();
    const recovery = conflictRecovery(new Date(Date.now() - HOUR));
    const parent = await parentSession(db, w, 'inflight', {
      recovery,
      merge: { mergeStatus: 'pending', mergeRecoveryAction: 'apply', mergeOperationId: operationId, mergeRequestedAt: new Date() },
    });
    const repair = await childSession(db, w, parent.id, 'inflight');
    const before = sessions.checks.length;
    await reply(api, w.runnerId, repair.id, repair.turnId, 'Committed the repair.');
    await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));
    assert.deepEqual((await sessions.outcomes()).slice(before), [{ id: parent.id, outcome: 'OPERATION_IN_FLIGHT' }]);
    const row = await mergeRow(sql, parent.id);
    assert.equal(row.merge_status, 'pending');
    assert.equal(row.merge_recovery_action, 'apply', 'the operation in flight is left as it is');
    assert.equal(row.merge_operation_id, operationId);
    assert.equal(row.owed_ms, null, 'and no check is kept for later');
  });

  await t.test('S1 a recovery in LOCAL_SYNC_PENDING, PUSH_FAILED or REMOTE_NOT_VERIFIED queues nothing', async () => {
    for (const code of ['LOCAL_SYNC_PENDING', 'PUSH_FAILED', 'REMOTE_NOT_VERIFIED']) {
      const w = await world(db, `landing-${code}`);
      const recovery = { ...conflictRecovery(new Date(Date.now() - HOUR)), code };
      const parent = await parentSession(db, w, `landing-${code}`, { recovery, merge: { mergeStatus: 'error', mergeRecoveryAction: 'apply' } });
      const repair = await childSession(db, w, parent.id, `landing-${code}`);
      const before = sessions.checks.length;
      await reply(api, w.runnerId, repair.id, repair.turnId, 'Committed the repair.');
      await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));
      assert.deepEqual((await sessions.outcomes()).slice(before), [{ id: parent.id, outcome: 'LANDING_UNFINISHED' }], code);
      const row = await mergeRow(sql, parent.id);
      assert.equal(row.merge_status, 'error', `${code}: no preview replaces a landing being finished`);
      assert.equal(row.merge_recovery_action, 'apply', code);
      assert.deepEqual(row.merge_recovery, recovery, code);
    }
  });

  await t.test('S1 a turn of an ordinary child session triggers no check', async () => {
    const w = await world(db, 'ordinary');
    const parent = await parentSession(db, w, 'ordinary', { recovery: conflictRecovery(new Date(Date.now() - HOUR)) });
    // A session spawned from the parent (session_create) is its child too, but not its repair.
    const child = await childSession(db, w, parent.id, 'ordinary', 'user');
    const before = sessions.checks.length;
    await reply(api, w.runnerId, child.id, child.turnId, 'Wrote the release notes.');
    await api.turnComplete({ id: w.runnerId }, child.id, completed(child.turnId));
    assert.equal(sessions.checks.length, before, 'the door started no check');
    const row = await mergeRow(sql, parent.id);
    assert.equal(row.merge_status, 'conflict');
    assert.equal(row.owed_ms, null);
  });

  await t.test('S1 a runner without session-merge-recovery-v1 is not asked to check', async () => {
    const w = await world(db, 'old-runner', []);
    const recovery = conflictRecovery(new Date(Date.now() - HOUR));
    const parent = await parentSession(db, w, 'old-runner', { recovery });
    const repair = await childSession(db, w, parent.id, 'old-runner');
    const before = sessions.checks.length;
    await reply(api, w.runnerId, repair.id, repair.turnId, 'Committed the repair.');
    await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));
    assert.deepEqual((await sessions.outcomes()).slice(before), [{ id: parent.id, outcome: 'RUNNER_CANNOT_CHECK' }]);
    const row = await mergeRow(sql, parent.id);
    assert.equal(row.merge_status, 'conflict', 'no preview queued');
    assert.equal(row.owed_ms, null);
    assert.deepEqual(await realtime.drainMergeRequests(w.runnerId, randomUUID(), false), []);
  });

  await t.test('S1 the parent\'s detail carries the repair session\'s lastTurnAt, finishedAt and last reply, and tells its check from another merge operation', async () => {
    const w = await world(db, 'detail');
    const parent = await parentSession(db, w, 'detail', { recovery: conflictRecovery(new Date(Date.now() - HOUR)) });
    const repair = await childSession(db, w, parent.id, 'detail');
    // A question longer than the excerpt, in characters outside the BMP, so a clip by UTF-16 unit would
    // split one: the excerpt is the first 200 code points, as the session list's preview is.
    const question = `Should the repair keep ${'🔧'.repeat(250)} both sides?`;
    await reply(api, w.runnerId, repair.id, repair.turnId, question);
    await api.turnComplete({ id: w.runnerId }, repair.id, completed(repair.turnId));
    await sessions.outcomes();

    const waiting = await sessions.get(w.ownerId, parent.id);
    const row = waiting.mergeRepairSession as unknown as Record<string, unknown>;
    assert.equal(row.id, repair.id);
    assert.equal(row.runState, 'AWAITING_INPUT');
    assert.ok(row.lastTurnAt instanceof Date, 'when its turn last ended');
    assert.equal(row.finishedAt, null, 'not finished: it waits for a reply');
    assert.equal(row.lastAssistantText, [...question].slice(0, 200).join(''));
    assert.equal([...(row.lastAssistantText as string)].length, 200);
    // A check in flight is a pending PREVIEW.
    assert.equal(waiting.mergeStatus, 'pending');
    assert.equal(waiting.mergeRecoveryAction, 'preview');

    // The check comes back with a candidate, and the owner applies it: another operation in flight,
    // and the detail says which.
    const leaseOwner = randomUUID();
    const [command] = await realtime.drainMergeRequests(w.runnerId, leaseOwner, true);
    const ready: MergeRecovery = {
      ...command.recovery!, code: 'READY', candidateSha: 'd'.repeat(40), candidateTreeSha: 'e'.repeat(40),
      patch: 'complete candidate diff', check: { status: 'unconfigured' }, conflicts: [], checkedAt: rfc3339(new Date()),
    };
    await api.mergeResult({ id: w.runnerId }, parent.id, {
      status: 'error', operationId: command.operationId, leaseOwner, sourceSha: ready.sourceSha, targetBranch: 'main', recovery: ready,
    });
    await sessions.mergeToMain(w.ownerId, parent.id, 'main', undefined, { recoveryAction: 'apply', previewId: ready.previewId });
    const applying = await sessions.get(w.ownerId, parent.id);
    assert.equal(applying.mergeStatus, 'pending');
    assert.equal(applying.mergeRecoveryAction, 'apply');

    // The repair session ends while idle: finishedAt is set, and an end with no turn running is no
    // turn's end, so it starts no second check of the same turn.
    const before = sessions.checks.length;
    await api.finalize({ id: w.runnerId }, repair.id, { status: SharedRunStatus.SUCCEEDED } as never);
    assert.equal(sessions.checks.length, before, 'an idle repair session\'s end checks nothing');
    const ended = (await sessions.get(w.ownerId, parent.id)).mergeRepairSession as unknown as Record<string, unknown>;
    assert.ok(ended.finishedAt instanceof Date, 'when it finished');
    assert.ok(ended.lastTurnAt instanceof Date);
    assert.equal(ended.lastAssistantText, row.lastAssistantText);
  });

  await t.test('S1 a repair turn that fails or is stopped, or a repair session finalized mid-turn, queues the check too', async () => {
    const endings: Array<[string, (api: RunnerApiController, w: World, repair: { id: string; turnId: string }) => Promise<unknown>]> = [
      ['failed', (a, w, r) => a.turnComplete({ id: w.runnerId }, r.id, completed(r.turnId, { status: SharedRunStatus.FAILED, error: 'the model refused' }))],
      ['stopped', (a, w, r) => a.turnComplete({ id: w.runnerId }, r.id, completed(r.turnId, { status: SharedRunStatus.INTERRUPTED }))],
      ['finalized', (a, w, r) => a.finalize({ id: w.runnerId }, r.id, { status: SharedRunStatus.FAILED, error: 'the engine exited' } as never)],
    ];
    for (const [label, end] of endings) {
      const w = await world(db, `ending-${label}`);
      const parent = await parentSession(db, w, `ending-${label}`, { recovery: conflictRecovery(new Date(Date.now() - HOUR)) });
      const repair = await childSession(db, w, parent.id, `ending-${label}`);
      const before = sessions.checks.length;
      await reply(api, w.runnerId, repair.id, repair.turnId, 'Halfway through the replay.');
      await end(api, w, repair);
      assert.deepEqual((await sessions.outcomes()).slice(before), [{ id: parent.id, outcome: 'QUEUED' }], label);
      const row = await mergeRow(sql, parent.id);
      assert.equal(row.merge_status, 'pending', label);
      assert.equal(row.merge_recovery_action, 'preview', label);
    }
  });
});
