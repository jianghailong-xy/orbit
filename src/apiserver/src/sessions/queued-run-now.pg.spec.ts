/**
 * Run now (docs/mocks/queued-run-now/01-run-now.png, sessions/run-now.ts): a person starts one queued message held by a
 * full runner, run or batch at once, over the limit. Against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates
 * from empty, through the production apiserver's POST /api/sessions/:id/run-now, GET /api/sessions and the runner's
 * GET /api/runner/sessions/claim and POST /api/runner/sessions/:id/turn-complete. What it is held to:
 *
 *   (1) a passed turn is claimed on a runner at its max while turns < max + burst, with overCapacity on the claim, and
 *       not at max + burst: there the list and the door say the runner is as far over as it may go;
 *   (2) an ordinary queued turn is not claimed while the runner is at or over its max, and the overflow turns count
 *       as active, so it waits until the count drops below the max (decision F);
 *   (3) when the overflow turn ends, the pass is spent: the session's next message queues like any other;
 *   (4) an offline or updating runner, a disk below Keep Free and a clone not ready are refused at the door with the
 *       reason, and a pass standing on such a session does not lift them at the claim;
 *   (5) a personal access token, a request carrying an acting session, a runner credential and another account are
 *       refused, and write nothing;
 *   (6) a runner that does not declare over-capacity/v1 is refused with an English reason, in the list and at the door,
 *       and no overflow claim is made for it; nor for a runner whose Extra sessions on demand is 0;
 *   (7) the pass lifts a full batch and a full run too (decision D), and the runner's Extra sessions on demand is
 *       edited where its max is (PATCH /api/runners/:id).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/queued-run-now.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { OVER_CAPACITY_V1, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { openingTurnKey } from './orbit-authored-turn';
import '../test-support/daemon-routes-over-http';
import { turnStateOfWord } from './session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MINUTE = 60_000;
const GB = 1024n * 1024n * 1024n;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const CAPABLE = ['source-pin/v1', OVER_CAPACITY_V1];

test('Run now starts one queued turn over its runner\'s limit, up to max + burst, and lifts nothing but the slot gates', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `queued-run-now-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, path, bearer, body, headers);

  async function account(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}@queued-run-now.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: await jwt.signAsync({ sub: id, email }) };
  }
  const alice = await account('alice');
  const bob = await account('bob');

  type Machine = { id: string; workspaceId: string; token: string; name: string };
  async function runner(
    name: string,
    data: Partial<Prisma.RunnerUncheckedCreateInput>,
    workspace: Partial<Prisma.WorkspaceUncheckedCreateInput> = {},
  ): Promise<Machine> {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({
      data: {
        id, ownerId: alice.id, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date(),
        maxConcurrent: 2, capabilities: CAPABLE, capabilitiesReportedAt: new Date(), ...data,
      },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId: alice.id, runnerId: id, name: `${name}-${RUN}`, enabled: true, ...workspace } });
    return { id, workspaceId, token, name: `${name}-${RUN}` };
  }
  async function session(r: Machine, title: string, status: RunStatus, extra: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: alice.id, creatorId: alice.id, workspaceId: r.workspaceId, assignedRunnerId: r.id, title,
        prompt: title, provider: 'claude', providerBuiltin: true, turnState: turnStateOfWord(status), dispatchOrigin: SessionDispatchOrigin.USER,
        ...(status === RunStatus.RUNNING
          ? { startedAt: new Date(Date.now() - 50 * MINUTE), runtimeSessionId: randomUUID(), numTurns: 1 }
          : {}),
        ...extra,
      },
    });
    // Created one after another, so the claim's oldest-first order is the order they are made in.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return id;
  }
  /** A turn that ended: its slot is free. */
  const finish = (id: string) => sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" = $1::uuid`, [id]);
  async function row(sessionId: string): Promise<Record<string, any>> {
    const list = await api('GET', '/api/sessions?view=open', alice.login);
    assert.equal(list.status, 200, list.text);
    const found = (list.json as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === sessionId);
    assert.ok(found, 'the session is in the list');
    return found;
  }
  async function claim(r: Machine, query = ''): Promise<Record<string, any> | null> {
    const reply = await api('GET', `/api/runner/sessions/claim${query}`, r.token, undefined,
      { 'x-orbit-runner-capabilities': CAPABLE.join(',') });
    assert.ok(reply.status === 200 || reply.status === 204, reply.text);
    return reply.json?.sessionId ? reply.json : null;
  }
  const claimedId = (claimed: Record<string, any> | null) => (claimed ? toUuid(String(claimed.sessionId)) : null);
  const runNow = (sessionId: string, bearer = alice.login, headers?: Record<string, string>) =>
    api('POST', `/api/sessions/${uuidToBase62(sessionId)}/run-now`, bearer, undefined, headers);
  const state = async (sessionId: string) => {
    const s = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, overCapacityTurnId: true } });
    return { status: s.status, pass: s.overCapacityTurnId };
  };
  /** A pass laid down without the door, to show the claim itself holds a gate the door would have refused on. */
  async function passWithoutTheDoor(sessionId: string) {
    const turn = await db.conversationTurn.create({
      data: { sessionId, seq: 1, clientTurnId: openingTurnKey(sessionId), kind: 'message', content: 'the prompt', status: 'PENDING' },
    });
    await db.session.update({ where: { id: sessionId }, data: { overCapacityTurnId: turn.id } });
    return turn.id;
  }
  const refusal = (reply: Reply) => {
    assert.equal(reply.status, 409, reply.text);
    assert.equal(reply.json?.code, 'RUN_NOW_REFUSED', reply.text);
    return String(reply.json?.message);
  };

  await t.test('(1)(2) an overflow turn is claimed at max and below max + burst, not at max + burst; ordinary turns wait', async () => {
    const r = await runner('hpc', { maxConcurrent: 2, burstConcurrent: 1 });
    const s1 = await session(r, 'running one', RunStatus.RUNNING);
    const s2 = await session(r, 'running two', RunStatus.RUNNING);
    const q1 = await session(r, 'the screenshot request', RunStatus.PENDING);
    const q2 = await session(r, 'the second press', RunStatus.PENDING);
    const q3 = await session(r, 'an ordinary queued message', RunStatus.PENDING);

    const before = await row(q1);
    assert.equal(before.queuedReason, 'runner_at_capacity');
    assert.equal(before.queuedActive, 2);
    assert.equal(before.queuedLimit, 2);
    assert.equal(before.runNowAvailable, true, 'the button presses');
    assert.equal(before.runNowRefusal, null);
    assert.equal(before.queuedBurstLimit, 1, 'the runner\'s Extra sessions on demand');
    assert.equal(before.runningOverLimit, null);

    assert.equal(await claim(r), null, '(2) at its max, an ordinary queued turn is not claimed');

    const pressed = await runNow(q1);
    assert.equal(pressed.status, 200, pressed.text);
    assert.equal(pressed.json.alreadyPassed, false);
    const passTurn = await db.conversationTurn.findUniqueOrThrow({
      where: { sessionId_clientTurnId: { sessionId: q1, clientTurnId: openingTurnKey(q1) } },
    });
    assert.equal(toUuid(String(pressed.json.turnId)), passTurn.id, 'the pass covers the message the session was opened with, seeded for it');
    assert.deepEqual(await state(q1), { status: 'PENDING', pass: passTurn.id });
    const again = await runNow(q1);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.alreadyPassed, true, 'a second press changes nothing');
    assert.equal((await row(q1)).runNowAvailable, false);
    assert.match((await row(q1)).runNowRefusal, /already starting over/);
    assert.equal((await runNow(q2)).status, 200, 'q2 is passed too while there is room for one more');

    const first = await claim(r);
    assert.equal(claimedId(first), q1, '(1) the passed turn is claimed at max (2 of 2), under max + burst (3)');
    assert.equal(first!.overCapacity, true, 'the runner is told it admits this one past its max');
    assert.equal(toUuid(String(first!.overCapacityTurnId)), passTurn.id);
    assert.deepEqual(await state(q1), { status: 'RUNNING', pass: passTurn.id }, 'the pass stands while its turn runs');
    assert.deepEqual((await row(q1)).runningOverLimit, { active: 3, limit: 2, runnerName: r.name }, 'over limit · 3/2');

    assert.equal(await claim(r), null, '(1) at max + burst the next passed turn is not claimed');
    assert.equal((await state(q2)).status, 'PENDING');
    const full = await row(q3);
    assert.equal(full.queuedActive, 3, 'the overflow turn counts as active');
    assert.equal(full.runNowAvailable, false);
    assert.equal(full.runNowRefusal, `${r.name} is already 1 over its limit, the most it can take. Wait, or stop another session.`);
    assert.equal(refusal(await runNow(q3)), full.runNowRefusal, 'the door refuses in the list\'s words');
    assert.equal((await state(q3)).pass, null);

    // One ordinary turn ends: 2 of 2. The ordinary q3 still waits; the passed q2 goes over again (2 < 3).
    await finish(s1);
    const second = await claim(r);
    assert.equal(claimedId(second), q2, 'a pass still waiting is claimed when there is burst room again');
    assert.equal(second!.overCapacity, true);
    assert.equal((await state(q3)).status, 'PENDING', '(2) the ordinary turn is not claimed at its max');
    assert.equal(await claim(r), null);
    // The other ordinary turn ends: two overflow turns run, 2 of 2, and q3 still waits for a count below the max.
    await finish(s2);
    assert.equal(await claim(r), null, '(2) overflow turns count as active: the ordinary turn waits while they run');
    assert.equal((await state(q3)).status, 'PENDING');
    await finish(q1);
    const third = await claim(r);
    assert.equal(claimedId(third), q3, 'below the max at last, the ordinary turn takes its slot');
    assert.equal(third!.overCapacity, undefined, 'an ordinary claim says nothing of the limit');
  });

  await t.test('(3) when the overflow turn ends, its follow-up queues normally', async () => {
    const r = await runner('one-slot', { maxConcurrent: 1, burstConcurrent: 1 });
    const busy = await session(r, 'the long turn', RunStatus.RUNNING);
    const q = await session(r, 'the urgent one', RunStatus.PENDING);
    const pressed = await runNow(q);
    assert.equal(pressed.status, 200, pressed.text);
    const turnId = toUuid(String(pressed.json.turnId));
    const claimed = await claim(r);
    assert.equal(claimedId(claimed), q);
    assert.equal(claimed!.overCapacity, true);

    // The person sends a second message while the overflow turn runs.
    await db.conversationTurn.create({
      data: { sessionId: q, seq: 2, clientTurnId: `follow-up-${RUN}`, kind: 'message', content: 'and one more thing', status: 'PENDING' },
    });
    // The runner takes the opening turn and reports it done, as feishu-direct-open.pg.spec.ts does.
    const lease = { owner: randomUUID(), generation: randomUUID() };
    await sql.query(`INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [lease.generation, q, lease.owner]);
    await sql.query('BEGIN');
    try {
      await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
      await sql.query(`UPDATE "session" SET "inbox_lease_owner" = $2::uuid, "inbox_lease_generation" = $3::uuid,
                              "runtime_session_id" = coalesce("runtime_session_id", $4) WHERE "id" = $1::uuid`,
        [q, lease.owner, lease.generation, randomUUID()]);
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now(), "lease_deadline_at" = now() + interval '5 minutes',
              "lease_generation" = $2::uuid WHERE "id" = $1::uuid`,
      [turnId, lease.generation]);
    // The engine answers it: a turn with no answer is put back in the queue, not ended.
    const posted = await api('POST', `/api/runner/sessions/${uuidToBase62(q)}/events`, r.token, {
      leaseOwner: lease.owner,
      events: [{ seq: 1, type: 'assistant', turnId, ts: new Date().toISOString(), payload: { text: 'On it.' } }],
    }, { 'x-orbit-runner-caller': 'mcp' });
    assert.equal(posted.status, 202, posted.text);
    const done = await api('POST', `/api/runner/sessions/${uuidToBase62(q)}/turn-complete`, r.token, {
      turnId: uuidToBase62(turnId), leaseOwner: lease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1, costUsd: 0,
    }, { 'x-orbit-runner-caller': 'mcp' });
    assert.equal(done.status, 200, done.text);

    assert.deepEqual(await state(q), { status: 'PENDING', pass: null }, `the pass is spent and the slot returned: the follow-up queues (${done.text})`);
    assert.equal(await claim(r), null, 'the follow-up does not inherit the slot over the limit');
    const waiting = await row(q);
    assert.equal(waiting.queuedReason, 'runner_at_capacity', 'it waits for a free slot like any other message');
    assert.equal(waiting.runningOverLimit, null);
    assert.equal(waiting.runNowAvailable, true, 'and Run now may be pressed for it afresh');
    await finish(busy);
    const next = await claim(r);
    assert.equal(claimedId(next), q, 'a free slot starts it');
    assert.equal(next!.overCapacity, undefined, 'in a slot of its own');
  });

  await t.test('(4) offline, updating, a disk below Keep Free and a clone not ready are not lifted', async () => {
    const stale = new Date(Date.now() - 30 * MINUTE);
    const offline = await runner('gone', { maxConcurrent: 1, lastHeartbeatAt: stale });
    await session(offline, 'was running', RunStatus.RUNNING);
    const onOffline = await session(offline, 'queued on a gone runner', RunStatus.PENDING);
    assert.equal((await row(onOffline)).queuedReason, 'runner_offline');
    assert.equal((await row(onOffline)).runNowAvailable, false);
    assert.equal(refusal(await runNow(onOffline)), `${offline.name} is offline, so running over its limit would not start this message.`);
    assert.deepEqual(await state(onOffline), { status: 'PENDING', pass: null });

    const updating = await runner('updating', { maxConcurrent: 1, heartbeatDraining: true });
    const drained = await session(updating, 'the turn the drain waits for', RunStatus.RUNNING);
    const onUpdating = await session(updating, 'queued behind an update', RunStatus.PENDING);
    assert.equal((await row(onUpdating)).queuedReason, 'runner_updating');
    assert.equal(refusal(await runNow(onUpdating)), `${updating.name} is updating and starts no new turn until it is done, over its limit or not.`);
    assert.deepEqual(await state(onUpdating), { status: 'PENDING', pass: null });
    await passWithoutTheDoor(onUpdating);
    assert.equal(await claim(updating, `?drainScope=${drained}`), null, 'a draining runner\'s scoped claim takes no passed session');
    assert.equal((await state(onUpdating)).status, 'PENDING');

    const low = await runner('low-disk', { maxConcurrent: 1, minFreeDiskMb: 10240 }, { workDirFreeBytes: 1n * GB });
    await session(low, 'running', RunStatus.RUNNING);
    const onLow = await session(low, 'a new session on a full disk', RunStatus.PENDING);
    assert.equal((await row(onLow)).queuedReason, 'disk_below_floor');
    assert.equal(refusal(await runNow(onLow)), `${low.name} is below its Keep Free disk floor, so running over its limit would not start this message.`);
    await passWithoutTheDoor(onLow);
    assert.equal(await claim(low), null, 'a pass does not lift Keep Free');
    assert.equal((await state(onLow)).status, 'PENDING');

    const cloning = await runner('cloning', { maxConcurrent: 1 }, { cloneState: 'CLONING' });
    await session(cloning, 'running', RunStatus.RUNNING);
    const onCloning = await session(cloning, 'waiting for its clone', RunStatus.PENDING);
    assert.equal((await row(onCloning)).queuedReason, 'WORKSPACE_CLONING');
    assert.equal(refusal(await runNow(onCloning)), 'This workspace is still being cloned, so running over the limit would not start this message.');
    await passWithoutTheDoor(onCloning);
    assert.equal(await claim(cloning), null, 'a pass does not lift a clone hold');
    assert.equal((await state(onCloning)).status, 'PENDING');
  });

  await t.test('(5) a token, an acting session, a runner credential and another account are refused, and write nothing', async () => {
    const r = await runner('guarded', { maxConcurrent: 1 });
    await session(r, 'running', RunStatus.RUNNING);
    const q = await session(r, 'queued', RunStatus.PENDING);
    const pat = (await new PatService(db as unknown as PrismaService).issue(alice.id, {
      name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB',
    })).token;
    const byToken = await runNow(q, pat);
    assert.equal(byToken.status, 403, byToken.text);
    assert.equal(byToken.json?.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    const bySession = await runNow(q, alice.login, { 'x-orbit-session-id': uuidToBase62(q) });
    assert.equal(bySession.status, 403, bySession.text);
    assert.equal(bySession.json?.code, 'RUN_NOW_OWNER_CHANNEL_ONLY');
    const byRunner = await runNow(q, r.token);
    assert.equal(byRunner.status, 401, byRunner.text);
    const byStranger = await runNow(q, bob.login);
    assert.equal(byStranger.status, 404, byStranger.text);
    assert.deepEqual(await state(q), { status: 'PENDING', pass: null }, 'no pass');
    assert.equal(await db.conversationTurn.count({ where: { sessionId: q } }), 0, 'and no turn seeded');
    assert.equal((await runNow(q)).status, 200, 'the owner, signed in, is answered');
  });

  await t.test('(6) a runner too old to admit an overflow turn, or with no extra sessions, is refused with the reason', async () => {
    const old = await runner('old', { maxConcurrent: 1, capabilities: ['source-pin/v1'] });
    await session(old, 'running', RunStatus.RUNNING);
    const q = await session(old, 'queued on an old runner', RunStatus.PENDING);
    const listed = await row(q);
    assert.equal(listed.queuedReason, 'runner_at_capacity');
    assert.equal(listed.runNowAvailable, false, 'the button is drawn disabled');
    assert.equal(listed.runNowRefusal, `${old.name}'s runner is too old to run over its limit.`);
    assert.equal(refusal(await runNow(q)), listed.runNowRefusal);
    assert.deepEqual(await state(q), { status: 'PENDING', pass: null });
    await passWithoutTheDoor(q);
    assert.equal(await claim(old), null, 'no overflow claim is made for a runner that does not declare it');
    assert.equal((await state(q)).status, 'PENDING');

    const off = await runner('no-burst', { maxConcurrent: 1, burstConcurrent: 0 });
    await session(off, 'running', RunStatus.RUNNING);
    const onOff = await session(off, 'queued where Run now is off', RunStatus.PENDING);
    assert.equal((await row(onOff)).runNowRefusal, `${off.name} takes no sessions over its limit: its Extra sessions on demand is 0.`);
    assert.equal((await row(onOff)).queuedBurstLimit, 0);
    assert.equal(refusal(await runNow(onOff)), `${off.name} takes no sessions over its limit: its Extra sessions on demand is 0.`);
  });

  await t.test('(7) a full batch and a full run are lifted too; Extra sessions on demand is edited beside the max', async () => {
    const r = await runner('roomy', { maxConcurrent: 4 });
    const patched = await api('PATCH', `/api/runners/${uuidToBase62(r.id)}`, alice.login, { maxConcurrent: 4, burstConcurrent: 3 });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.burstConcurrent, 3);
    const listed = await api('GET', '/api/runners', alice.login);
    assert.equal((listed.json as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === r.id)?.burstConcurrent, 3);
    assert.equal((await api('PATCH', `/api/runners/${uuidToBase62(r.id)}`, alice.login, { burstConcurrent: -1 })).status, 400);
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: r.id } })).burstConcurrent, 3);
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id: (await runner('defaulted', {})).id } })).burstConcurrent, 2,
      'a runner starts at 2');

    const batchId = randomUUID();
    await session(r, 'batch member running', RunStatus.RUNNING, { batchId, batchMaxConcurrent: 1 });
    const inBatch = await session(r, 'batch member queued', RunStatus.PENDING, { batchId, batchMaxConcurrent: 1 });
    assert.equal((await row(inBatch)).queuedReason, 'batch_at_capacity');
    assert.equal(await claim(r), null, 'the batch is full');
    assert.equal((await runNow(inBatch)).status, 200);
    const batchClaim = await claim(r);
    assert.equal(claimedId(batchClaim), inBatch, 'the pass lifts a full batch');
    assert.equal(batchClaim!.overCapacity, true);

    // A spawn tree whose other children run elsewhere: the run is full on this runner's share, the runner is not.
    const elsewhere = await runner('elsewhere', { maxConcurrent: 8 });
    const root = await session(elsewhere, 'the orchestrator', RunStatus.RUNNING);
    await db.session.update({ where: { id: root }, data: { rootSessionId: root } });
    for (const title of ['child one', 'child two', 'child three']) {
      await session(elsewhere, title, RunStatus.RUNNING, { rootSessionId: root, parentSessionId: root, spawnDepth: 1 });
    }
    const child = await session(r, 'child queued here', RunStatus.PENDING, { rootSessionId: root, parentSessionId: root, spawnDepth: 1 });
    assert.equal((await row(child)).queuedReason, 'tree_at_capacity');
    assert.equal(await claim(r), null, 'the run is full');
    assert.equal((await runNow(child)).status, 200);
    const treeClaim = await claim(r);
    assert.equal(claimedId(treeClaim), child, 'the pass lifts a full run');
    assert.equal(treeClaim!.overCapacity, true);
  });
});
