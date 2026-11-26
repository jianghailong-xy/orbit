/**
 * The managed runner manager's slow retry tier (docs/managed-runner-design.md, "Implementation record: failure
 * recovery and visibility", the slow retry): a runner whose container keeps dying is never left needing a manual
 * retry. Over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, against the in-memory Kubernetes
 * namespace of test-support/fake-kube-client.ts; the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-slow-retry.pg.spec.ts
 *
 *   (1) consecutive POD_OUT_OF_MEMORY stops: the fast attempts, then FAILED with its next try 15 min, 30 min, 1 h,
 *       2 h, 4 h and 6 h away, and 6 h from then on; demand is told it comes back, and when. A due pass with no work
 *       waiting starts nothing and writes nothing; with work waiting it goes back to REQUESTED with the stopped
 *       instance recorded, its attempts kept, and the next generation is started only through the single-writer
 *       gate: the stopped Pod removed by UID, its volume detached, the recorded stop proof retired;
 *   (2) a resumed runner whose stopped Pod was replaced by one it did not authorize fences, as an owner's retry
 *       would: no next generation;
 *   (3) the attempt count starts again once a runner ran an hour after its last restart without stopping, even
 *       where it has not stood up (READY twice the longest backoff); a stop within the hour still counts;
 *   (4) a failure that needs an operator (PVC_CONFLICT) still parks FAILED with no next try, whatever work waits.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { ManagedRunner, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { managedRunnerWorld, type ManagedRunnerWorld } from '../test-support/managed-runner-world';
import type { PersistentVolumeClaim, Pod } from './kube-client';
import { demandAnswer } from './managed-runner-demand';
import { ATTEMPT_RESET_MS } from './managed-runner-manager';
import type { ManagedRunnerProfile } from './managed-runner-profile';
import { buildManagedPvc, managedPodName } from './managed-runner-resources';
import { managedRunnerWaitingWork } from './managed-runner-work';

const URL = process.env.COORDINATOR_PG_URL;
const MIN = 60_000;

test('managed runner slow retry: a crash loop keeps being tried on a growing backoff while work waits', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const world = (lifecycle: Partial<ManagedRunnerProfile['lifecycle']> = {}) => {
    const logs: string[] = [];
    const w = managedRunnerWorld(db, { lifecycle, log: { warn: (m: string) => void logs.push(m), error: (m: string) => void logs.push(m) } });
    return Object.assign(w, { logs });
  };
  const codeOf = (m: ManagedRunner) => (m.lastError as { code?: string } | null)?.code ?? null;
  const oom = (w: ManagedRunnerWorld, m: ManagedRunner) => w.cluster.stopPod(managedPodName(m.runnerId), 137, 'OOMKilled');
  const podsOnVolume = (w: ManagedRunnerWorld, m: ManagedRunner) =>
    w.cluster.all<Pod>('pods').filter((pod) => (pod.spec.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === m.pvcName)).length;

  /** A turn queued on the runner: work waiting for it. */
  async function queueTurn(m: ManagedRunner): Promise<string> {
    const workspace = await db.workspace.create({ data: { ownerId: m.ownerId, runnerId: m.runnerId, targetRunnerId: m.runnerId, name: `w-${randomUUID().slice(0, 6)}`, workDir: '/home/orbit/w' } });
    const session = await db.session.create({
      data: { ownerId: m.ownerId, creatorId: m.ownerId, workspaceId: workspace.id, assignedRunnerId: m.runnerId, title: 'Waiting', prompt: 'hello', provider: 'claude', turnState: 'QUEUED' },
    });
    return session.id;
  }

  await t.test('(1) consecutive out-of-memory stops: growing slow retries, taken only while work waits, through the gate', async () => {
    const w = world();
    const { maxAttempts } = w.profile.lifecycle;
    assert.equal(maxAttempts, 3, 'the fixture profile\'s fast attempts');
    const { ownerId, mapping } = await w.readyRunner('slow-oom');
    // The fast attempts: started again after the short backoff, as before.
    for (let stop = 1; stop < maxAttempts; stop += 1) {
      oom(w, await w.mappingOf(ownerId));
      assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF');
      assert.deepEqual([(await w.mappingOf(ownerId)).attempt, codeOf(await w.mappingOf(ownerId))], [stop, 'POD_RESTARTING_OUT_OF_MEMORY']);
      assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    }

    const expected = [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 360 * MIN, 360 * MIN];
    let work: string | null = null;
    for (const [i, delay] of expected.entries()) {
      const before = await w.mappingOf(ownerId);
      assert.equal(before.managementState, 'READY');
      oom(w, before);
      const stoppedAt = w.now().getTime();
      assert.equal(await w.primary.reconcile(mapping.id), 'FAILED', `stop ${maxAttempts + i}`);
      const failed = await w.mappingOf(ownerId);
      assert.deepEqual(
        { state: failed.managementState, code: codeOf(failed), retryable: (failed.lastError as { retryable: boolean }).retryable, attempt: failed.attempt, podUid: failed.podUid, generation: failed.generation },
        { state: 'FAILED', code: 'POD_OUT_OF_MEMORY', retryable: true, attempt: maxAttempts + i, podUid: before.podUid, generation: before.generation },
      );
      assert.ok(failed.nextAttemptAt, `stop ${maxAttempts + i}: a next try is recorded`);
      assert.equal(failed.nextAttemptAt.getTime() - stoppedAt, delay, `stop ${maxAttempts + i}: the next try ${delay / MIN} min away`);
      assert.equal((failed.fencingReceipt as { kind: string; predecessor: { podUid: string } }).kind, 'OBSERVED_STOP');
      assert.equal((failed.fencingReceipt as { predecessor: { podUid: string } }).predecessor.podUid, before.podUid, 'the stop proof names the stopped Pod');
      assert.match(w.logs.filter((l) => l.includes('POD_TERMINATED')).at(-1)!, new RegExp(`out of memory; FAILED: attempt ${maxAttempts + i} of ${maxAttempts} in a row; tried again in ${delay / MIN} min while work is waiting`));

      // Demand is told it comes back by itself, and when.
      assert.deepEqual(
        (({ comingBack, state, retryAfter }) => ({ comingBack, state, retryAfter }))(demandAnswer(failed)),
        { comingBack: true, state: 'FAILED', retryAfter: failed.nextAttemptAt },
      );

      // Before it is due: not picked up, nothing done.
      assert.ok(!(await w.primary.dueMappings(500)).includes(mapping.id), 'not due yet');
      assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
      assert.equal((await w.mappingOf(ownerId)).revision, failed.revision, 'nothing written before it is due');

      w.clock.ms = failed.nextAttemptAt.getTime() + 1;
      assert.ok((await w.primary.dueMappings(500)).includes(mapping.id), 'due: picked up');
      if (i === 0) {
        // Due, and no work waiting: nothing is started, nothing written; it stays due for when work comes.
        assert.deepEqual(await managedRunnerWaitingWork(w.prisma, mapping.runnerId), []);
        assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
        const idle = await w.mappingOf(ownerId);
        assert.deepEqual(
          { state: idle.managementState, revision: idle.revision, generation: idle.generation, podUid: idle.podUid },
          { state: 'FAILED', revision: failed.revision, generation: failed.generation, podUid: failed.podUid },
        );
        assert.equal(w.cluster.object<Pod>('pods', managedPodName(mapping.runnerId))?.metadata.uid, failed.podUid, 'the stopped Pod is left as it is');
        assert.ok((await w.primary.dueMappings(500)).includes(mapping.id), 'still due');
        work = await queueTurn(failed);
        assert.deepEqual(await managedRunnerWaitingWork(w.prisma, mapping.runnerId), ['QUEUED_TURN']);
      }
      assert.ok(work);

      // Due with work waiting: back to REQUESTED, as an owner's retry leaves it — the stopped Pod still recorded —
      // but with its attempts kept. The volume is held attached so the gate's wait for it can be seen.
      const removedBefore = w.cluster.count('delete', 'pods');
      w.cluster.autoDetach = false;
      const step = await w.primary.reconcile(mapping.id);
      assert.equal(step, 'WAITING', 'the gate waits for the stopped Pod\'s volume');
      const resumed = await w.mappingOf(ownerId);
      assert.deepEqual(
        { state: resumed.managementState, generation: resumed.generation, podUid: resumed.podUid, attempt: resumed.attempt, code: codeOf(resumed), next: resumed.nextAttemptAt },
        { state: 'REQUESTED', generation: failed.generation, podUid: failed.podUid, attempt: failed.attempt, code: 'VOLUME_STILL_ATTACHED', next: null },
        'no next generation while the stopped Pod\'s volume is attached',
      );
      assert.equal(w.cluster.count('delete', 'pods'), removedBefore + 1, 'the stopped Pod removed once, by the gate');
      assert.equal(w.cluster.object('pods', managedPodName(mapping.runnerId)), undefined);
      assert.equal(await w.primary.reconcile(mapping.id), 'WAITING', 'still attached: still waiting');
      assert.equal((await w.mappingOf(ownerId)).generation, failed.generation);

      // Detached: the gate retires the stopped generation on its recorded stop proof, and the next one starts.
      w.cluster.detach(w.cluster.object<PersistentVolumeClaim>('persistentvolumeclaims', mapping.pvcName)!.spec.volumeName!);
      w.cluster.autoDetach = true;
      const outcomes = await w.drive(ownerId, ['READY'], w.primary, 40);
      assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
      const back = await w.mappingOf(ownerId);
      assert.equal(back.generation, failed.generation + 1, 'the next generation');
      assert.notEqual(back.podUid, failed.podUid);
      const retired = back.fencingReceipt as { kind: string; predecessor: { podUid: string; generation: number }; retiredAt?: string };
      assert.deepEqual(
        { kind: retired.kind, podUid: retired.predecessor.podUid, generation: retired.predecessor.generation, retired: typeof retired.retiredAt },
        { kind: 'OBSERVED_STOP', podUid: failed.podUid, generation: failed.generation, retired: 'string' },
        'retired on the stop proof of the Pod that stopped',
      );
      assert.equal(back.attempt, failed.attempt, 'READY: the attempts still count until it has stayed up');
      assert.equal(back.pvcUid, mapping.pvcUid, 'the same volume');
      assert.equal(podsOnVolume(w, back), 1, 'one Pod on the volume');
      assert.ok(w.logs.some((l) => l.includes('its slow retry due and work waiting (QUEUED_TURN)')));
    }
  });

  await t.test('(2) a resumed runner whose stopped Pod was replaced unobserved fences: no next generation', async () => {
    const w = world({ maxAttempts: 1 });
    const { ownerId, mapping } = await w.readyRunner('slow-replaced');
    oom(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    const failed = await w.mappingOf(ownerId);
    assert.equal(failed.nextAttemptAt!.getTime() - w.now().getTime(), 15 * MIN);
    await queueTurn(failed);
    // Something replaced the stopped Pod under the runner's name.
    const name = managedPodName(mapping.runnerId);
    const stopped = w.cluster.object<Pod>('pods', name)!;
    w.cluster.remove('pods', name);
    w.cluster.plant('pods', { ...stopped, metadata: { ...stopped.metadata, uid: randomUUID(), finalizers: [] }, status: { phase: 'Running' } });
    w.clock.ms = failed.nextAttemptAt!.getTime() + 1;
    assert.equal(await w.primary.reconcile(mapping.id), 'FENCING');
    const fenced = await w.mappingOf(ownerId);
    assert.deepEqual([fenced.managementState, codeOf(fenced), fenced.generation, fenced.podUid], ['FENCING', 'POD_REPLACED', failed.generation, failed.podUid]);
    assert.equal(demandAnswer(fenced).comingBack, false);
  });

  await t.test('(3) an hour after its last restart without a stop, the attempt count starts again', async () => {
    // The longest backoff an hour: standing up takes two hours READY, so only the time since the restart resets here.
    const w = world({ backoffMaxSeconds: 3600 });
    const { ownerId, mapping } = await w.readyRunner('slow-reset');
    oom(w, mapping);
    assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF');
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const restarted = await w.mappingOf(ownerId);
    assert.equal(restarted.attempt, 1);
    const retiredAt = Date.parse((restarted.fencingReceipt as { retiredAt: string }).retiredAt);

    // Within the hour: the stop counts.
    w.clock.ms = retiredAt + ATTEMPT_RESET_MS - MIN;
    oom(w, restarted);
    assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF');
    assert.equal((await w.mappingOf(ownerId)).attempt, 2, 'a stop within the hour of its restart counts');
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    const again = await w.mappingOf(ownerId);
    assert.equal(again.attempt, 2);

    // An hour after that restart with no stop — READY for that hour, not the two hours standing up takes: counted afresh.
    const since = Date.parse((again.fencingReceipt as { retiredAt: string }).retiredAt);
    w.clock.ms = since + ATTEMPT_RESET_MS + MIN;
    assert.ok(w.now().getTime() - again.stateEnteredAt.getTime() < 2 * 3600 * 1000, 'not stood up');
    oom(w, again);
    assert.equal(await w.primary.reconcile(mapping.id), 'BACKOFF', 'started again at once, not FAILED');
    const reset = await w.mappingOf(ownerId);
    assert.deepEqual([reset.managementState, reset.attempt, codeOf(reset)], ['REQUESTED', 1, 'POD_RESTARTING_OUT_OF_MEMORY']);
  });

  await t.test('(4) a failure that needs an operator still parks FAILED, with no next try', async () => {
    const w = world();
    const ownerId = await w.makeUser('slow-conflict');
    const intruder = await w.makeUser('slow-conflict-other');
    await w.service.ensure(ownerId, 'ensure');
    const mapping = await w.mappingOf(ownerId);
    w.cluster.plant('persistentvolumeclaims', buildManagedPvc({ ownerId: intruder, runnerId: mapping.runnerId, generation: 1, namespace: mapping.namespace }, w.profile));
    assert.equal((await w.drive(ownerId)).at(-1), 'FAILED');
    const failed = await w.mappingOf(ownerId);
    assert.deepEqual(
      [codeOf(failed), (failed.lastError as { retryable: boolean }).retryable, failed.nextAttemptAt],
      ['PVC_CONFLICT', false, null],
    );
    assert.equal(demandAnswer(failed).comingBack, false, 'demand is told it needs a person');
    await queueTurn(failed);
    w.advance(7 * 3600 * 1000);
    assert.ok(!(await w.primary.dueMappings(500)).includes(mapping.id), 'never due');
    assert.equal(await w.primary.reconcile(mapping.id), 'FAILED');
    const still = await w.mappingOf(ownerId);
    assert.deepEqual([still.managementState, still.revision, codeOf(still)], ['FAILED', failed.revision, 'PVC_CONFLICT'], 'nothing written');
  });
});
