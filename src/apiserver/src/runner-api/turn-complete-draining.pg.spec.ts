/**
 * A turn that ends on a runner draining for an update (docs/runner-update-drain-design.md §7.3) and Stop on the
 * session it leaves (§7.4), against the production apiserver — `build/main.js`, the whole AppModule, run as a child
 * process — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/turn-complete-draining.pg.spec.ts
 *
 * A runner is played over its own door with its token, the owner over theirs. What it is held to:
 *
 *   1. a turn completion that says `draining` with a follow-up queued keeps no slot: the session goes back to the
 *      queue (PENDING), reads phase PENDING, waitingOn HOLD and queuedReason runner_updating at once (the completion
 *      records the runner as draining), keeps its engine's inbox lease, and its follow-up is claimed by the ordinary
 *      claim once the drain is over; with nothing queued it parks as before;
 *   2. a completion without the field (an older runner) keeps the slot for the follow-up, as before, and Stop on that
 *      session before the follow-up is leased is still refused SESSION_NEXT_TURN_STARTING;
 *   3. Stop on a session queued behind the update succeeds: its queued messages are dropped, its wakeup loop ends
 *      OWNER_STOP, it is idle, and the interrupt that ends its background work reaches the draining runner;
 *   4. Stop on a session the draining runner claimed whose queued message was never fetched succeeds the same way,
 *      and the runner's slot return then reads it idle;
 *   5. a slot the draining runner gives back with no turn run under it (the engine's own turn ended under a claim made
 *      for it) puts the session back in the queue behind the update; one with a turn in flight is kept;
 *   6. Stop on a session whose follow-up the runner fetched and held: the held turn handed back INTERRUPTED does not
 *      run, the queue is dropped, the slot is released and the session is idle;
 *   7. what the owner's clients are sent for a session held this way, with background work still up: the list row and
 *      the detail read queued behind the update, never Running, and Stop and Stop-and-send on it are accepted. With
 *      ORBIT_HELD_FIXTURE_OUT set, those replies are written there as src/shared/src/runner-update-held-session.fixture.json,
 *      which the web, OrbitKit and Android rendering tests read.
 *
 * Not destructive: every row belongs to an account this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { SELF_UPDATE_NOW_V1, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const CAPABLE = ['source-pin/v1'];

test('a turn ending on a draining runner returns its slot, and Stop on the session it leaves works', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const beats = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await beats.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `turn-complete-draining-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | undefined;
  let beating: ReturnType<typeof setInterval> | undefined;
  t.after(async () => {
    if (beating) clearInterval(beating);
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await beats.end().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  const email = `owner-${RUN}@turn-complete-draining.test`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', passwordHash: 'x' } });
  const login = await jwt.signAsync({ sub: ownerId, email });

  type Machine = { id: string; workspaceId: string; token: string };
  const machines: Machine[] = [];
  async function machine(name: string): Promise<Machine> {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({
      data: {
        id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date(),
        maxConcurrent: 8, capabilities: CAPABLE, capabilitiesReportedAt: new Date(), heartbeatDraining: false,
      },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: id, name: `${name}-${RUN}`, enabled: true } });
    const m = { id, workspaceId, token };
    machines.push(m);
    return m;
  }
  // The reaper ends a RUNNING session whose runner stopped heartbeating. These stay online the whole run.
  const beat = () => beats.query(
    `UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = ANY($1::uuid[])`,
    [machines.map((m) => m.id)],
  ).catch(() => undefined);
  beating = setInterval(() => void beat(), 3_000);
  /** What the runner's heartbeat last said of its drain, written as the heartbeat writes it. */
  const heartbeatDraining = (m: Machine, draining: boolean) =>
    sql.query(`UPDATE "runner" SET "heartbeat_draining" = $2 WHERE "id" = $1::uuid`, [m.id, draining]);
  const runnerDraining = async (m: Machine) =>
    (await sql.query<{ d: boolean | null }>(`SELECT "heartbeat_draining" AS d FROM "runner" WHERE "id" = $1::uuid`, [m.id])).rows[0].d;

  type Lease = { owner: string; generation: string };
  type Run = { id: string; lease: Lease; m: Machine };
  const seqs = new Map<string, number>();
  /** A Claude session on `m` that has run before, its inbox held by the engine process `lease` names. */
  async function session(m: Machine, status: RunStatus, extra: Record<string, unknown> = {}): Promise<Run> {
    const id = randomUUID();
    const lease = { owner: randomUUID(), generation: randomUUID() };
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: m.workspaceId, assignedRunnerId: m.id,
        title: `draining ${status.toLowerCase()} ${RUN}`, prompt: 'the work', provider: 'claude', providerBuiltin: true,
        engine: 'claude', status, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
        startedAt: new Date(Date.now() - 10 * 60_000), runtimeSessionId: randomUUID(), numTurns: 1,
        inboxLeaseOwner: lease.owner, inboxLeaseGeneration: lease.generation,
        ...extra,
      },
    });
    await sql.query(
      `INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [lease.generation, id, lease.owner],
    );
    return { id, lease, m };
  }
  /** A turn queued on `s`, the next in its order. */
  async function turn(s: Run, kind: string, content = `${kind} ${(seqs.get(s.id) ?? 0) + 1}`): Promise<string> {
    const id = randomUUID();
    const seq = (seqs.get(s.id) ?? 0) + 1;
    seqs.set(s.id, seq);
    await db.conversationTurn.create({
      data: { id, sessionId: s.id, seq, clientTurnId: randomUUID(), kind, status: 'PENDING', content },
    });
    return id;
  }
  /** `turnId` handed to `s`'s engine process and answered by it, as a turn that ran is. */
  async function running(s: Run, turnId: string) {
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now(), "lease_deadline_at" = now() + interval '5 minutes',
              "lease_generation" = $2::uuid WHERE "id" = $1::uuid`,
      [turnId, s.lease.generation]);
  }
  async function answered(s: Run, turnId: string) {
    const posted = await runnerCall(s.m, 'POST', `/api/runner/sessions/${uuidToBase62(s.id)}/events`, {
      leaseOwner: s.lease.owner,
      events: [{ seq: (seqs.get(`${s.id}:events`) ?? 0) + 1, type: 'assistant', turnId, ts: new Date().toISOString(), payload: { text: 'Done.' } }],
    });
    seqs.set(`${s.id}:events`, (seqs.get(`${s.id}:events`) ?? 0) + 1);
    assert.equal(posted.status, 202, posted.text);
  }
  /** An ACTIVE wakeup loop on `s` with its next tick waiting: background work Stop ends. */
  async function wakeupLoop(s: Run): Promise<string> {
    const loop = await db.sessionWakeupLoop.create({
      data: {
        sessionId: s.id, everySeconds: 600, prompt: 'look again', firstDueAt: new Date(Date.now() + 600_000),
        untilAt: new Date(Date.now() + 86_400_000),
      },
    });
    return loop.id;
  }

  server = await startApiserver(url, jwtSecret);
  const runnerCall = (m: Machine, method: string, route: string, body?: unknown): Promise<Reply> =>
    call(server!, method, route, m.token, body, { 'x-orbit-runner-caller': 'mcp' });
  const owner = (method: string, route: string, body?: unknown): Promise<Reply> => call(server!, method, route, login, body);
  /** The runner's turn completion for `turnId`; `draining` is the field as the runner sends it, absent when undefined. */
  const complete = (s: Run, turnId: string, draining?: boolean, status = 'SUCCEEDED', extra: Record<string, unknown> = {}) =>
    runnerCall(s.m, 'POST', `/api/runner/sessions/${uuidToBase62(s.id)}/turn-complete`, {
      turnId: uuidToBase62(turnId), leaseOwner: s.lease.owner, status, result: 'done', numTurns: 1, costUsd: 0,
      ...(draining === undefined ? {} : { draining }), ...extra,
    });
  /** The draining runner giving back `s`'s slot, under which no turn ran. */
  const returnSlot = (s: Run) =>
    runnerCall(s.m, 'POST', `/api/runner/sessions/${uuidToBase62(s.id)}/return-slot`, { leaseOwner: s.lease.owner });
  const stop = (s: Run) => owner('POST', `/api/sessions/${uuidToBase62(s.id)}/interrupt`, { stopBackgroundWork: true });
  const inbox = (s: Run, draining: boolean) => runnerCall(s.m, 'GET',
    `/api/runner/sessions/${uuidToBase62(s.id)}/inbox?leaseGeneration=${s.lease.generation}${draining ? '&draining=1' : ''}`);
  const claim = async (m: Machine): Promise<string | null> => {
    const reply = await call(server!, 'GET', '/api/runner/sessions/claim', m.token, undefined,
      { 'x-orbit-runner-capabilities': CAPABLE.join(','), 'x-orbit-runner-caller': 'mcp' });
    assert.ok(reply.status === 200 || reply.status === 204, reply.text);
    return reply.json?.sessionId ? toUuid(String(reply.json.sessionId)) : null;
  };
  const statusOf = async (id: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1::uuid`, [id])).rows[0].status;
  const turnStatusOf = async (id: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "conversation_turn" WHERE "id" = $1::uuid`, [id])).rows[0]?.status;
  const queued = async (s: Run) => (await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "conversation_turn" WHERE "session_id" = $1::uuid AND kind IN ('message', 'shell') AND status = 'PENDING'`,
    [s.id])).rows[0].n;
  async function row(s: Run): Promise<Record<string, any>> {
    const list = await owner('GET', '/api/sessions?view=open');
    assert.equal(list.status, 200, list.text);
    const found = (list.json as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === s.id);
    assert.ok(found, 'the session is in the owner’s list');
    return found;
  }
  /** The session still has the engine that held it: the same inbox lease, not retired. */
  async function keepsItsEngine(s: Run) {
    const { rows: [r] } = await sql.query<{ generation: string; owner: string }>(
      `SELECT "inbox_lease_generation"::text AS "generation", "inbox_lease_owner"::text AS "owner" FROM "session" WHERE "id" = $1::uuid`,
      [s.id]);
    assert.deepEqual([r.generation, r.owner], [s.lease.generation, s.lease.owner], 'the engine’s inbox lease was taken away');
    const fence = await sql.query(`SELECT "retired_at" FROM "inbox_lease_generation" WHERE "generation" = $1::uuid`, [s.lease.generation]);
    assert.equal(fence.rows[0]?.retired_at, null, 'the engine process was retired');
  }
  /** Idle after Stop: nothing queued, nothing it waits on, its wakeup loop ended by the owner. */
  async function stoppedIdle(s: Run, loopId?: string) {
    assert.equal(await statusOf(s.id), 'AWAITING_INPUT');
    assert.equal(await queued(s), 0, 'a queued message survived the Stop');
    const listed = await row(s);
    assert.equal(listed.phase, 'IDLE');
    assert.equal(listed.waitingOn, null);
    if (loopId) {
      const loop = await db.sessionWakeupLoop.findUniqueOrThrow({ where: { id: loopId } });
      assert.deepEqual([loop.state, loop.endedReason], ['ENDED', 'OWNER_STOP']);
    }
    // The interrupt that tells the runner to end the session's background work goes through a draining fetch.
    const handed = await inbox(s, true);
    assert.equal(handed.status, 200, handed.text);
    assert.equal(handed.json?.kind, 'interrupt', `the draining runner was not handed the Stop: ${handed.text}`);
    assert.equal(JSON.parse(String(handed.json?.content ?? '{}')).stopBackgroundWork, true);
  }

  const draining = await machine('draining-for-an-update');
  const older = await machine('older-runner');
  await beat();

  await t.test('1. a completion that says draining, with a follow-up queued, puts the session back in the queue', async () => {
    const s = await session(draining, RunStatus.RUNNING);
    const ran = await turn(s, 'message');
    const followUp = await turn(s, 'message');
    await running(s, ran);
    await answered(s, ran);
    assert.equal(await runnerDraining(draining), false);

    const done = await complete(s, ran, true);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json?.status, 'PENDING', 'the runner was told to keep its slot for the follow-up');
    assert.equal(await statusOf(s.id), 'PENDING');
    assert.equal(await turnStatusOf(ran), 'ANSWERED');
    assert.equal(await turnStatusOf(followUp), 'PENDING');
    assert.equal(await runnerDraining(draining), true, 'the completion did not record the runner as draining');
    await keepsItsEngine(s);
    const listed = await row(s);
    assert.deepEqual([listed.phase, listed.waitingOn, listed.queuedReason], ['PENDING', 'HOLD', 'runner_updating']);
    // The draining runner claims nothing for it; the updated one takes it through the ordinary claim.
    await heartbeatDraining(draining, false);
    assert.equal(await claim(draining), s.id, 'the follow-up was not claimable once the drain ended');
    assert.equal(await statusOf(s.id), 'RUNNING');
    const fetched = await inbox(s, false);
    assert.equal(fetched.status, 200, fetched.text);
    assert.equal(toUuid(String(fetched.json?.turnId)), followUp);
  });

  await t.test('1b. a completion that says draining with nothing queued parks the session as before', async () => {
    const s = await session(draining, RunStatus.RUNNING);
    const ran = await turn(s, 'message');
    await running(s, ran);
    await answered(s, ran);
    const done = await complete(s, ran, true);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json?.status, 'AWAITING_INPUT');
    assert.equal(await statusOf(s.id), 'AWAITING_INPUT');
    assert.equal(await runnerDraining(draining), true);
    await heartbeatDraining(draining, false);
  });

  await t.test('2. a completion without the field keeps the slot for the follow-up; Stop before it is leased is still 409', async () => {
    const s = await session(older, RunStatus.RUNNING);
    const ran = await turn(s, 'message');
    const followUp = await turn(s, 'message');
    await running(s, ran);
    await answered(s, ran);
    const done = await complete(s, ran);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json?.status, 'RUNNING');
    assert.equal(await statusOf(s.id), 'RUNNING');
    assert.equal(await turnStatusOf(followUp), 'PENDING');
    assert.equal(await runnerDraining(older), false, 'a completion without the field recorded a drain');
    const refused = await stop(s);
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json?.code, 'SESSION_NEXT_TURN_STARTING');
    assert.equal(await turnStatusOf(followUp), 'PENDING', 'the refused Stop dropped the follow-up');
  });

  await t.test('3. Stop on a session queued behind the update drops its queue, ends its loop and leaves it idle', async () => {
    const s = await session(draining, RunStatus.RUNNING);
    const loopId = await wakeupLoop(s);
    const ran = await turn(s, 'message');
    await turn(s, 'message');
    await turn(s, 'shell');
    await running(s, ran);
    await answered(s, ran);
    const done = await complete(s, ran, true);
    assert.equal(done.json?.status, 'PENDING', done.text);
    assert.equal((await row(s)).queuedReason, 'runner_updating');

    const stopped = await stop(s);
    assert.equal(stopped.status, 201, stopped.text);
    await stoppedIdle(s, loopId);
    await heartbeatDraining(draining, false);
  });

  await t.test('4. Stop on a session claimed before the drain whose message was never fetched', async () => {
    const s = await session(draining, RunStatus.RUNNING);
    const loopId = await wakeupLoop(s);
    await turn(s, 'message');
    await heartbeatDraining(draining, true);
    // The draining fetch holds the message: nothing is leased, and nothing ends the turn that never began.
    const held = await inbox(s, true);
    assert.equal(held.json?.turnId, '', held.text);
    const stopped = await stop(s);
    assert.equal(stopped.status, 201, `Stop was refused: ${stopped.text}`);
    await stoppedIdle(s, loopId);
    // The runner gives back the slot it held for the message; the session stays idle.
    const returned = await returnSlot(s);
    assert.equal(returned.status, 200, returned.text);
    assert.equal(returned.json?.status, 'AWAITING_INPUT');
    assert.equal(await statusOf(s.id), 'AWAITING_INPUT');
    await heartbeatDraining(draining, false);
  });

  await t.test('5. a slot given back with no turn under it requeues behind the update; one with a turn in flight is kept', async () => {
    // Claimed while the runner drained because its engine ran a turn of its own; that turn has ended.
    const s = await session(draining, RunStatus.RUNNING);
    const followUp = await turn(s, 'message');
    const returned = await returnSlot(s);
    assert.equal(returned.status, 200, returned.text);
    assert.equal(returned.json?.status, 'PENDING');
    assert.equal(await statusOf(s.id), 'PENDING');
    assert.equal(await turnStatusOf(followUp), 'PENDING');
    assert.equal(await runnerDraining(draining), true, 'the slot return did not record the runner as draining');
    await keepsItsEngine(s);
    const listed = await row(s);
    assert.deepEqual([listed.phase, listed.waitingOn, listed.queuedReason], ['PENDING', 'HOLD', 'runner_updating']);

    const busy = await session(draining, RunStatus.RUNNING);
    const inFlight = await turn(busy, 'message');
    await running(busy, inFlight);
    const kept = await returnSlot(busy);
    assert.equal(kept.status, 200, kept.text);
    assert.equal(kept.json?.status, 'RUNNING', 'a slot with a turn in flight was given back');
    assert.equal(await statusOf(busy.id), 'RUNNING');
    await heartbeatDraining(draining, false);
  });

  await t.test('6. a follow-up fetched and held for the update, handed back INTERRUPTED after Stop, does not run', async () => {
    const s = await session(draining, RunStatus.RUNNING);
    const ran = await turn(s, 'message');
    const heldTurn = await turn(s, 'message');
    const behind = await turn(s, 'message');
    await running(s, ran);
    await answered(s, ran);
    // An older control plane kept the slot; the runner fetched the follow-up and holds it for the update.
    const kept = await complete(s, ran);
    assert.equal(kept.json?.status, 'RUNNING', kept.text);
    await running(s, heldTurn);
    await heartbeatDraining(draining, true);

    const stopped = await stop(s);
    assert.equal(stopped.status, 201, stopped.text);
    assert.equal(await turnStatusOf(behind), undefined, 'the message queued behind the held one survived the Stop');
    const interrupt = await inbox(s, true);
    assert.equal(interrupt.json?.kind, 'interrupt', interrupt.text);
    // The runner hands the held turn back unrun (inboxPoller.handBackHeld).
    const handedBack = await complete(s, heldTurn, true, 'INTERRUPTED', {
      result: 'Stopped before it started: nothing ran.', subtype: 'interrupted', numTurns: 0,
    });
    assert.equal(handedBack.status, 200, handedBack.text);
    assert.equal(handedBack.json?.status, 'AWAITING_INPUT', 'the slot was not released');
    assert.equal(await turnStatusOf(heldTurn), 'ANSWERED');
    assert.equal(await statusOf(s.id), 'AWAITING_INPUT');
    assert.equal(await queued(s), 0);
    const listed = await row(s);
    assert.deepEqual([listed.phase, listed.waitingOn], ['IDLE', null]);
    // Nothing is left for the updated runner to run.
    await heartbeatDraining(draining, false);
    assert.notEqual(await claim(draining), s.id);
  });

  await t.test('7. the held session as the clients are sent it, and Stop and Stop-and-send on it', async () => {
    // Board 5 of docs/mocks/runner-update-drain: studio-mac drains for 0.1.254 behind two turns.
    const studio = await machine('studio-mac');
    await beat();
    await db.runner.update({
      where: { id: studio.id },
      data: {
        displayName: 'studio-mac',
        // So the clients offer board 5's Update Now beside Later.
        capabilities: [...CAPABLE, SELF_UPDATE_NOW_V1],
        selfUpdate: {
          state: 'waitingForIdle', phase: 'draining', targetVersion: '0.1.254',
          drainingSince: new Date(Date.now() - 38 * 60_000).toISOString(), turnsInFlight: 2,
        },
      },
    });
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    for (const [title, minutes] of [['Backfill missing shard rows', 52], ['Why are 11-08 metrics zero', 47]] as const) {
      await session(studio, RunStatus.RUNNING, { title, lastTurnAt: ago(minutes) });
    }
    /** A session whose turn just ended on the draining runner, a follow-up queued and a dev server still up. */
    async function held(title: string): Promise<Run> {
      const s = await session(studio, RunStatus.RUNNING, { title, lastTurnAt: ago(1), runningBgShells: ['bg_dev_server'] });
      const ran = await turn(s, 'message', 'Why is the send stuck?');
      await turn(s, 'message', 'And check the queue after that.');
      await running(s, ran);
      await answered(s, ran);
      const done = await complete(s, ran, true);
      assert.equal(done.json?.status, 'PENDING', done.text);
      return s;
    }
    const s = await held('Why is the send stuck in Queued');
    const ok = async (route: string): Promise<any> => {
      const reply = await owner('GET', route);
      assert.equal(reply.status, 200, `${route}: ${reply.text}`);
      return reply.json;
    };
    const listed = await row(s);
    const detail = await ok(`/api/sessions/${uuidToBase62(s.id)}`);
    for (const payload of [listed, detail]) {
      assert.deepEqual([payload.status, payload.phase, payload.waitingOn], ['PENDING', 'PENDING', 'HOLD']);
    }
    assert.deepEqual([listed.queuedReason, listed.runningBgCount], ['runner_updating', 1]);
    assert.deepEqual([listed.queuedRunnerUpdate.stopping, listed.queuedRunnerUpdate.targetVersion], [false, '0.1.254']);
    assert.equal(listed.queuedRunnerUpdate.turns.length, 2);
    const out = process.env.ORBIT_HELD_FIXTURE_OUT;
    if (out) {
      const id = uuidToBase62(s.id);
      writeFileSync(out, `${JSON.stringify({
        capturedFrom: 'src/apiserver/src/runner-api/turn-complete-draining.pg.spec.ts, case 7 (ORBIT_HELD_FIXTURE_OUT)',
        listRow: listed,
        detail,
        // The web's read of the queue, then the one the native apps make.
        queuedTurns: await ok(`/api/sessions/${id}/turns?view=active`),
        queueOnlyTurns: await ok(`/api/sessions/${id}/turns`),
        runner: (await ok('/api/runners') as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === studio.id),
        workspace: (await ok('/api/workspaces') as Array<Record<string, any>>)
          .find((x) => toUuid(String(x.id)) === studio.workspaceId),
      }, null, 2)}\n`);
    }

    const stopped = await stop(s);
    assert.equal(stopped.status, 201, stopped.text);
    await stoppedIdle(s);

    // The Mac composer's Stop-and-send (OrbitKit interruptAndSend): the follow-up replaces the queue and waits.
    const other = await held('A second one held');
    const sent = await owner('POST', `/api/sessions/${uuidToBase62(other.id)}/interrupt`,
      { clientTurnId: randomUUID(), content: 'Do this instead.' });
    assert.equal(sent.status, 201, sent.text);
    assert.equal((await row(other)).queuedReason, 'runner_updating');
    assert.equal(await queued(other), 1);
  });
});
