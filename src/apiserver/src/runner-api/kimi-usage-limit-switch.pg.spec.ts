/**
 * A KIMI SESSION THAT HAS SAID SOMETHING MOVES TO ANOTHER KIMI ACCOUNT — ON A RUNNER THAT CARRIES ITS
 * CONVERSATION THERE (kimi-account-move/v1), AND ONLY THERE.
 *
 * A Kimi conversation lives in its account's KIMI_CODE_HOME; a runner that declares kimi-account-move/v1
 * carries it into the home the session's claim names before it resumes (runner kimi_account_move.go).
 * Kimi's ACP answers a turn its account's usage limit ended as an ordinary end and says nothing of why;
 * that runner reads the limit from the turn's own record and reports it as the turn's error, in the
 * words below (runner kimi_acp.go kimiTurnUsageLimit, pinned to them by kimi_account_move_test.go). On
 * real PostgreSQL:
 *
 *   (1) Moved by hand: a runner that carries the conversation moves it and re-spawns its engine in
 *       Work's home; one that does not refuses in the words every engine's move is refused in, and
 *       writes nothing.
 *   (2) Before a turn is dispatched: a session on Automatic whose account the snapshot already reports
 *       spent is claimed onto Work on a runner that carries it, and stays on a runner that does not.
 *   (3) Stopped mid-turn by the usage limit, on Automatic, on a runner that carries it, with Work's
 *       quota to spare: the session moves to Work and is re-sent at once; the re-send is claimed with
 *       Work's KIMI_CODE_HOME, and the engine it starts says why it switched, once.
 *   (4) The same on a runner that does not carry it: the session stays, re-sent at its account's reset.
 *   (5) A workspace pinned to Default, or an account picked by hand, keeps the session; so does every
 *       other account being spent too. Each waits for its own reset.
 *   (6) A failure that is not the usage limit arms nothing and moves nothing.
 *   (7) A task's run moves the same way, and its task is told nothing while the re-send is on its way.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/kimi-usage-limit-switch.pg.spec.ts
 *
 * Production code throughout: RunnerApiController, SessionsService, QueueService. Not destructive:
 * every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  RunEventType,
  RunStatus as SharedRunStatus,
  type PlanUsage,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import { QueueService as RealQueueService } from '../queue/queue.service';
import { SessionsService } from '../sessions/sessions.service';
import { KIMI_ACCOUNT_MOVE_V1, RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = 'c41e0b7a';
const DEFAULT_HOME = '/root/.kimi-code';
const WORK_HOME = '/root/.orbit/kimi-accounts/c41e0b7a';
/** Far enough out that the real clock still finds both resets ahead of it. */
const DEFAULT_RESET = '2099-01-01T08:00:00Z';
const WORK_RESET = '2099-01-03T08:00:00Z';
/** What a runner that declares kimi-account-move/v1 reports a turn Kimi ended on its usage limit with:
 *  its sentence, then Kimi's own message from the turn's record (kimi 2.1.1, a 429
 *  exceeded_current_quota_error). */
const KIMI_USAGE_LIMIT =
  "You've hit your usage limit on this Kimi Code account — 429 You exceeded your current token quota: 0 1000000, please check your account balance";
/** What every runner too old to carry a conversation to another account is told, whatever the engine. */
const CANNOT_MOVE =
  "this session's runner cannot move a conversation to another account yet — it updates itself when no turn is running";

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'kimi',
    installed: true,
    auth: 'yes',
    kimiRegion: 'mainland-cn',
    accounts: [
      { id: 'default', home: DEFAULT_HOME, auth: 'yes', kimiRegion: 'mainland-cn' },
      { id: WORK, name: 'Work', home: WORK_HOME, auth: 'yes', kimiRegion: 'global' },
    ],
  },
];

/** Default's coding month spent; Work's five hours at `workUsed`%. */
const usage = (workUsed: number): PlanUsage => ({
  kimi: {
    provider: AgentProvider.KIMI,
    fiveHour: { utilization: 3, resetsAt: '2099-01-01T05:00:00Z' },
    monthCode: { utilization: 100, resetsAt: DEFAULT_RESET },
    accounts: {
      [WORK]: { provider: AgentProvider.KIMI, fiveHour: { utilization: workUsed, resetsAt: WORK_RESET } },
    },
  },
});

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

/** The production wiring, over one client and with no seam in the paths under test. */
function connect(url: string) {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const api = new RunnerApiController(
    prisma,
    queue,
    quiet,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  const sessions = new SessionsService(prisma, queue, quiet);
  const claims = new RealQueueService(prisma, quiet, new ProviderPlanUsageService(quiet));
  return { db, api, sessions, claims };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  sessionId: string;
  turnId: string;
  taskId: string | null;
}

/**
 * One owner, a runner with Default and Work signed in to Kimi Code, and a built-in Kimi session on
 * Default that has said something — RUNNING with a turn out on delivery unless `status` says otherwise,
 * a task's run when `task` is set. `inbox_lease_owner` is left null so the turn-complete lease check
 * passes with no token, as codex-usage-limit-switch.pg.spec.ts builds it.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  {
    workspaceAccount = null,
    workUsed = 3,
    capabilities = [KIMI_ACCOUNT_MOVE_V1],
    pinned = false,
    task = false,
    status = RunStatus.RUNNING,
  }: {
    workspaceAccount?: string | null;
    workUsed?: number;
    capabilities?: string[];
    pinned?: boolean;
    task?: boolean;
    status?: RunStatus;
  } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@kimi-usage-limit.invalid`, name: 'The owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities,
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
      engines: ENGINES as unknown as Prisma.InputJsonValue,
      planUsage: usage(workUsed) as unknown as Prisma.InputJsonValue,
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, kimiAccount: workspaceAccount },
  });
  const taskId = task ? randomUUID() : null;
  if (taskId) {
    await db.task.create({
      data: {
        id: taskId,
        ownerId,
        assigneeId: workspaceId,
        title: `${label} task`,
        creatorType: 'AGENT',
        creatorId: workspaceId,
        status: 'OPEN',
        completionCriterion: 'EVIDENCE_JUDGMENT',
      } as never,
    });
  }
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      ...(taskId ? { taskId, startsTaskWork: true } : {}),
      title: `${label} session`,
      prompt: 'fix the flaky test',
      provider: AgentProvider.KIMI,
      providerBuiltin: true,
      kimiAccount: 'default',
      kimiAccountPinned: pinned,
      status,
      engineTurnActive: status === RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: `session_${randomUUID()}`,
      numTurns: 3,
    },
  });
  let turnId = '';
  if (status === RunStatus.RUNNING) {
    const turn = await db.conversationTurn.create({
      data: {
        sessionId,
        seq: 1,
        clientTurnId: `${label}-${randomUUID()}`,
        kind: 'message',
        content: 'and now the second one',
        status: 'IN_FLIGHT',
        deliveredAt: new Date(),
        leaseDeadlineAt: new Date(Date.now() + 300_000),
        leaseGeneration: randomUUID(),
      },
      select: { id: true },
    });
    turnId = turn.id;
  }
  return { ownerId, runnerId, sessionId, turnId, taskId };
}

/** What the runner reports for a turn Kimi ended on its usage limit: the turn said nothing, and the
 *  limit is the turn's error. */
const failed = (f: Fixture, error = KIMI_USAGE_LIMIT) => ({
  turnId: f.turnId,
  status: SharedRunStatus.FAILED,
  subtype: 'error',
  result: '',
  error,
  numTurns: 1,
  costUsd: 0,
});

test('a Kimi session that has said something moves to another Kimi account only on a runner that carries it', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { db, api, sessions, claims } = connect(url);
  const internals = api as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
      { kind: string; env?: Record<string, string> } | null
    >;
  };
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** Read back over a second connection, never through the answer that wrote it. `retry_at` is a
   *  timestamp without time zone holding UTC, which `pg` would read as local time: read as epoch. */
  async function row(sessionId: string) {
    const r = await sql.query(
      `SELECT status, kimi_account, kimi_account_pinned, pool_switch_notice, error,
              (EXTRACT(EPOCH FROM retry_at) * 1000)::float8 AS retry_ms
         FROM "session" WHERE id = $1::uuid`,
      [sessionId],
    );
    const { retry_ms, ...rest } = r.rows[0] as {
      status: string;
      kimi_account: string | null;
      kimi_account_pinned: boolean;
      pool_switch_notice: string | null;
      error: string | null;
      retry_ms: number | null;
    };
    return { ...rest, retry_at: retry_ms === null ? null : new Date(retry_ms) };
  }
  const withinJitterOf = (at: Date | null, reset: string) =>
    !!at && at.getTime() >= Date.parse(reset) && at.getTime() < Date.parse(reset) + 60_000;
  const reloads = async (id: string) =>
    (
      await sql.query(
        `SELECT content, status::text AS status FROM "conversation_turn" WHERE session_id = $1::uuid AND kind = 'reload' ORDER BY seq`,
        [id],
      )
    ).rows as Array<{ content: string; status: string }>;
  /** What the runner is handed when it claims its one PENDING session: that session's environment. */
  const claimedEnv = async (runnerId: string) => {
    const claimed = await claims.claimSessionForRunner({ id: runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    return claimed.agent.env ?? {};
  };

  await t.test('(1) moved by hand: on a runner that carries it, and refused in the usual words on one that does not', async () => {
    const carries = await fixture(db, 'by-hand', { status: RunStatus.AWAITING_INPUT });
    await sessions.switchAccount(carries.ownerId, carries.sessionId, WORK);
    const moved = await row(carries.sessionId);
    assert.deepEqual(
      { account: moved.kimi_account, pinned: moved.kimi_account_pinned, notice: moved.pool_switch_notice },
      { account: WORK, pinned: true, notice: 'Switched to Work' },
    );
    assert.deepEqual(await reloads(carries.sessionId), [{ content: JSON.stringify({ provider: 'kimi' }), status: 'PENDING' }]);
    const turn = await internals.dequeueTurn(carries.sessionId, carries.runnerId, null);
    assert.equal(turn?.kind, 'reload');
    assert.equal(turn?.env?.KIMI_CODE_HOME, WORK_HOME, "its engine is re-spawned in Work's home");

    const old = await fixture(db, 'by-hand-old', { status: RunStatus.AWAITING_INPUT, capabilities: [] });
    await assert.rejects(sessions.switchAccount(old.ownerId, old.sessionId, WORK), (err: { getStatus?: () => number; message?: string }) => {
      assert.equal(err.getStatus?.(), 409);
      assert.equal(err.message, CANNOT_MOVE);
      return true;
    });
    const stayed = await row(old.sessionId);
    assert.deepEqual(
      { account: stayed.kimi_account, pinned: stayed.kimi_account_pinned, notice: stayed.pool_switch_notice },
      { account: 'default', pinned: false, notice: null },
    );
    assert.deepEqual(await reloads(old.sessionId), []);
    // Nor to Automatic, which would move it off Default's spent month.
    await assert.rejects(sessions.switchAccount(old.ownerId, old.sessionId, 'automatic'), { message: CANNOT_MOVE });
    assert.equal((await row(old.sessionId)).kimi_account, 'default');
  });

  await t.test('(2) before a turn is dispatched, a session on a spent account is claimed onto Work only on a runner that carries it', async () => {
    const carries = await fixture(db, 'claim', { status: RunStatus.PENDING });
    assert.equal((await claimedEnv(carries.runnerId)).KIMI_CODE_HOME, WORK_HOME);
    const moved = await row(carries.sessionId);
    assert.equal(moved.kimi_account, WORK);
    assert.equal(moved.pool_switch_notice, 'Switched to Work — the usage limit on Default is reached');

    const old = await fixture(db, 'claim-old', { status: RunStatus.PENDING, capabilities: [] });
    assert.equal((await claimedEnv(old.runnerId)).KIMI_CODE_HOME, undefined, 'it is claimed on Default, where its conversation is');
    assert.equal((await row(old.sessionId)).kimi_account, 'default');
  });

  await t.test('(3) stopped mid-turn by the usage limit: it moves to Work, is re-sent now, claimed in Work’s home, and says why', async () => {
    const f = await fixture(db, 'moves');
    const before = Date.now();
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));

    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED, 'the turn failed, and so did this run of the session');
    assert.equal(after.error, KIMI_USAGE_LIMIT);
    assert.equal(after.kimi_account, WORK, 'the session moves to the account with room');
    assert.equal(after.kimi_account_pinned, false, 'it is still on Automatic');
    const line = 'Switched to Work — the usage limit on Default is reached';
    assert.equal(after.pool_switch_notice, line);
    assert.ok(after.retry_at, 'nothing re-sends it');
    assert.ok(after.retry_at.getTime() >= before - 1_000 && after.retry_at.getTime() <= Date.now() + 1_000,
      `the re-send is not now: ${after.retry_at.toISOString()}`);

    // The re-send revives the session (auto-retry, resume — stood in for by the state they leave), and
    // its claim hands the runner Work's home, which the runner carries the conversation into.
    await sql.query(
      `UPDATE "session" SET status = 'PENDING', cancel_requested_at = NULL, finished_at = NULL, retry_at = NULL
        WHERE id = $1::uuid`,
      [f.sessionId],
    );
    assert.equal((await claimedEnv(f.runnerId)).KIMI_CODE_HOME, WORK_HOME);
    // The engine that claim starts announces itself, and the line rides that, once.
    await sql.query(`UPDATE "session" SET status = 'RUNNING' WHERE id = $1::uuid`, [f.sessionId]);
    await api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 1,
        type: RunEventType.SYSTEM,
        ts: new Date().toISOString(),
        payload: { subtype: 'init', sessionId: `session_${randomUUID()}`, provider: 'kimi', runtime: 'acp' },
      }],
    });
    const [said] = await db.runEvent.findMany({ where: { sessionId: f.sessionId }, select: { payload: true } });
    assert.equal((said.payload as { notice?: string }).notice, line);
    assert.equal((await row(f.sessionId)).pool_switch_notice, null, 'the line is owed once');
  });

  await t.test('(4) on a runner that cannot carry the conversation it stays, re-sent at its account’s reset', async () => {
    const f = await fixture(db, 'old-runner', { capabilities: [] });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED);
    assert.equal(after.kimi_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
  });

  await t.test('(5) a workspace pinned to Default, an account picked by hand, or every account spent: it stays and waits', async () => {
    for (const [label, opts] of [
      ['workspace-pinned', { workspaceAccount: 'default' }],
      ['picked-by-hand', { pinned: true }],
      ['all-spent', { workUsed: 100 }],
    ] as const) {
      const f = await fixture(db, label, opts);
      await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
      const after = await row(f.sessionId);
      assert.equal(after.kimi_account, 'default', label);
      assert.equal(after.pool_switch_notice, null, label);
      assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `${label}: not armed for Default's reset: ${after.retry_at?.toISOString()}`);
    }
  });

  await t.test('(6) a failure that is not the usage limit arms nothing and moves nothing', async () => {
    const f = await fixture(db, 'other-failure');
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f, 'kimi acp closed'));
    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED);
    assert.equal(after.kimi_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.equal(after.retry_at, null);
  });

  await t.test('(7) a task’s run moves the same way, and its task is told nothing meanwhile', async () => {
    const f = await fixture(db, 'task-moves', { task: true });
    const before = Date.now();
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const moved = await row(f.sessionId);
    assert.equal(moved.kimi_account, WORK, 'a task’s run sat on the spent account beside one with room');
    assert.equal(moved.pool_switch_notice, 'Switched to Work — the usage limit on Default is reached');
    assert.ok(moved.retry_at && moved.retry_at.getTime() >= before - 1_000 && moved.retry_at.getTime() <= Date.now() + 1_000,
      `the re-send is not now: ${moved.retry_at?.toISOString()}`);
    assert.equal(await db.taskComment.count({ where: { taskId: f.taskId! } }), 0, 'a failure note beside a run that is going on');
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId! }, select: { status: true } });
    assert.equal(task.status, 'OPEN', 'the task was reclaimed under a run that is going on');
  });
});
