/**
 * An inbox fetch that says its runner is draining for an update (`draining=1`, docs/runner-update-drain-design.md
 * §7.1–§7.2) held against the production apiserver — `build/main.js`, the whole AppModule, run as a child process —
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/inbox-draining.pg.spec.ts
 *
 * A runner is played over its own door with its token. Against one server:
 *
 *   1. a draining fetch hands out interrupt, end, diff, withdraw, setconfig and a steer into the running turn;
 *   2. a draining fetch hands out no PENDING message, shell or reload, and puts nothing back in the queue: the
 *      session keeps its status and its inbox lease;
 *   3. a draining fetch hands out the expired-lease redelivery of a running message or shell turn;
 *   4. a fetch without the field hands out what the draining fetch held, as it always has.
 *
 * Not destructive: every row belongs to an account this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { SESSION_CLAUDE_STEER_WITHDRAW_V1, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const RUNNER_TOKEN = `inbox-draining-runner-${randomUUID()}`;

test('a draining inbox fetch hands out control turns and running work, and no new message, shell or reload', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const beats = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await beats.connect();
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  let beating: ReturnType<typeof setInterval> | undefined;
  t.after(async () => {
    if (beating) clearInterval(beating);
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await beats.end().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
    [ownerId, `owner-${RUN}@inbox-draining.invalid`, 'owner', hashPassword(`pw-${RUN}`)]);
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'the machine draining for an update', tokenHash: sha256(RUNNER_TOKEN),
      maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(),
    },
  });
  // The reaper ends a RUNNING session whose runner stopped heartbeating. This one stays online the whole run.
  const beat = () =>
    beats.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId])
      .catch(() => undefined);
  await beat();
  beating = setInterval(() => void beat(), 3_000);
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: 'the checkout these sessions run in', enabled: true,
      workDir: mkdtempSync(path.join(tmpdir(), 'inbox-draining-')),
    },
  });

  type Lease = { owner: string; generation: string };
  /** A Claude session on the machine, its inbox held by the engine process `lease` names. */
  async function session(status: RunStatus, extra: Record<string, unknown> = {}): Promise<{ id: string; lease: Lease }> {
    const id = randomUUID();
    const lease = { owner: randomUUID(), generation: randomUUID() };
    await prisma.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
        title: `inbox draining ${status.toLowerCase()}`, prompt: 'the work', provider: 'claude', engine: 'claude',
        turnState: turnStateOfWord(status), dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
        inboxLeaseOwner: lease.owner, inboxLeaseGeneration: lease.generation,
        ...extra,
      },
    });
    await sql.query(
      `INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [lease.generation, id, lease.owner],
    );
    return { id, lease };
  }
  const seqs = new Map<string, number>();
  /** A turn queued on `sessionId`, the next in its order. */
  async function turn(sessionId: string, kind: string): Promise<string> {
    const id = randomUUID();
    const seq = (seqs.get(sessionId) ?? 0) + 1;
    seqs.set(sessionId, seq);
    await prisma.conversationTurn.create({
      data: {
        id, sessionId, seq, clientTurnId: randomUUID(), kind, status: 'PENDING',
        content: kind === 'reload' || kind === 'setconfig' ? '{"model":"claude-sonnet-5-5"}' : `${kind} ${seq}`,
      },
    });
    return id;
  }
  /** Marks `turnId` handed to the process of `generation`, its lease live or (`expired`) run out. */
  const inFlight = (turnId: string, generation: string, expired = false) => sql.query(
    `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now() - interval '90 seconds',
            "lease_deadline_at" = now() + ${expired ? `interval '-30 seconds'` : `interval '5 minutes'`},
            "lease_generation" = $2::uuid
      WHERE "id" = $1::uuid`,
    [turnId, generation],
  );

  // A turn running on a live lease, and behind it every control turn and a follow-up message.
  const busy = await session(RunStatus.RUNNING);
  const busyTurn = await turn(busy.id, 'message');
  await inFlight(busyTurn, busy.lease.generation);
  const interrupt = await turn(busy.id, 'interrupt');
  const end = await turn(busy.id, 'end');
  const diff = await turn(busy.id, 'diff');
  const setconfig = await turn(busy.id, 'setconfig');
  const steer = await turn(busy.id, 'steer');
  const withdraw = await turn(busy.id, 'withdraw');
  const busyFollowUp = await turn(busy.id, 'message');
  // Runs holding a slot with nothing in flight and their next message or shell queued.
  const waitingMessage = await session(RunStatus.RUNNING);
  const heldMessage = await turn(waitingMessage.id, 'message');
  const waitingShell = await session(RunStatus.RUNNING);
  const heldShell = await turn(waitingShell.id, 'shell');
  // A resident engine between turns, with a reload queued for it.
  const idle = await session(RunStatus.AWAITING_INPUT, { numTurns: 1 });
  const heldReload = await turn(idle.id, 'reload');
  // Turns already running whose process stopped renewing them: the process that replaced it fetches.
  const replacedMessage = await session(RunStatus.RUNNING);
  const runningMessage = await turn(replacedMessage.id, 'message');
  await inFlight(runningMessage, randomUUID(), true);
  const replacedShell = await session(RunStatus.RUNNING);
  const runningShell = await turn(replacedShell.id, 'shell');
  await inFlight(runningShell, randomUUID(), true);

  server = await startApiserver(url, `inbox-draining-${randomUUID()}`);
  const runner = (method: string, route: string) =>
    call(server!, method, route, RUNNER_TOKEN, undefined, { 'x-orbit-runner-capabilities': SESSION_CLAUDE_STEER_WITHDRAW_V1 });
  /** An inbox fetch of the process holding `s`'s lease; `draining` is the field as the runner sends it, absent when undefined. */
  const fetch = (s: { id: string; lease: Lease }, draining?: string) => runner('GET',
    `/api/runner/sessions/${uuidToBase62(s.id)}/inbox?leaseGeneration=${s.lease.generation}&acceptsSteer=1`
      + (draining === undefined ? '' : `&draining=${draining}`));
  /** The turn an inbox fetch handed out, and its kind; an empty answer's turnId is ''. */
  const handed = (reply: Reply) => {
    assert.equal(reply.status, 200, reply.text);
    return [reply.json?.turnId ? toUuid(reply.json.turnId) : reply.json?.turnId, reply.json?.kind];
  };
  const statusOf = async (sessionId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1::uuid`, [sessionId])).rows[0].status;
  const turnStatusOf = async (turnId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "conversation_turn" WHERE "id" = $1::uuid`, [turnId])).rows[0].status;
  /** The session still has the engine that held it: the same lease, not retired, and the run it had. */
  const keepsItsEngine = async (s: { id: string; lease: Lease }, status: string) => {
    assert.equal(await statusOf(s.id), status, 'the draining fetch put the run back in the queue');
    const { rows: [row] } = await sql.query<{ generation: string; owner: string }>(
      `SELECT "inbox_lease_generation"::text AS "generation", "inbox_lease_owner"::text AS "owner" FROM "session" WHERE "id" = $1::uuid`,
      [s.id]);
    assert.deepEqual([row.generation, row.owner], [s.lease.generation, s.lease.owner], 'the draining fetch took the inbox lease away');
    const fence = await sql.query(`SELECT "retired_at" FROM "inbox_lease_generation" WHERE "generation" = $1::uuid`, [s.lease.generation]);
    assert.equal(fence.rows[0]?.retired_at, null, 'the draining fetch retired the engine process');
  };

  await t.test('a draining fetch hands out interrupt, end, diff, withdraw, setconfig and a steer into the running turn', async () => {
    assert.deepEqual(handed(await fetch(busy, '1')), [interrupt, 'interrupt']);
    assert.deepEqual(handed(await fetch(busy, '1')), [end, 'end']);
    assert.deepEqual(handed(await fetch(busy, '1')), [diff, 'diff']);
    assert.deepEqual(handed(await fetch(busy, '1')), [withdraw, 'withdraw']);
    assert.deepEqual(handed(await fetch(busy, '1')), [setconfig, 'setconfig']);
    assert.deepEqual(handed(await fetch(busy, '1')), [steer, 'steer']);
    assert.deepEqual(handed(await fetch(busy, '1')), ['', 'message'], 'the follow-up behind the running turn went out');
    assert.equal(await turnStatusOf(busyTurn), 'IN_FLIGHT');
    assert.equal(await turnStatusOf(busyFollowUp), 'PENDING');
    await keepsItsEngine(busy, 'RUNNING');
  });

  await t.test('a draining fetch hands out no PENDING message, shell or reload, and puts nothing back in the queue', async () => {
    for (const [s, held, status] of [
      [waitingMessage, heldMessage, 'RUNNING'], [waitingShell, heldShell, 'RUNNING'], [idle, heldReload, 'AWAITING_INPUT'],
    ] as const) {
      const reply = await fetch(s, '1');
      assert.deepEqual(handed(reply), ['', 'message'], `a draining fetch was handed a turn: ${reply.text}`);
      assert.equal(await turnStatusOf(held), 'PENDING');
      await keepsItsEngine(s, status);
    }
  });

  await t.test('a draining fetch hands out the expired-lease redelivery of a running message or shell turn', async () => {
    assert.deepEqual(handed(await fetch(replacedMessage, '1')), [runningMessage, 'message']);
    assert.deepEqual(handed(await fetch(replacedShell, '1')), [runningShell, 'shell']);
    for (const id of [runningMessage, runningShell]) assert.equal(await turnStatusOf(id), 'IN_FLIGHT');
  });

  await t.test('a fetch without the field hands out what the draining fetch held, as it always has', async () => {
    assert.deepEqual(handed(await fetch(waitingMessage)), [heldMessage, 'message']);
    assert.deepEqual(handed(await fetch(waitingShell)), [heldShell, 'shell']);
    assert.deepEqual(handed(await fetch(idle)), [heldReload, 'reload']);
    for (const id of [heldMessage, heldShell]) assert.equal(await turnStatusOf(id), 'IN_FLIGHT');
  });
});
