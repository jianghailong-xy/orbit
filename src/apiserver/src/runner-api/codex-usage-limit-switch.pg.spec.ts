/**
 * A CODEX SESSION ITS ACCOUNT'S USAGE LIMIT STOPS GOES ON — ON ANOTHER ACCOUNT, OR AT THE RESET.
 *
 * Codex reports a usage limit as the turn's error, never as a reply, so the events path — which reads
 * replies — never armed a retry for it: on 2026-09-29 five sessions on wikova's Default account ended
 * FAILED on "You’ve hit your usage limit" with `retry_at` null and stayed that way, while the runner's
 * second account had room. The failed turn's completion is where it is decided now:
 *
 *   (1) The workspace leaves the account to Orbit (Automatic) and another account has room: the
 *       session moves there — its account, and a transcript line owed to the next engine start — and
 *       is re-sent at once. The line rides the `init` the new engine announces itself with, once.
 *   (2) The workspace is pinned to the account: the session stays, and is re-sent at that account's
 *       reset.
 *   (3) Every other account is spent too: moving gains nothing, so it waits for its own reset.
 *   (4) A failure that is not a usage limit arms nothing and moves nothing.
 *   (5) A runner too old to carry a thread to another account (no codex-account-move/v1) would resume
 *       the session where its thread is, whatever the claim said: it is not moved, and waits.
 *   (6) An account somebody picked for the session by hand is where it stays: it waits for the reset.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/codex-usage-limit-switch.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
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
import { CODEX_ACCOUNT_MOVE_V1, RunnerApiController } from './runner-api.controller';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const WORK = '3fa91c2e';
const WORK_HOME = '/root/.orbit/codex-accounts/3fa91c2e';
/** Far enough out that the real clock still finds both resets ahead of it. */
const DEFAULT_RESET = '2099-01-01T08:00:00Z';
const WORK_RESET = '2099-01-03T08:00:00Z';
/** Codex's own words, curly apostrophe and all, as they reached `session.error` that day. */
const USAGE_LIMIT =
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:00 AM.';

const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.codex', codexHome: '/root/.codex', auth: 'yes' },
      { id: WORK, name: 'Work', home: WORK_HOME, codexHome: WORK_HOME, auth: 'yes' },
    ],
  },
];

/** Default a Plus login whose 5-hour window is spent; Work reporting a weekly window at `workUsed`%. */
const usage = (workUsed: number): PlanUsage => ({
  codex: {
    provider: AgentProvider.CODEX,
    primary: { utilization: 100, windowDurationMins: 300, resetsAt: DEFAULT_RESET },
    secondary: { utilization: 18, windowDurationMins: 10080, resetsAt: WORK_RESET },
    accounts: { [WORK]: { provider: AgentProvider.CODEX, primary: { utilization: workUsed, windowDurationMins: 10080, resetsAt: WORK_RESET } } },
  },
});

/** The production wiring, over one client and with no seam in the path under test. */
function connect(url: string): { db: PrismaClient; api: RunnerApiController } {
  const db = prismaClientFor(url);
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  return {
    db,
    api: new RunnerApiController(
      db as unknown as PrismaService,
      queue,
      realtime,
      {} as never,
      {} as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    ),
  };
}

interface Fixture {
  runnerId: string;
  sessionId: string;
  turnId: string;
}

/**
 * One owner, a runner with Default and Work signed in, and a Codex session on Default RUNNING with a
 * turn out on delivery. `inbox_lease_owner` is left null so the turn-complete lease check passes with
 * no token, as turn-complete-unanswered.pg.spec.ts builds it.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  {
    workspaceAccount = null,
    workUsed = 3,
    capabilities = [CODEX_ACCOUNT_MOVE_V1],
    pinned = false,
  }: { workspaceAccount?: string | null; workUsed?: number; capabilities?: string[]; pinned?: boolean } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@usage-limit.invalid`, name: 'The owner', passwordHash: 'x' },
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
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, codexAccount: workspaceAccount },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `${label} session`,
      prompt: 'fix the flaky test',
      provider: 'codex',
      codexAccount: 'default',
      codexAccountPinned: pinned,
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
  return { runnerId, sessionId, turnId: turn.id };
}

/** What the runner reports for a turn Codex ended on its usage limit (codex_appserver.go). */
const failed = (f: Fixture, result = USAGE_LIMIT) => ({
  turnId: f.turnId,
  status: SharedRunStatus.FAILED,
  subtype: 'failed',
  result,
  numTurns: 1,
  costUsd: 0,
});

test('a Codex session its account’s usage limit stopped goes on — on another account, or at the reset', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { db, api } = connect(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  /** Read back over a second connection, never through the answer that wrote it. `retry_at` is a
   *  timestamp without time zone holding UTC, which `pg` would read as local time: read as epoch. */
  async function row(sessionId: string) {
    const r = await sql.query(
      `SELECT status, codex_account, pool_switch_notice, error,
              (EXTRACT(EPOCH FROM retry_at) * 1000)::float8 AS retry_ms
         FROM "session" WHERE id = $1::uuid`,
      [sessionId],
    );
    const { retry_ms, ...rest } = r.rows[0] as {
      status: string;
      codex_account: string | null;
      pool_switch_notice: string | null;
      error: string | null;
      retry_ms: number | null;
    };
    return { ...rest, retry_at: retry_ms === null ? null : new Date(retry_ms) };
  }
  const withinJitterOf = (at: Date | null, reset: string) =>
    !!at && at.getTime() >= Date.parse(reset) && at.getTime() < Date.parse(reset) + 60_000;

  await t.test('(1) Automatic, and Work has room: it moves to Work, is re-sent now, and the next engine start says why', async () => {
    const f = await fixture(db, 'moves');
    const before = Date.now();
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));

    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED, 'the turn failed, and so did this run of the session');
    assert.equal(after.codex_account, WORK, 'the session moves to the account with room');
    const line = 'Switched to Work — the usage limit on Default is reached';
    assert.equal(after.pool_switch_notice, line);
    assert.ok(after.retry_at, 'nothing re-sends it');
    assert.ok(after.retry_at.getTime() >= before - 1_000 && after.retry_at.getTime() <= Date.now() + 1_000,
      `the re-send is not now: ${after.retry_at.toISOString()}`);

    // The re-send revives the session and a claim hands it to the runner (auto-retry, resume, claim —
    // not what this file is about, so stood in for by the state they leave). The engine that claim
    // starts announces itself, and the line rides that, once.
    await sql.query(
      `UPDATE "session" SET status = 'RUNNING', cancel_requested_at = NULL, finished_at = NULL, retry_at = NULL
        WHERE id = $1::uuid`,
      [f.sessionId],
    );
    await api.events({ id: f.runnerId }, f.sessionId, {
      events: [{
        seq: 1,
        type: RunEventType.SYSTEM,
        ts: new Date().toISOString(),
        payload: { subtype: 'init', sessionId: randomUUID(), provider: 'codex', runtime: 'app-server' },
      }],
    });
    const [said] = await db.runEvent.findMany({ where: { sessionId: f.sessionId }, select: { payload: true } });
    assert.equal((said.payload as { notice?: string }).notice, line);
    assert.equal((await row(f.sessionId)).pool_switch_notice, null, 'the line is owed once');
  });

  await t.test('(2) a workspace pinned to Default keeps the session there, re-sent at Default’s reset', async () => {
    const f = await fixture(db, 'pinned', { workspaceAccount: 'default' });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.codex_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
  });

  await t.test('(3) with Work spent too, moving gains nothing: it waits for its own reset', async () => {
    const f = await fixture(db, 'all-spent', { workUsed: 100 });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.codex_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
  });

  await t.test('(4) a failure that is not a usage limit arms nothing and moves nothing', async () => {
    const f = await fixture(db, 'other-failure');
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f, 'stream disconnected before completion'));
    const after = await row(f.sessionId);
    assert.equal(after.status, RunStatus.FAILED);
    assert.equal(after.codex_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.equal(after.retry_at, null);
  });

  await t.test('(5) a runner that cannot carry the thread keeps the session where it is, re-sent at the reset', async () => {
    const f = await fixture(db, 'old-runner', { capabilities: [] });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.codex_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
  });

  await t.test('(6) an account picked by hand keeps the session, re-sent at its reset', async () => {
    const f = await fixture(db, 'pinned', { pinned: true });
    await api.turnComplete({ id: f.runnerId }, f.sessionId, failed(f));
    const after = await row(f.sessionId);
    assert.equal(after.codex_account, 'default');
    assert.equal(after.pool_switch_notice, null);
    assert.ok(withinJitterOf(after.retry_at, DEFAULT_RESET), `not armed for Default's reset: ${after.retry_at?.toISOString()}`);
  });
});
