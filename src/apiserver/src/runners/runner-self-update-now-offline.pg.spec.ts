/**
 * UPDATE NOW WHEN THE RUNNER DOES NOT COME BACK (docs/runner-update-drain-design.md D4; the probe's "What Update Now
 * must add", item 5) against a real PostgreSQL, through the production reaper, auto-retry and inbox:
 *
 *   (1) The owner's Update Now cut a turn mid-call (the runner marked it `interrupt {reason: runner_update,
 *       targetVersion}`) and the runner never came back: the session does not read RUNNING forever. Once the runner
 *       has been silent past the reaper's bound (RUNNER_REAP_AFTER_MS, five minutes) it is FAILED with the existing
 *       `runner offline` wording, and a retry is armed.
 *   (2) While the runner stays away, the retry is not spent: the sweep releases nothing onto a machine it believes
 *       is down.
 *   (3) The runner comes back later: the retry re-sends the cut turn as the update's continuation — Orbit's words,
 *       "[Orbit] The runner update interrupted this turn; continue. Orbit updated its runner to 0.1.255 …" quoting the
 *       owner's message — not the owner's message again, whose side effects the engine had already begun. The inbox
 *       hands it to the runner as that continuation.
 *   (4) Control: a turn a plain runner restart cut, reaped and retried the same way, is re-sent as the owner's
 *       message, as before.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-self-update-now-offline.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus, RunnerStatus, SessionDispatchOrigin, SessionRunSource, type PrismaClient } from '@prisma/client';
import { RUNNER_UPDATE_RESUME_NOTE, RunEventType, SELF_UPDATE_NOW_V1 } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RUNNER_REAP_AFTER_MS, ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { SessionsService } from '../sessions/sessions.service';
import { AUTO_RETRY_TURN_KEY_PREFIX } from '../sessions/watch-turn-key';
import '../test-support/dequeue-under-lease';

declare global {
  interface BigInt { toJSON(): string; }
}
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const HOUR = 60 * 60 * 1000;
const silent = (): unknown => new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

test('Update Now and a runner that never comes back: runner offline after the bound, resumed with the note if it returns', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(URL!);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const db = prisma as unknown as PrismaService;

  const ownerId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `update-now-offline-${ownerId}@runner.invalid`, name: 'Owner', passwordHash: 'x' } });
  // A machine that stays up, so the other one's silence is its own and not a mass disconnection the reaper holds.
  const steadyId = randomUUID();
  await prisma.runner.create({ data: {
    id: steadyId, ownerId, name: 'steady', tokenHash: sha256(`t-${steadyId}`), status: RunnerStatus.ONLINE,
    lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
  } });

  const queue = { notifySessionQueued: () => undefined };
  const realtime = silent();
  const sessions = new SessionsService(db, queue as never, realtime as never);
  const api = new RunnerApiController(db, queue as never, realtime as never, {} as never, {} as never,
    { expand: async (_owner: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never);
  const reaper = new ReaperService(db, realtime as never);
  const retrier = new AutoRetryService(db, sessions, realtime as never);

  /** studio-mac with a session whose message it took and began working on, cut by a runner stop marked `interrupt`. */
  async function cut(label: string, interrupt: Record<string, unknown>) {
    const runnerId = randomUUID(), workspaceId = randomUUID(), sessionId = randomUUID();
    await prisma.runner.create({ data: {
      id: runnerId, ownerId, name: `studio-mac (${label})`, tokenHash: sha256(`t-${runnerId}`), status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(), capabilities: [SELF_UPDATE_NOW_V1], capabilitiesReportedAt: new Date(),
    } });
    await prisma.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `ws-${label}`, enabled: true } });
    await prisma.session.create({ data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `Backfill missing shard rows (${label})`, prompt: 'Backfill missing shard rows', provider: 'claude',
      status: RunStatus.AWAITING_INPUT, numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${sessionId}`,
      dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
    } });
    const message = `backfill the missing shard rows, then deploy (${label})`;
    await sessions.createTurn(ownerId, sessionId, { clientTurnId: randomUUID(), content: message } as never);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
      await tx.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
    });
    const handed = await (api as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<{ turnId: string; content: string } | null>;
    }).dequeueTurn.call(api, sessionId, runnerId, null);
    assert.equal(handed?.content, message, `${label}: the fixture's first delivery is the owner's message`);
    const ts = () => new Date().toISOString();
    await api.events({ id: runnerId } as never, sessionId, { events: [
      { seq: 1, type: RunEventType.USER, ts: ts(), turnId: handed!.turnId, payload: { text: message } },
      { seq: 2, type: RunEventType.TOOL_USE, ts: ts(), turnId: handed!.turnId, payload: { id: 'toolu_6', name: 'Bash', input: { command: 'deploy' } } },
      { seq: 3, type: RunEventType.TOOL_RESULT, ts: ts(), turnId: handed!.turnId,
        payload: { toolUseId: 'toolu_6', isError: true, interrupted: interrupt.reason, content: '[Tool call interrupted: …]' } },
      { seq: 4, type: RunEventType.INTERRUPT, ts: ts(), turnId: handed!.turnId, payload: interrupt },
    ] } as never);
    return { runnerId, sessionId, turnId: handed!.turnId, message };
  }

  /** The runner goes silent past the bound, the steady one keeps beating, and the reaper sweeps. */
  async function neverComesBack(runnerId: string) {
    await prisma.runner.update({ where: { id: runnerId }, data: { lastHeartbeatAt: new Date(Date.now() - RUNNER_REAP_AFTER_MS - 60_000) } });
    await prisma.runner.update({ where: { id: steadyId }, data: { lastHeartbeatAt: new Date() } });
    await (reaper as unknown as { sweep(): Promise<void> }).sweep();
  }

  const resentOn = (sessionId: string) => prisma.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { startsWith: AUTO_RETRY_TURN_KEY_PREFIX } },
    orderBy: { seq: 'asc' },
  });
  async function retryComesDue(sessionId: string, runnerId: string, back: boolean) {
    await prisma.session.update({ where: { id: sessionId }, data: { retryAt: new Date(Date.now() - HOUR) } });
    if (back) await prisma.runner.update({ where: { id: runnerId }, data: { lastHeartbeatAt: new Date(), status: RunnerStatus.ONLINE } });
    await prisma.runner.update({ where: { id: steadyId }, data: { lastHeartbeatAt: new Date() } });
    await retrier.sweep();
  }

  let updated: Awaited<ReturnType<typeof cut>>;

  await t.test('(1) a runner that never comes back leaves its interrupted session FAILED “runner offline”, not RUNNING, with a retry armed', async () => {
    updated = await cut('update now', { reason: 'runner_update', targetVersion: '0.1.255' });
    // Within the bound, a sweep leaves it alone: the restart is usually under a minute.
    await prisma.runner.update({ where: { id: updated.runnerId }, data: { lastHeartbeatAt: new Date(Date.now() - 60_000) } });
    await (reaper as unknown as { sweep(): Promise<void> }).sweep();
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: updated.sessionId } })).status, RunStatus.RUNNING,
      'reaped inside the bound, while the restart could still be under way');

    await neverComesBack(updated.runnerId);
    const ended = await prisma.session.findUniqueOrThrow({ where: { id: updated.sessionId } });
    assert.equal(ended.status, RunStatus.FAILED, 'still RUNNING after its runner was gone past the bound');
    assert.equal(ended.error, 'runner offline');
    assert.ok(ended.retryAt, 'no retry was armed: nothing would resume it when the runner comes back');
  });

  await t.test('(2) while the runner stays away the retry waits: nothing is re-sent onto a machine that is down', async () => {
    await retryComesDue(updated.sessionId, updated.runnerId, false);
    assert.equal((await resentOn(updated.sessionId)).length, 0, 'the retry re-sent onto a runner that is still away');
    const waiting = await prisma.session.findUniqueOrThrow({ where: { id: updated.sessionId } });
    assert.equal(waiting.status, RunStatus.FAILED);
    assert.ok(waiting.retryAt, 'the retry was given up while the runner was away');
  });

  await t.test('(3) the runner comes back later: the cut turn resumes as the update’s continuation, Orbit’s words, not the owner’s message again', async () => {
    await retryComesDue(updated.sessionId, updated.runnerId, true);
    const [resent, ...more] = await resentOn(updated.sessionId);
    assert.ok(resent, 'the sweep re-sent nothing once the runner was back');
    assert.equal(more.length, 0, 'the sweep re-sent twice');
    assert.ok(resent.content?.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE} Orbit updated its runner to 0.1.255`),
      `re-sent as: ${resent.content}`);
    assert.match(resent.content!, /never repeat any operation with side effects/);
    assert.ok(resent.content!.endsWith(`The interrupted message:\n${updated.message}`));
    assert.ok(resent.clientTurnId.startsWith(`${AUTO_RETRY_TURN_KEY_PREFIX}orbit:`), `not filed as Orbit's words: ${resent.clientTurnId}`);
    const resumed = await prisma.session.findUniqueOrThrow({ where: { id: updated.sessionId } });
    assert.equal(resumed.status, RunStatus.PENDING, 'the session did not queue for the runner that came back');

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
      await tx.session.update({ where: { id: updated.sessionId }, data: { status: RunStatus.RUNNING } });
    });
    const handed = await (api as unknown as {
      dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<{ turnId: string; content: string } | null>;
    }).dequeueTurn.call(api, updated.sessionId, updated.runnerId, null);
    assert.equal(handed?.turnId, resent.id);
    assert.ok(handed?.content.startsWith(`[Orbit] ${RUNNER_UPDATE_RESUME_NOTE}`), `handed to the runner as: ${handed?.content}`);
  });

  await t.test('(4) control: a turn a plain restart cut is re-sent as the owner’s message, as before', async () => {
    const restarted = await cut('restart', { reason: 'runner_restart' });
    await neverComesBack(restarted.runnerId);
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: restarted.sessionId } })).error, 'runner offline');
    await retryComesDue(restarted.sessionId, restarted.runnerId, true);
    const [resent] = await resentOn(restarted.sessionId);
    assert.equal(resent?.content, restarted.message);
  });
});
