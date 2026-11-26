import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus } from '@prisma/client';
import {
  AgentProvider,
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  RunnerStatus,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RealtimeService } from '../realtime/realtime.service';
import { ReaperService, RUNNER_REAP_AFTER_MS } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { runnerLinkCredential } from '../runner-api/runner-link-token';
import { managedRunnerWorld } from '../test-support/managed-runner-world';
import { managedPodName } from './managed-runner-resources';
import { ALLOW_UNFILLED_SESSIONS } from '../test-support/unfilled-sessions';

const URL = process.env.COORDINATOR_PG_URL;

test('managed runner OOM recovery', { skip: !URL }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(ALLOW_UNFILLED_SESSIONS);

  for (const maxAttempts of [3, 2]) {
    await t.test(`first OOM resumes, second OOM interrupts at the ${maxAttempts === 3 ? 'fast' : 'slow'} retry, and heartbeat caps concurrency until stoodUp`, async () => {
      const w = managedRunnerWorld(db, { lifecycle: { maxAttempts } });
      const { ownerId, mapping } = await w.readyRunner(`oom-${maxAttempts}`);
      const runnerId = mapping.runnerId;
      const pod = managedPodName(runnerId);
      const realtime = new RealtimeService(w.prisma, {} as never);
      const controllerArgs = new Array(RunnerApiController.length).fill(undefined) as ConstructorParameters<typeof RunnerApiController>;
      controllerArgs.splice(0, 6,
        w.prisma, {} as never, realtime, {} as never,
        { issue: async () => 'oom-recovery-test-token' } as never,
        { expand: async (_ownerId: string, content?: string) => content } as never,
      );
      controllerArgs[19] = { enabled: true, problem: null };
      controllerArgs[controllerArgs.length - 1] = w.runtime;
      const api = new RunnerApiController(...controllerArgs);
      const workspace = await db.workspace.create({
        data: { ownerId, runnerId, targetRunnerId: runnerId, name: 'OOM test', workDir: '/home/orbit/work' },
      });
      const session = (status: RunStatus) => db.session.create({
        data: {
          ownerId, creatorId: ownerId, assignedRunnerId: runnerId, workspaceId: workspace.id,
          title: status, prompt: 'Run a turn', provider: 'claude', providerBuiltin: true, engine: AgentProvider.CLAUDE,
          status, ...(status === RunStatus.RUNNING ? {
            runtimeSessionId: randomUUID(), startedAt: w.now(), lastTurnAt: w.now(),
          } : {}),
        },
      });
      const running = await session(RunStatus.RUNNING);
      const alsoRunning = await session(RunStatus.RUNNING);
      // A row not yet backfilled (task T3): no turn_state, its stored word decides (docs/session-status-retirement-plan.md
      // §1.4). The stop below finds it in flight as it finds the filled one.
      await db.$executeRawUnsafe('UPDATE session SET turn_state = NULL WHERE id = $1::uuid', alsoRunning.id);
      const idle = await session(RunStatus.AWAITING_INPUT);
      const pending = await session(RunStatus.PENDING);
      const stateOf = (id: string) => db.session.findUniqueOrThrow({ where: { id } });
      const runnerIdentity = { id: runnerId, ownerId };
      const reclaim = async () => (await api.reclaim(runnerIdentity)).sessions;
      const turn = await db.conversationTurn.create({
        data: { sessionId: running.id, seq: 1, kind: 'message', content: 'Run a turn', clientTurnId: randomUUID() },
      });
      const takeOver = async (expectedLeaseOwner: string | null) => {
        const leaseOwner = randomUUID();
        const leaseGeneration = randomUUID();
        await api.takeoverLeases(runnerIdentity, running.id, { leaseOwner, expectedLeaseOwner });
        await api.activateLeases(runnerIdentity, running.id, { leaseOwner, leaseGeneration });
        return { leaseOwner, fetch: () => api.inbox(runnerIdentity, running.id, leaseGeneration) };
      };
      const original = await takeOver(null);
      assert.equal((await original.fetch()).turnId, turn.id);

      // Simulate a legacy row above the memory ceiling. Both heartbeat paths must read the cap.
      await db.runner.update({ where: { id: runnerId }, data: { maxConcurrent: 8 } });
      const effectiveConcurrency = async () => {
        const m = await w.mappingOf(ownerId);
        const runner = await db.runner.findUniqueOrThrow({ where: { id: runnerId } });
        const dto = { status: RunnerStatus.ONLINE, idleCapacity: 1, leaseOwner: randomUUID() };
        const http = await api.heartbeat(runner, dto, undefined, undefined, undefined, {
          mappingId: m.id, generation: m.generation, podUid: m.podUid!,
        });
        const link = await api.heartbeat(runner, dto, MANAGED_RUNNER_INSTANCE_CAPABILITY, undefined, undefined, undefined, {
          leaseOwner: dto.leaseOwner, requestId: null, afterSeq: null, gatewayId: 'oom-test',
          admission: { credential: runnerLinkCredential(runner.tokenHash), ownerId },
        }, {
          'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
          [MANAGED_RUNNER_GENERATION_HEADER]: String(m.generation),
          [MANAGED_RUNNER_POD_UID_HEADER]: m.podUid!,
        });
        assert.equal(link.maxConcurrent, http.maxConcurrent);
        return link.maxConcurrent;
      };
      assert.equal(await effectiveConcurrency(), 3);

      w.cluster.stopPod(pod, 137, 'OOMKilled');
      assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF');
      assert.equal((await w.mappingOf(ownerId)).concurrencyCap, 1);
      // Even when the outage outlasts the reaper's window, the first turn belongs to its replacement.
      const lastBeat = new Date(Date.now() - RUNNER_REAP_AFTER_MS - 1_000);
      const stoppedRunner = await db.runner.update({ where: { id: runnerId }, data: { lastHeartbeatAt: lastBeat } });
      assert.equal(stoppedRunner.status, RunnerStatus.OFFLINE);
      await db.runnerPresence.update({ where: { runnerId }, data: { lastBeatAt: lastBeat } });
      const reaper = new ReaperService(w.prisma, realtime);
      await (reaper as unknown as { sweep(): Promise<void> }).sweep();
      assert.equal((await stateOf(running.id)).status, RunStatus.RUNNING);
      assert.equal((await stateOf(running.id)).retryAt, null);
      assert.equal((await w.drive(ownerId)).at(-1), 'READY');
      assert.equal((await reclaim()).find((s) => s.sessionId === running.id)?.status, RunStatus.RUNNING);
      const firstReplacement = await takeOver(original.leaseOwner);
      assert.equal((await firstReplacement.fetch()).turnId, turn.id, 'the first replacement resumes the in-flight turn');
      assert.equal(await effectiveConcurrency(), 1);
      assert.equal((await stateOf(alsoRunning.id)).turnState, null, 'still a row the backfill has not reached');

      w.cluster.stopPod(pod, 137, 'OOMKilled');
      assert.equal(await w.primary.reconcile(mapping.id), maxAttempts === 3 ? 'BACKOFF' : 'FAILED');
      for (const former of [running, alsoRunning]) {
        const interrupted = await stateOf(former.id);
        assert.equal(interrupted.status, RunStatus.INTERRUPTED);
        assert.equal(interrupted.turnState, 'ABANDONED', 'the runner was stopped under the turn, beside the word');
        assert.equal(interrupted.error, 'Stopped because the machine ran out of memory twice while this turn was running. Send a message to continue.');
        assert.equal(interrupted.lastTurnOutcome, 'INTERRUPTED');
        assert.equal(interrupted.retryAt, null);
        assert.equal(interrupted.finishedAt, null, 'the conversation can still receive a message');
      }
      assert.equal((await stateOf(idle.id)).status, RunStatus.AWAITING_INPUT);
      assert.equal((await stateOf(pending.id)).status, RunStatus.PENDING);
      assert.equal((await w.mappingOf(ownerId)).concurrencyCap, 1);
      const nextAttempt = (await w.mappingOf(ownerId)).nextAttemptAt!;
      w.advance(nextAttempt.getTime() - w.now().getTime() + 1);
      assert.equal((await w.drive(ownerId)).at(-1), 'READY');

      const reclaimed = await reclaim();
      for (const former of [running, alsoRunning]) {
        assert.equal(reclaimed.find((s) => s.sessionId === former.id)?.status, RunStatus.INTERRUPTED, 'cold checkout only');
      }
      const secondReplacement = await takeOver(firstReplacement.leaseOwner);
      assert.equal((await secondReplacement.fetch()).turnId, '', 'the second replacement receives no executable turn');
      const stoodUpAfter = 2 * w.profile.lifecycle.backoffMaxSeconds * 1000;
      w.advance(stoodUpAfter - 1);
      assert.equal(await w.primary.reconcile(mapping.id), 'READY');
      assert.equal(await effectiveConcurrency(), 1);
      w.advance(1);
      assert.equal(await w.primary.reconcile(mapping.id), 'READY');
      assert.equal((await w.mappingOf(ownerId)).concurrencyCap, null);
      assert.equal(await effectiveConcurrency(), 3);
    });
  }
});
