/**
 * A CURSOR CLI ACCOUNT'S USAGE LIMIT: WHEN THE RUN IS RETRIED, AND WHAT IS HELD BACK UNTIL THEN.
 *
 * Cursor answers its usage limit with "Upgrade your plan to continue" and an ordinary end; the runner
 * reports it as the turn's error (runner cursor_events.go cursorTurnFailure). The sentence names no
 * reset, and Cursor's dashboard never says an account is spent, so the runner keeps that per account
 * (cursor_usage.go): planUsage.cursor carries each account's included usage — when it resets — and when a
 * turn on it met the limit (docs/cursor-runtime-contract.md §11). On real PostgreSQL (project P6a):
 *
 *   (1) A Cursor CLI turn that met the usage limit fails the run and arms its retry for when its
 *       account's included usage resets — read from the snapshot, which does not yet count this turn.
 *       No runner carries a Cursor CLI conversation to another account, so it stays where it is.
 *   (2) The account is the one the run spent: the one picked for it, a key in its workspace's env
 *       notwithstanding — and none for a run on that key, which arms nothing.
 *   (3) An account Cursor's dashboard has not answered for names no reset: nothing is armed.
 *   (4) A failure that is not the usage limit arms nothing.
 *   (5) A task's run waits the same way, and its task is told nothing meanwhile.
 *   (6) The retry sweep holds the re-send while the snapshot says the account is still spent, and sends
 *       it once its included usage has reset.
 *   (7) The heartbeat stores planUsage.cursor with each account's snapshot under its own id.
 *   (8) The task quota gate holds a Cursor CLI task on a spent account until it resets, sends one left
 *       to Automatic to the account with room, and is blind to an account it has no reset for.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/cursor-usage-limit.pg.spec.ts
 *
 * Production code throughout: RunnerApiController, AutoRetryService, storeHeartbeatPlanUsage and
 * TasksService. The re-send itself is stood in for (SessionsService.resume is the sweep's to call, not
 * this spec's to re-test), and the sweep reads only the sessions this spec made. Not destructive: every id
 * is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  AgentProvider,
  PermissionMode,
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
import { AutoRetryService } from '../sessions/auto-retry.service';
import type { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { storeHeartbeatPlanUsage } from './codex-reset-plan-usage';
import { RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const TEAM = 'c41e0b7a';
const DEFAULT_HOME = '/root/.orbit/cursor/default';
const TEAM_HOME = '/root/.orbit/cursor-accounts/c41e0b7a';
/** Far enough out that the real clock still finds both resets ahead of it. */
const DEFAULT_RESET = '2099-01-01T08:00:00.000Z';
const TEAM_RESET = '2099-01-03T08:00:00.000Z';
/** What the runner reports a turn Cursor ended on its usage limit with (cursorUsageLimitText). */
const CURSOR_USAGE_LIMIT = `You've hit your usage limit on Cursor. Cursor said: "Upgrade your plan to continue."`;
/** What every runner that runs Cursor CLI sessions declares (P1); none declares cursor-account-move/v1. */
const RUNS_CURSOR = ['provider:cursor'];

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: DEFAULT_HOME, auth: 'yes' },
      { id: TEAM, name: 'Team', home: TEAM_HOME, auth: 'yes' },
    ],
  },
];

/** Default's included usage resetting at DEFAULT_RESET and Team's at TEAM_RESET — Default's left out when
 *  the dashboard has not answered for it — with when a turn met the limit, per account. */
const usage = (opts: { defaultRead?: boolean; defaultReset?: string; spent?: { default?: string; team?: string } } = {}): PlanUsage => ({
  cursor: {
    provider: AgentProvider.CURSOR,
    ...(opts.defaultRead === false
      ? {}
      : {
          account: 'default',
          planName: 'Free',
          includedUsage: {
            startsAt: '2026-01-01T08:00:00.000Z',
            resetsAt: opts.defaultReset ?? DEFAULT_RESET,
            ...(opts.spent?.default ? { limitReachedAt: opts.spent.default } : {}),
          },
        }),
    accounts: {
      [TEAM]: {
        provider: AgentProvider.CURSOR,
        account: TEAM,
        planName: 'Premium',
        includedUsage: {
          period: 'weekly',
          startsAt: '2026-01-01T08:00:00.000Z',
          resetsAt: TEAM_RESET,
          percentUsed: 34,
          ...(opts.spent?.team ? { limitReachedAt: opts.spent.team } : {}),
        },
      },
    },
  },
});

const quiet = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  taskId: string | null;
}

test('P6a a Cursor CLI account’s usage limit on PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
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
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /**
   * One owner, a runner with Default and Team signed in to Cursor CLI and `planUsage` as its snapshot, and
   * a built-in Cursor CLI session that has said something — RUNNING with a turn out on delivery, on the
   * account `account` names, in a workspace whose env is `env`; a task's run when `task` is set.
   */
  async function fixture(
    label: string,
    opts: { planUsage?: PlanUsage; account?: string; env?: Record<string, string>; task?: boolean } = {},
  ): Promise<Fixture> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@cursor-usage-limit.invalid`, name: 'The owner', passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: RUNS_CURSOR,
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
        engines: ENGINES as unknown as Prisma.InputJsonValue,
        planUsage: (opts.planUsage ?? usage()) as unknown as Prisma.InputJsonValue,
      },
    });
    await db.workspace.create({
      data: {
        id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true,
        ...(opts.env ? { env: opts.env as Prisma.InputJsonValue } : {}),
      },
    });
    const taskId = opts.task ? randomUUID() : null;
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
        provider: AgentProvider.CURSOR,
        providerBuiltin: true,
        engine: AgentProvider.CURSOR,
        model: 'default[]',
        permissionMode: PermissionMode.ACCEPT_EDITS,
        cursorAccount: opts.account ?? 'default',
        status: RunStatus.RUNNING,
        engineTurnActive: true,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
        numTurns: 3,
      },
    });
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
    return { ownerId, runnerId, workspaceId, sessionId, turnId: turn.id, taskId };
  }

  /** What the runner reports for a turn Cursor ended on its usage limit: nothing said, the limit its error. */
  const failed = (f: Fixture, error = CURSOR_USAGE_LIMIT) => ({
    turnId: f.turnId,
    status: SharedRunStatus.FAILED,
    subtype: 'error',
    result: '',
    error,
    numTurns: 1,
  });

  /** Read back over a second connection. `retry_at` is a timestamp without time zone holding UTC, which
   *  `pg` would read as local time: read as epoch. */
  async function row(sessionId: string) {
    const r = await sql.query(
      `SELECT status, cursor_account, pool_switch_notice, error, retry_attempts,
              (EXTRACT(EPOCH FROM retry_at) * 1000)::float8 AS retry_ms
         FROM "session" WHERE id = $1::uuid`,
      [sessionId],
    );
    const { retry_ms, ...rest } = r.rows[0] as {
      status: string;
      cursor_account: string | null;
      pool_switch_notice: string | null;
      error: string | null;
      retry_attempts: number;
      retry_ms: number | null;
    };
    return { ...rest, retry_at: retry_ms === null ? null : new Date(retry_ms) };
  }
  const withinJitterOf = (at: Date | null, reset: string) =>
    !!at && at.getTime() >= Date.parse(reset) && at.getTime() < Date.parse(reset) + 60_000;

  await t.test('P6a a Cursor CLI turn that met the usage limit is retried when its account’s included usage resets', async () => {
    const f = await fixture('resets');
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED, 'the turn failed, and so did this run of the session');
    assert.equal(after.error, CURSOR_USAGE_LIMIT);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
    // No runner carries a Cursor CLI conversation to another account yet, Team's room notwithstanding.
    assert.equal(after.cursor_account, 'default');
    assert.equal(after.pool_switch_notice, null);
  });

  await t.test('P6a the retry waits for the reset of the account the run spent, a key of its workspace’s notwithstanding', async () => {
    // On Team, picked for it: Team's reset, though its workspace sets a key — the runner runs it on
    // Team's login in the key's place (contract §16.3).
    const onTeam = await fixture('on-team', { account: TEAM, env: { CURSOR_API_KEY: 'key-of-the-workspace' } });
    await api.turnComplete({ id: onTeam.runnerId }, onTeam.sessionId, failed(onTeam));
    const team = await row(onTeam.sessionId);
    assert.ok(withinJitterOf(team.retry_at, TEAM_RESET), `not armed for Team's reset: ${team.retry_at?.toISOString()}`);
    assert.equal(team.cursor_account, TEAM);
    // On that key, no account picked: it spent no account of the runner's, which says nothing of when.
    const onKey = await fixture('on-key', { account: 'default', env: { CURSOR_API_KEY: 'key-of-the-workspace' } });
    await api.turnComplete({ id: onKey.runnerId }, onKey.sessionId, failed(onKey));
    const key = await row(onKey.sessionId);
    assert.equal(key.status, RunStatus.FAILED);
    assert.equal(key.error, CURSOR_USAGE_LIMIT);
    assert.equal(key.retry_at, null, 'a run on a key of its own was armed from an account it never spent');
  });

  await t.test('P6a an account Cursor’s dashboard has not answered for arms no retry', async () => {
    const f = await fixture('unread', { planUsage: usage({ defaultRead: false }) });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED);
    assert.equal(after.error, CURSOR_USAGE_LIMIT, 'the card still says what happened, and offers a manual retry');
    assert.equal(after.retry_at, null, 'armed with no reset to go by');
    // A reset already behind the snapshot is none either.
    const stale = await fixture('stale', { planUsage: usage({ defaultReset: '2026-01-08T08:00:00.000Z' }) });
    await api.turnComplete({ id: stale.runnerId }, stale.sessionId, failed(stale));
    assert.equal((await row(stale.sessionId)).retry_at, null);
  });

  await t.test('P6a a Cursor CLI failure that is not the usage limit arms nothing', async () => {
    const f = await fixture('other-failure');
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f, 'Cursor CLI failed this turn: Error: ConnectError: [unavailable] read ECONNRESET'));
    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED);
    assert.equal(after.retry_at, null);
  });

  await t.test('P6a a task’s run that met the usage limit waits for the reset, its task told nothing meanwhile', async () => {
    const f = await fixture('task', { task: true });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
    assert.equal(await db.taskComment.count({ where: { taskId: f.taskId! } }), 0, 'a failure note beside a run that is going on');
    const task = await db.task.findUniqueOrThrow({ where: { id: f.taskId! }, select: { status: true } });
    assert.equal(task.status, 'OPEN', 'the task was reclaimed under a run that will go on');
  });

  await t.test('P6a the retry is held while the account is still spent, and sent once its included usage has reset', async () => {
    const now = new Date();
    const reset = new Date(now.getTime() + 60 * 60_000).toISOString();
    // The runner has seen the turn by now: Default met its limit a minute ago, until `reset`.
    const f = await fixture('sweep', {
      planUsage: usage({ defaultReset: reset, spent: { default: new Date(now.getTime() - 60_000).toISOString() } }),
    });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    assert.ok(withinJitterOf((await row(f.sessionId)).retry_at, reset));
    // The sweep, reading only this session; the re-send is recorded rather than made.
    const resent: string[] = [];
    const mine = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'session') return Reflect.get(target, prop, receiver);
        const sessions = target.session;
        return new Proxy(sessions, {
          get(s, p, r) {
            if (p !== 'findMany') return Reflect.get(s, p, r);
            return (args: Prisma.SessionFindManyArgs) =>
              s.findMany({ ...args, where: { AND: [args.where ?? {}, { id: f.sessionId }] } });
          },
        });
      },
    }) as unknown as PrismaService;
    const resume = {
      resume: async (_owner: string, id: string) => {
        resent.push(id);
        return { turnId: randomUUID(), seq: 2 };
      },
    } as unknown as SessionsService;
    const sweeper = new AutoRetryService(mine, resume, quiet);

    // Due early — armed, say, from an older reading — while the snapshot still says spent: held, re-armed
    // for the reset, and no attempt spent.
    await sql.query(`UPDATE "session" SET retry_at = $2::timestamp WHERE id = $1::uuid`,
      [f.sessionId, new Date(now.getTime() - 1_000).toISOString().replace('Z', '')]);
    await sweeper.sweep(now);
    const held = await row(f.sessionId);
    assert.deepEqual(resent, [], 'a re-send against an account known to be spent');
    assert.equal(held.retry_attempts, 0, 'a deferral is not a failed attempt');
    assert.equal(held.retry_at?.toISOString(), reset, 're-armed for the reset');

    // The reset has passed, and the runner's next reading is of the new period: sent.
    await db.runner.update({
      where: { id: f.runnerId },
      data: { planUsage: usage({ defaultReset: new Date(now.getTime() + 7 * 86_400_000).toISOString() }) as unknown as Prisma.InputJsonValue },
    });
    await sql.query(`UPDATE "session" SET retry_at = $2::timestamp WHERE id = $1::uuid`,
      [f.sessionId, new Date(now.getTime() - 1_000).toISOString().replace('Z', '')]);
    await sweeper.sweep(now);
    assert.deepEqual(resent, [f.sessionId], 'the retry did not go once the account had its usage back');
  });

  await t.test('P6a the heartbeat stores planUsage.cursor with each account’s snapshot under its own id', async () => {
    const f = await fixture('heartbeat');
    const reported = usage({ spent: { team: '2098-12-31T08:00:00.000Z' } });
    const incoming: PlanUsage = {
      ...reported,
      cursor: { ...reported.cursor, accounts: { ...reported.cursor!.accounts, c0ffee42: { provider: AgentProvider.CURSOR, account: TEAM } } },
    };
    assert.equal(await storeHeartbeatPlanUsage(prisma, f.runnerId, incoming, null), true);
    const stored = (await db.runner.findUniqueOrThrow({ where: { id: f.runnerId }, select: { planUsage: true } })).planUsage as PlanUsage;
    assert.deepEqual(stored.cursor, reported.cursor, 'an entry naming another account than its key was stored');
  });

  await t.test('P6a the task quota gate holds a Cursor CLI task on a spent account until it resets, and Automatic sends one to the account with room', async () => {
    type Assignee = { provider: string; login: boolean; runnerId: string; workspaceId: string };
    const gate = new TasksService(prisma, {} as never, quiet) as unknown as {
      quotaGate(tasks: Array<{ id: string; ownerId: string; assignee: Assignee }>): Promise<{ blocked: Map<string, Date>; blind: Set<string> }>;
    };
    const on = (f: Fixture) => ({ id: f.sessionId, ownerId: f.ownerId, assignee: { provider: AgentProvider.CURSOR, login: true, runnerId: f.runnerId, workspaceId: f.workspaceId } });
    const spent = usage({ spent: { default: '2098-12-31T08:00:00.000Z' } });
    // Left to Automatic: Team has room, so that is where the task's session starts and what it waits on.
    const automatic = await fixture('gate-automatic', { planUsage: spent });
    // A workspace pinned to Default waits for Default's reset.
    const pinned = await fixture('gate-pinned', { planUsage: spent });
    await db.workspace.update({ where: { id: pinned.workspaceId }, data: { cursorAccount: 'default' } });
    // An account the dashboard has not answered for: nothing to judge by, so the blind brake applies.
    const unread = await fixture('gate-unread', { planUsage: usage({ defaultRead: false }) });
    await db.workspace.update({ where: { id: unread.workspaceId }, data: { cursorAccount: 'default' } });
    const { blocked, blind } = await gate.quotaGate([on(automatic), on(pinned), on(unread)]);
    assert.deepEqual([...blocked.entries()].map(([id, at]) => [id, at.toISOString()]), [[pinned.sessionId, DEFAULT_RESET]]);
    assert.deepEqual([...blind], [unread.sessionId]);
  });
});
