/**
 * UPDATE NOW (docs/runner-update-drain-design.md §4, D4) against a real PostgreSQL, through the production handlers:
 *
 *   (1) POST /runners/:id/self-update/now {interruptTurns: true} is the owner's alone: another account's is refused as
 *       not found and stores and records nothing.
 *   (2) The owner's is recorded as a `runner.self_update.now` activity naming the owner's turns it interrupts, stored,
 *       wakes the runner, and is handed to exactly one heartbeat as `selfUpdateNow`.
 *   (3) Refused: without interruptTurns: true; for a runner too old to honour it (no self-update-now/v1), with Update
 *       Runner Now's "too old" sentence; for one with no release waiting; for an offline one. None records anything.
 *   (4) When the updated runner reclaims a session whose turn Update Now cut — the runner marked it
 *       `interrupt {reason: runner_update, targetVersion}` — the next fetch hands the turn back as the update's
 *       continuation, opening with "[Orbit] The runner update interrupted this turn; continue." and naming the release;
 *       its echo is stored with the continuation, so the clients draw it as one Orbit line. A turn a plain restart cut
 *       keeps the restart's continuation.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-self-update-now.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { RunStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  RUNNER_UPDATE_RESUME_NOTE,
  RunEventType,
  RunnerStatus,
  SELF_UPDATE_NOW_V1,
  type RunInboxResponse,
  type RunnerSelfUpdate,
} from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RUNNER_SELF_UPDATE_NOW_ACTIVITY, RunnersService } from './runners.service';
import '../test-support/dequeue-under-lease';

const url = process.env.COORDINATOR_PG_URL;

const DRAINING: RunnerSelfUpdate = {
  state: 'waitingForIdle',
  phase: 'draining',
  targetVersion: '0.1.254',
  availableSince: '2026-11-12T08:00:00Z',
  drainingSince: '2026-11-12T09:00:00Z',
  turnsInFlight: 2,
  turnsAtDrain: 2,
};

test('Update Now: owner only, audited, old runner refused, handed to one heartbeat, and the cut turn resumes with the note', {
  skip: !url, timeout: 300_000, concurrency: 1,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });

  const wakes: string[] = [];
  const runners = new RunnersService(db as never, { notifyRunnerWake: (id: string) => wakes.push(id) } as never);
  const realtime = new Proxy({
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  }, { get: (target, key) => (key in target ? (target as Record<string, unknown>)[key as string] : () => undefined) });
  const api = new RunnerApiController(db as never, { notifySessionQueued: () => undefined } as never, realtime as never, {} as never, {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const declared = new Map<string, string>();
  const beat = (runnerId: string, selfUpdate: RunnerSelfUpdate | undefined = DRAINING) =>
    api.heartbeat({ id: runnerId, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1, ...(selfUpdate ? { selfUpdate } : {}) },
      declared.get(runnerId) ?? '');
  const stored = async (runnerId: string) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runnerId }, select: { selfUpdateNowRequestedAt: true } })).selfUpdateNowRequestedAt;
  const audit = (ownerId: string) =>
    db.activity.findMany({ where: { actorId: ownerId, type: RUNNER_SELF_UPDATE_NOW_ACTIVITY }, orderBy: { createdAt: 'asc' } });

  async function fixture(opts: { capabilities?: string[]; status?: 'ONLINE' | 'OFFLINE' } = {}) {
    const ownerId = randomUUID(), runnerId = randomUUID(), workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@update-now.invalid`, name: 'Update Now test', passwordHash: 'x' } });
    await db.runner.create({ data: {
      id: runnerId, ownerId, name: 'studio-mac', tokenHash: randomUUID(), status: opts.status ?? 'ONLINE',
      lastHeartbeatAt: new Date(), capabilities: opts.capabilities ?? [SELF_UPDATE_NOW_V1], capabilitiesReportedAt: new Date(),
    } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'update-now-workspace', enabled: true } });
    declared.set(runnerId, (opts.capabilities ?? [SELF_UPDATE_NOW_V1]).join(','));
    return { ownerId, runnerId, workspaceId };
  }
  async function runningSession(f: { ownerId: string; runnerId: string; workspaceId: string }, title: string, provider = 'claude') {
    const id = randomUUID();
    await db.session.create({ data: {
      id, ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.workspaceId, assignedRunnerId: f.runnerId, title,
      prompt: 'a long turn', provider, status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(), runClaimedAt: new Date(Date.now() - 47 * 60_000), runtimeSessionId: randomUUID(),
    } });
    return id;
  }

  await t.test('(1) another account’s Update Now is refused as not found and stores and records nothing', async () => {
    const f = await fixture();
    const other = await fixture();
    await beat(f.runnerId);
    await assert.rejects(() => runners.updateSelfNow(other.ownerId, f.runnerId, { interruptTurns: true }), /runner not found/);
    assert.equal(await stored(f.runnerId), null);
    assert.equal((await audit(other.ownerId)).length, 0);
    assert.equal((await audit(f.ownerId)).length, 0);
    assert.equal(wakes.includes(f.runnerId), false);
  });

  await t.test('(2) the owner’s Update Now is recorded with the turns it interrupts, stored, woken, and handed to one heartbeat', async () => {
    const f = await fixture();
    const backfill = await runningSession(f, 'Backfill missing shard rows');
    const metrics = await runningSession(f, 'Why are 11-08 metrics zero', 'codex');
    await beat(f.runnerId);
    const answer = await runners.updateSelfNow(f.ownerId, f.runnerId, { interruptTurns: true });
    assert.equal(answer.turns, 2);
    assert.equal((await stored(f.runnerId))?.toISOString(), answer.requestedAt);
    assert.equal(wakes.at(-1), f.runnerId);

    const rows = await audit(f.ownerId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].credentialKind, 'LOGIN');
    const payload = rows[0].payload as { sessionIds: string[] } & Record<string, unknown>;
    assert.deepEqual({ ...payload, sessionIds: [...payload.sessionIds].sort() }, {
      runnerId: f.runnerId, interruptTurns: true, phase: 'draining', targetVersion: '0.1.254', sessionIds: [backfill, metrics].sort(),
    });

    assert.equal((await beat(f.runnerId)).selfUpdateNow, true);
    assert.equal(await stored(f.runnerId), null);
    assert.equal((await beat(f.runnerId)).selfUpdateNow, undefined, 'a second beat was handed the same Update Now');

    // The confirm dialog's list: the runner page names the owner's turns for an available release too.
    await beat(f.runnerId, { state: 'waitingForIdle', phase: 'available', targetVersion: '0.1.254', turnsInFlight: 2 });
    const listed = (await runners.listRunners(f.ownerId) as unknown as Array<{ id: string; updateTurns?: Array<{ title: string | null }> }>)
      .find((r) => r.id === f.runnerId);
    assert.deepEqual(listed?.updateTurns?.map((turn) => turn.title).sort(), ['Backfill missing shard rows', 'Why are 11-08 metrics zero']);
  });

  await t.test('(3) refused without interruptTurns, for a runner too old to honour it, with nothing waiting, and offline', async () => {
    const f = await fixture();
    await beat(f.runnerId);
    await assert.rejects(() => runners.updateSelfNow(f.ownerId, f.runnerId, {} as never), /interruptTurns must be true/);
    await assert.rejects(() => runners.updateSelfNow(f.ownerId, f.runnerId, undefined), /interruptTurns must be true/);
    assert.equal(await stored(f.runnerId), null);
    assert.equal((await audit(f.ownerId)).length, 0);

    const old = await fixture({ capabilities: [] });
    await beat(old.runnerId);
    await assert.rejects(
      () => runners.updateSelfNow(old.ownerId, old.runnerId, { interruptTurns: true }),
      { message: 'Runner is too old to update on request — it reports no self-update state' },
    );
    assert.equal(await stored(old.runnerId), null);
    assert.equal((await audit(old.ownerId)).length, 0);

    const idle = await fixture();
    await beat(idle.runnerId, { state: 'enabled' });
    await assert.rejects(() => runners.updateSelfNow(idle.ownerId, idle.runnerId, { interruptTurns: true }), /nothing to install/);
    assert.equal(await stored(idle.runnerId), null);

    const offline = await fixture({ status: 'OFFLINE' });
    await assert.rejects(() => runners.updateSelfNow(offline.ownerId, offline.runnerId, { interruptTurns: true }), /offline/i);
    assert.equal(await stored(offline.runnerId), null);
    assert.equal((await audit(offline.ownerId)).length, 0);
  });

  const fetchTurn = (runnerId: string, sessionId: string, generation: string) =>
    (api as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<RunInboxResponse | null>;
    }).dequeueTurn.call(api, sessionId, runnerId, generation);

  /** A session whose message P1 was handed and started on, cut by the stop with `interrupt` (payload), then taken over by P2. */
  async function cutAndReclaimed(interrupt: Record<string, unknown>) {
    const f = await fixture();
    const sessionId = await runningSession(f, 'Backfill missing shard rows');
    const turn = await db.conversationTurn.create({
      data: { sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'backfill the missing shard rows', status: 'PENDING' },
      select: { id: true },
    });
    const runner = { id: f.runnerId };
    const p1 = randomUUID(), g1 = randomUUID();
    await api.takeoverLeases(runner, sessionId, { leaseOwner: p1, expectedLeaseOwner: null } as never);
    await api.activateLeases(runner, sessionId, { leaseGeneration: g1, leaseOwner: p1 } as never);
    assert.equal((await fetchTurn(f.runnerId, sessionId, g1))?.content, 'backfill the missing shard rows');
    const ts = () => new Date().toISOString();
    await api.events(runner, sessionId, { leaseOwner: p1, events: [
      { seq: 1, type: RunEventType.USER, ts: ts(), turnId: turn.id, payload: { text: 'backfill the missing shard rows' } },
      { seq: 2, type: RunEventType.TOOL_USE, ts: ts(), turnId: turn.id, payload: { id: 'toolu_1', name: 'Bash', input: { command: 'sleep 25' } } },
      { seq: 3, type: RunEventType.INTERRUPT, ts: ts(), turnId: turn.id, payload: interrupt },
    ] } as never);
    const p2 = randomUUID(), g2 = randomUUID();
    await api.takeoverLeases(runner, sessionId, { leaseOwner: p2, expectedLeaseOwner: p1 } as never);
    await api.activateLeases(runner, sessionId, { leaseGeneration: g2, leaseOwner: p2 } as never);
    const handed = await fetchTurn(f.runnerId, sessionId, g2);
    return { f, sessionId, turnId: turn.id, p2, handed };
  }

  await t.test('(4) the turn Update Now cut is handed back as the update’s continuation, and its echo keeps it as Orbit’s', async () => {
    const cut = await cutAndReclaimed({ reason: 'runner_update', targetVersion: '0.1.254' });
    assert.equal(cut.handed?.turnId, cut.turnId, 'the cut turn was not handed back to the updated runner');
    const content = cut.handed?.content ?? '';
    assert.ok(content.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE} Orbit updated its runner to 0.1.254`), content);
    assert.match(content, /never repeat any operation with side effects/);
    assert.match(content, /The interrupted message:\nbackfill the missing shard rows$/);

    // The updated runner echoes what it was handed, with a background-jobs note after it.
    await api.events({ id: cut.f.runnerId }, cut.sessionId, { leaseOwner: cut.p2, events: [
      { seq: 4, type: RunEventType.USER, ts: new Date().toISOString(), turnId: cut.turnId,
        payload: { text: `${content}\n\n<background-jobs>\nEnded while you were away: none\n</background-jobs>` } },
    ] } as never);
    const echo = await db.runEvent.findFirstOrThrow({ where: { sessionId: cut.sessionId, seq: 4 }, select: { payload: true } });
    const payload = echo.payload as { text: string; controlPlaneNote?: string };
    assert.ok(payload.text.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE}`));
    assert.equal(payload.controlPlaneNote, '\n\n<background-jobs>\nEnded while you were away: none\n</background-jobs>',
      'the note delivery appended was not told apart from the continuation');

    const restart = await cutAndReclaimed({ reason: 'runner_restart' });
    assert.ok(restart.handed?.content?.startsWith('[Orbit] The last message you were working on was interrupted because its runner restarted'),
      `a plain restart's turn lost its own continuation: ${restart.handed?.content}`);
  });
});
