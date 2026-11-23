/**
 * The owner's status says when the managed runner's container was made from an older image than the current one
 * (docs/managed-runner-update-now-design.md, "The status says when the image is old"): `update` with the build it
 * runs (its runner's `managed-<sha>` version) and the current build (the image's `org.opencontainers.image.revision`
 * label, as the channel reports it). The manager on DockerBackend, over the channel that keeps the real one's rules in
 * memory (test-support/fake-docker-channel.ts), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty; the clock is the test's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/managed-runner-image-update.pg.spec.ts
 *
 *   (1) READY on a previous image whose successor carries the label: `update` names both builds, read from the
 *       mapping alone; once the container is made again from the current image, it is gone and the record cleared;
 *   (2) on the current image: no `update`, nothing recorded;
 *   (3) a SLEEPING mapping (and one draining to sleep) of a runner found on a previous image: no `update`;
 *   (4) the current image without the revision label: the server cannot tell, so no `update` and nothing recorded;
 *   (5) images published from a release tag (their `org.opencontainers.image.version` label): an old `managed-<sha>`
 *       runner is compared by commit and a release runner by version, `update` naming the versions; on the current
 *       release, none.
 *
 * Not destructive: every row belongs to a user this run creates, and each world has a pool of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY } from '@orbit/shared';
import { Prisma, type ManagedRunner, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { testDockerRunnerProfile } from '../test-support/docker-runner-profile.fixture';
import { FakeDockerChannel } from '../test-support/fake-docker-channel';
import { DockerBackend } from './docker-backend';
import { ManagedRunnerManager, type ReconcileOutcome } from './managed-runner-manager';
import type { ManagedRunnerRuntime } from './managed-runner-runtime';
import { storedWorkloadFor } from './managed-runner-sleep';
import { ManagedRunnerWorker } from './managed-runner-worker';
import { ManagedRunnerService } from './managed-runner.service';

const URL = process.env.COORDINATOR_PG_URL;
const quiet = { warn: () => undefined, error: () => undefined, log: () => undefined };
const ON = { enabled: true, problem: null } as const;
const IDLE = { activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 0 };
const BUSY = { activeTurns: 1 };
/** The image an upgrade builds, and the commit it was built from. */
const NEXT = `sha256:${'e'.repeat(64)}`;
const OLD_SHA = '95884b154f';
const NEW_SHA = 'a800ca3973';

test('the managed runner status says when its container runs an older image', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  function world() {
    let profile = testDockerRunnerProfile({ clusterKey: `image-update-${randomUUID().slice(0, 8)}` });
    const channel = new FakeDockerChannel(profile.docker.instanceId, profile.runner.image);
    channel.imageRevision = OLD_SHA;
    const clock = { ms: Date.now() };
    const now = () => new Date(clock.ms);
    let manager: ManagedRunnerManager;
    let service: ManagedRunnerService;
    /** The build the runner in the container reports: the one its image was built from, a commit (`managed-<sha>`) or a
     *  release version. */
    let runnerBuild = OLD_SHA;
    const start = () => {
      // Not link-only: a previous image's runner that still beats is left running, as on this deployment today.
      manager = new ManagedRunnerManager(prisma, new DockerBackend(channel, profile), profile, {
        holder: `image-update-${randomUUID().slice(0, 8)}`, now, random: () => 0.5, log: quiet, linkOnly: () => false,
      });
      const runtime: ManagedRunnerRuntime = { available: true, profile, manager, worker: new ManagedRunnerWorker(manager, 60_000, quiet) };
      service = new ManagedRunnerService(prisma, ON, runtime);
    };
    start();
    /** An upgrade: the apiserver and the channel recreated on a new image, the running container left as it is. */
    const upgrade = (revision: string | null, version: string | null = null, image = NEXT) => {
      profile = { ...profile, runner: { ...profile.runner, image } };
      channel.image = image;
      channel.imageRevision = revision;
      channel.imageVersion = version;
      start();
    };
    const advance = (ms: number) => void (clock.ms += ms);
    const mappingOf = async (ownerId: string): Promise<ManagedRunner> => (await db.managedRunner.findUnique({ where: { ownerId } }))!;

    async function heartbeat(runnerId: string, workload: Partial<typeof IDLE> = {}) {
      const mapping = (await db.managedRunner.findUnique({ where: { runnerId } }))!;
      await db.runner.update({
        where: { id: runnerId },
        data: {
          status: 'ONLINE',
          version: /^[0-9a-f]+$/.test(runnerBuild) ? `managed-${runnerBuild}` : runnerBuild,
          lastHeartbeatAt: now(),
          engines: [{ engine: 'codex', installed: true, auth: 'yes' }],
          capabilities: [MANAGED_RUNNER_INSTANCE_CAPABILITY, MANAGED_RUNNER_SLEEP_CAPABILITY],
          managedWorkload: mapping.podUid
            ? (storedWorkloadFor({ ...IDLE, ...workload }, { mappingId: mapping.id, generation: mapping.generation, podUid: mapping.podUid }, false, now()) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        },
      });
    }

    async function drive(ownerId: string): Promise<ReconcileOutcome[]> {
      const outcomes: ReconcileOutcome[] = [];
      for (let i = 0; i < 40; i += 1) {
        const outcome = await manager.reconcile((await mappingOf(ownerId)).id);
        outcomes.push(outcome);
        if (outcome === 'READY' || outcome === 'FAILED') return outcomes;
        const after = await mappingOf(ownerId);
        if (after.podUid && after.managementState === 'STARTING') {
          advance(1_000);
          await heartbeat(after.runnerId);
        }
        if (after.nextAttemptAt && after.nextAttemptAt > now()) clock.ms = after.nextAttemptAt.getTime() + 1;
      }
      return outcomes;
    }

    async function readyRunner(label: string): Promise<{ ownerId: string; mapping: ManagedRunner }> {
      const ownerId = (await db.user.create({ data: { email: `${label}-${randomUUID()}@example.invalid`, name: label } })).id;
      await service.ensure(ownerId, `ensure-${label}`);
      const outcomes = await drive(ownerId);
      assert.equal(outcomes.at(-1), 'READY', `${label}: ${outcomes.join(' → ')}`);
      return { ownerId, mapping: await mappingOf(ownerId) };
    }

    return {
      channel, advance, heartbeat, drive, readyRunner, mappingOf, upgrade,
      set runnerBuild(sha: string) { runnerBuild = sha; },
      get manager() { return manager; },
      get service() { return service; },
    };
  }

  await t.test('(1) READY on a previous image: update names both builds; made again from the current one, it is gone', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('outdated');
    assert.equal((await w.service.status(ownerId)).update, undefined, 'current before the upgrade');

    w.upgrade(NEW_SHA);
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');

    const recorded = await w.mappingOf(ownerId);
    assert.equal(recorded.currentImageSha, NEW_SHA);
    assert.ok(recorded.imageOutdatedSince, 'when it was first found outdated');
    assert.equal(recorded.revision, mapping.revision, 'a record for the status, not a transition');
    const status = await w.service.status(ownerId);
    assert.deepEqual(status.update, { running: { sha: OLD_SHA }, current: { sha: NEW_SHA }, phase: 'available' });

    // The status read asks the backend nothing: the record alone answers.
    const calls = w.channel.calls.length;
    assert.deepEqual((await w.service.status(ownerId)).update, status.update);
    assert.equal(w.channel.calls.length, calls);

    // Found again on the next pass: the time it was first found is kept.
    w.advance(30_000);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.equal((await w.mappingOf(ownerId)).imageOutdatedSince?.getTime(), recorded.imageOutdatedSince!.getTime());

    // The container ends and is made again, from the current image; its runner reports the current build.
    w.channel.exit(mapping.runnerId, 1);
    w.runnerBuild = NEW_SHA;
    const outcomes = await w.drive(ownerId);
    assert.equal(outcomes.at(-1), 'READY', outcomes.join(' → '));
    assert.equal(w.channel.containers.get(`mr-${mapping.runnerId}`)!.request.image, NEXT);
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    const current = await w.mappingOf(ownerId);
    assert.deepEqual({ sha: current.currentImageSha, since: current.imageOutdatedSince }, { sha: null, since: null });
    assert.equal((await w.service.status(ownerId)).update, undefined);
  });

  await t.test('(2) on the current image: no update, nothing recorded', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('current');
    for (let i = 0; i < 3; i += 1) {
      w.advance(30_000);
      await w.heartbeat(mapping.runnerId, BUSY);
      assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    }
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ sha: after.currentImageSha, since: after.imageOutdatedSince }, { sha: null, since: null });
    const status = await w.service.status(ownerId);
    assert.equal(status.managementState, 'READY');
    assert.equal(status.update, undefined);
    assert.equal('update' in status, false);
  });

  await t.test('(3) asleep, or draining to sleep: no update, though the runner was found on a previous image', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('asleep');
    w.upgrade(NEW_SHA);
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.ok((await w.service.status(ownerId)).update, 'found outdated while READY');

    for (const managementState of ['DRAINING', 'SLEEPING'] as const) {
      await prisma.managedRunner.update({ where: { ownerId }, data: { managementState, desiredState: 'SLEEPING', imageRollTo: null } });
      const status = await w.service.status(ownerId);
      assert.equal(status.managementState, managementState);
      assert.equal(status.update, undefined, managementState);
    }
  });

  await t.test('(4) the current image without the revision label: the server cannot tell, so no update', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('unlabelled');
    w.upgrade(null);
    for (let i = 0; i < 2; i += 1) {
      w.advance(30_000);
      await w.heartbeat(mapping.runnerId, BUSY);
      assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    }
    const after = await w.mappingOf(ownerId);
    assert.deepEqual({ sha: after.currentImageSha, since: after.imageOutdatedSince }, { sha: null, since: null });
    assert.equal((await w.service.status(ownerId)).update, undefined);
  });

  await t.test('(5) release images: managed-<sha> by commit, a release runner by version, none on the current release', async () => {
    const w = world();
    const { ownerId, mapping } = await w.readyRunner('release');
    // The first release image, over an old image's runner that reports managed-<sha>.
    w.upgrade(NEW_SHA, '0.1.261-beta.83');
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    let recorded = await w.mappingOf(ownerId);
    assert.deepEqual({ sha: recorded.currentImageSha, version: recorded.currentImageVersion }, { sha: NEW_SHA, version: '0.1.261-beta.83' });
    assert.deepEqual((await w.service.status(ownerId)).update,
      { running: { sha: OLD_SHA }, current: { sha: NEW_SHA, version: '0.1.261-beta.83' }, phase: 'available' });

    // Made again from it: its runner reports the release, and there is no update.
    w.channel.exit(mapping.runnerId, 1);
    w.runnerBuild = '0.1.261-beta.83';
    assert.equal((await w.drive(ownerId)).at(-1), 'READY');
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    recorded = await w.mappingOf(ownerId);
    assert.deepEqual({ sha: recorded.currentImageSha, version: recorded.currentImageVersion }, { sha: null, version: null });
    assert.equal((await w.service.status(ownerId)).update, undefined);

    // The next release: compared by version.
    const LATER_SHA = 'c0ffee1234';
    w.upgrade(LATER_SHA, '0.1.261-beta.84', `sha256:${'f'.repeat(64)}`);
    w.advance(30_000);
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal(await w.manager.reconcile(mapping.id), 'READY');
    assert.deepEqual((await w.service.status(ownerId)).update,
      { running: { sha: '', version: '0.1.261-beta.83' }, current: { sha: LATER_SHA, version: '0.1.261-beta.84' }, phase: 'available' });
    // The runner on that release already (an image the record still calls previous): no update.
    w.runnerBuild = '0.1.261-beta.84';
    await w.heartbeat(mapping.runnerId, BUSY);
    assert.equal((await w.service.status(ownerId)).update, undefined);
  });
});
