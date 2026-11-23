/**
 * A turn the owner's Update Now of a busy Orbit Cloud runner cut (managed-runner-update-cut.ts), against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, through the production handlers: the runner's events,
 * the next process's takeover and its fetch of the turn (RunnerApiController).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-update-cut.pg.spec.ts
 *
 *   (1) Docker's SIGTERM stops the runner the way every runner image stops: the turn in flight is cut once its drain
 *       runs out, marked `interrupt {reason: runner_restart}`. While its mapping's Update Now that may interrupt turns
 *       is in progress, the cut is stored as the update's (`runner_update`, the runner's own reason kept as
 *       `reportedReason`), and the next process is handed the turn back as the update's continuation, opening with
 *       RUNNER_UPDATE_RESUME_NOTE; its echo is stored as Orbit's;
 *   (2) a cut the old process's spool re-sends after the next generation ended the update, stamped before that end, is
 *       the update's too;
 *   (3) every other cut keeps the restart's own continuation: under a request that interrupts nothing (an idle
 *       runner's), from before the request, after the update ended, and on a runner with no mapping.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RUNNER_UPDATE_RESUME_NOTE, RunEventType, type RunInboxResponse } from '@orbit/shared';
import { RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import '../test-support/dequeue-under-lease';

const URL = process.env.COORDINATOR_PG_URL;
const UPDATE_HEAD = `[Orbit] ${RUNNER_UPDATE_RESUME_NOTE} Orbit updated its runner at the owner's request, which stopped this turn`;
const RESTART_HEAD = '[Orbit] The last message you were working on was interrupted because its runner restarted';

test('a turn an Orbit Cloud runner\'s Update Now cut is handed back as the update\'s continuation', {
  skip: !URL, timeout: 300_000, concurrency: 1,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });

  const realtime = new Proxy({
    publishSessionUpdated: () => undefined,
    drainCancellations: async () => [],
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
    drainArtifactRequests: async () => [],
  }, { get: (target, key) => (key in target ? (target as Record<string, unknown>)[key as string] : () => undefined) });
  const api = new RunnerApiController(db as never, { notifySessionQueued: () => undefined } as never, realtime as never, {} as never, {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const fetchTurn = (runnerId: string, sessionId: string, generation: string) =>
    (api as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<RunInboxResponse | null>;
    }).dequeueTurn.call(api, sessionId, runnerId, generation);

  /** An owner's runner with a workspace; with `window`, an Orbit Cloud runner whose mapping records that Update Now. */
  async function runnerOf(window?: { updateRequestedAt: Date | null; updateCompletedAt?: Date | null; updateInterruptTurns: boolean }) {
    const ownerId = randomUUID(), runnerId = randomUUID(), workspaceId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@update-cut.invalid`, name: 'Update cut test', passwordHash: 'x' } });
    await db.runner.create({ data: { id: runnerId, ownerId, name: 'Orbit Cloud', tokenHash: randomUUID(), status: 'ONLINE', lastHeartbeatAt: new Date() } });
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'cloud-workspace', enabled: true } });
    if (window) {
      await db.managedRunner.create({ data: {
        ownerId, runnerId, backend: 'docker', clusterKey: `update-cut-${randomUUID().slice(0, 8)}`, namespace: 'update-cut',
        pvcName: `mr-data-${runnerId}`, managementState: 'READY', desiredState: 'RUNNING', updateRequestedBy: ownerId,
        updateRequestedAt: window.updateRequestedAt, updateCompletedAt: window.updateCompletedAt ?? null, updateInterruptTurns: window.updateInterruptTurns,
      } });
    }
    return { ownerId, runnerId, workspaceId };
  }

  /**
   * A session whose message process P1 was handed and started on — the engine ran a tool — and whose turn P1's stop then
   * cut, stamped `cutAt`, as Docker's SIGTERM makes every runner image mark it; then process P2 (the next generation,
   * on the same runner) takes the session over and fetches the turn.
   */
  async function cutAndReclaimed(f: { ownerId: string; runnerId: string; workspaceId: string }, cutAt: Date, beforeTakeover?: () => Promise<void>) {
    const sessionId = randomUUID();
    await db.session.create({ data: {
      id: sessionId, ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.workspaceId, assignedRunnerId: f.runnerId, title: 'A long build',
      prompt: 'build it', provider: 'claude', status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(), runClaimedAt: new Date(Date.now() - 10 * 60_000), runtimeSessionId: randomUUID(),
    } });
    const turn = await db.conversationTurn.create({
      data: { sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'build the release artifacts', status: 'PENDING' },
      select: { id: true },
    });
    const runner = { id: f.runnerId };
    const p1 = randomUUID(), g1 = randomUUID();
    await api.takeoverLeases(runner, sessionId, { leaseOwner: p1, expectedLeaseOwner: null } as never);
    await api.activateLeases(runner, sessionId, { leaseGeneration: g1, leaseOwner: p1 } as never);
    assert.equal((await fetchTurn(f.runnerId, sessionId, g1))?.content, 'build the release artifacts');
    const ts = () => new Date().toISOString();
    await api.events(runner, sessionId, { leaseOwner: p1, events: [
      { seq: 1, type: RunEventType.USER, ts: ts(), turnId: turn.id, payload: { text: 'build the release artifacts' } },
      { seq: 2, type: RunEventType.TOOL_USE, ts: ts(), turnId: turn.id, payload: { id: 'toolu_1', name: 'Bash', input: { command: 'make release' } } },
    ] } as never);
    const cut = { seq: 3, type: RunEventType.INTERRUPT, ts: cutAt.toISOString(), turnId: turn.id, payload: { reason: 'runner_restart' } };
    if (beforeTakeover) await beforeTakeover();
    await api.events(runner, sessionId, { leaseOwner: p1, events: [cut] } as never);
    const p2 = randomUUID(), g2 = randomUUID();
    await api.takeoverLeases(runner, sessionId, { leaseOwner: p2, expectedLeaseOwner: p1 } as never);
    await api.activateLeases(runner, sessionId, { leaseGeneration: g2, leaseOwner: p2 } as never);
    const handed = await fetchTurn(f.runnerId, sessionId, g2);
    const stored = await db.runEvent.findFirstOrThrow({ where: { sessionId, seq: 3 }, select: { payload: true } });
    return { sessionId, turnId: turn.id, p2, handed, stored: stored.payload as Record<string, unknown> };
  }

  await t.test('(1) cut while the owner\'s Update Now stops the runner: stored as the update\'s, and handed back as its continuation', async () => {
    const asked = new Date(Date.now() - 3 * 60_000);
    const f = await runnerOf({ updateRequestedAt: asked, updateInterruptTurns: true });
    const cut = await cutAndReclaimed(f, new Date(asked.getTime() + 100_000));
    assert.deepEqual(cut.stored, { reason: 'runner_update', reportedReason: 'runner_restart' }, 'the update\'s cut, with the runner\'s own reason beside it');
    assert.equal(cut.handed?.turnId, cut.turnId, 'the cut turn is handed back to the next process');
    const content = cut.handed?.content ?? '';
    assert.ok(content.startsWith(UPDATE_HEAD), content);
    assert.match(content, /never repeat any operation with side effects/);
    assert.match(content, /The interrupted message:\nbuild the release artifacts$/);

    // The next process echoes what it was handed: the echo is the continuation, Orbit's, with nothing of the owner's.
    await api.events({ id: f.runnerId }, cut.sessionId, { leaseOwner: cut.p2, events: [
      { seq: 4, type: RunEventType.USER, ts: new Date().toISOString(), turnId: cut.turnId, payload: { text: content } },
    ] } as never);
    const echo = await db.runEvent.findFirstOrThrow({ where: { sessionId: cut.sessionId, seq: 4 }, select: { payload: true } });
    assert.ok((echo.payload as { text: string }).text.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE}`));
    assert.equal((echo.payload as { controlPlaneNote?: string }).controlPlaneNote, undefined);
  });

  await t.test('(2) a cut re-sent after the update ended, stamped before its end, is the update\'s', async () => {
    const asked = new Date(Date.now() - 10 * 60_000);
    const f = await runnerOf({ updateRequestedAt: asked, updateInterruptTurns: true });
    const cutAt = new Date(asked.getTime() + 100_000);
    // The next generation is READY, which ends the update, before the old process's spool delivers the cut.
    const cut = await cutAndReclaimed(f, cutAt, async () => {
      await db.managedRunner.update({ where: { runnerId: f.runnerId }, data: { updateCompletedAt: new Date(cutAt.getTime() + 120_000) } });
    });
    assert.equal(cut.stored.reason, 'runner_update');
    assert.ok((cut.handed?.content ?? '').startsWith(UPDATE_HEAD), cut.handed?.content ?? 'nothing handed');
  });

  await t.test('(3) every other cut keeps the restart\'s continuation', async () => {
    const asked = new Date(Date.now() - 10 * 60_000);
    const cases = [
      { label: 'an idle runner\'s request, which interrupts nothing', window: { updateRequestedAt: asked, updateInterruptTurns: false }, cutAt: new Date(asked.getTime() + 60_000) },
      { label: 'a cut from before the request', window: { updateRequestedAt: asked, updateInterruptTurns: true }, cutAt: new Date(asked.getTime() - 60_000) },
      { label: 'a cut after the update ended', window: { updateRequestedAt: asked, updateCompletedAt: new Date(asked.getTime() + 120_000), updateInterruptTurns: true }, cutAt: new Date(asked.getTime() + 300_000) },
      { label: 'a runner with no mapping', window: undefined, cutAt: new Date() },
    ];
    for (const { label, window, cutAt } of cases) {
      const cut = await cutAndReclaimed(await runnerOf(window), cutAt);
      assert.deepEqual(cut.stored, { reason: 'runner_restart' }, `${label}: stored as the runner said`);
      assert.ok(cut.handed?.content?.startsWith(RESTART_HEAD), `${label}: ${cut.handed?.content}`);
    }
  });
});
