import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunnersService } from '../runners/runners.service';
import {
  clampManagedConcurrency,
  concurrencyCeilingForMemory,
  managedConcurrencyCeiling,
  managedConcurrencyClampNotice,
  managedRunnerMemoryLimitBytes,
} from './managed-runner-concurrency';

/**
 * A managed runner's concurrency follows its memory (managed-runner-concurrency.ts): floor((limit − 1 GiB) / 1 GiB),
 * at least 1, clamped where the owner writes the row. A runner somebody runs themselves is never clamped.
 */

const GiB = 2 ** 30;
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

/** A runtime whose profile gives every managed runner `memory` as its container limit. */
function runtimeWith(memory: string, backend: 'kubernetes' | 'docker' = 'kubernetes') {
  const profile = backend === 'docker'
    ? { backend: 'docker', runner: { maxConcurrent: 2, resources: { cpu: '2', memory, pids: 4096 } } }
    : { runner: { maxConcurrent: 2, resources: { runner: { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '2', memory } }, init: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '100m', memory: '64Mi' } } } } };
  return { available: true, profile } as never;
}

test('the ceiling is one session per GiB above the first, and never less than 1', () => {
  assert.equal(concurrencyCeilingForMemory(4 * GiB), 3, 'the production profile: 4 GiB runs 3');
  assert.equal(concurrencyCeilingForMemory(8 * GiB), 7);
  assert.equal(concurrencyCeilingForMemory(2 * GiB), 1);
  assert.equal(concurrencyCeilingForMemory(1.5 * GiB), 1);
  assert.equal(concurrencyCeilingForMemory(GiB), 1, 'a runner always runs one');
  assert.equal(concurrencyCeilingForMemory(512 * 2 ** 20), 1);
});

test('the limit is the Kubernetes runner container\'s or the Docker container\'s, as the profile states it', () => {
  assert.equal(managedRunnerMemoryLimitBytes((runtimeWith('4Gi') as { profile: never }).profile), 4 * GiB);
  assert.equal(managedRunnerMemoryLimitBytes((runtimeWith('6Gi', 'docker') as { profile: never }).profile), 6 * GiB);
  assert.deepEqual(managedConcurrencyCeiling(runtimeWith('4Gi')), { ceiling: 3, limitBytes: 4 * GiB });
  assert.equal(managedConcurrencyCeiling(null), null, 'no runtime, no ceiling');
  assert.equal(managedConcurrencyCeiling({ available: false, problems: ['x'] }), null, 'no profile, no ceiling');
  assert.equal(clampManagedConcurrency(8, { ceiling: 3, limitBytes: 4 * GiB }), 3);
  assert.equal(clampManagedConcurrency(2, { ceiling: 3, limitBytes: 4 * GiB }), 2);
  assert.equal(clampManagedConcurrency(8, null), 8);
  assert.equal(
    managedConcurrencyClampNotice(8, { ceiling: 3, limitBytes: 4 * GiB }),
    'This managed runner has 4 GiB of memory, enough for 3 sessions at once, so Max Concurrent was set to 3 instead of 8.',
  );
  assert.equal(
    managedConcurrencyClampNotice(2, { ceiling: 1, limitBytes: 1536 * 2 ** 20 }),
    'This managed runner has 1536 MiB of memory, enough for 1 session at once, so Max Concurrent was set to 1 instead of 2.',
  );
});

/** RunnersService over one runner row, managed (it has a mapping) or not; records what the update wrote. */
function runnersWorld(options: { managed: boolean; runtime?: unknown }) {
  const writes: Array<Record<string, unknown>> = [];
  const mappingReads: unknown[] = [];
  let stored = 2;
  const prisma = {
    runner: {
      findFirst: async () => ({ id: RUNNER_ID, ownerId: OWNER_ID, maxConcurrent: stored }),
      update: async (args: { data: { maxConcurrent?: number } }) => {
        writes.push(args.data);
        if (args.data.maxConcurrent !== undefined) stored = args.data.maxConcurrent;
        return { id: RUNNER_ID, name: 'Orbit Cloud', displayName: null, maxConcurrent: stored, minFreeDiskMb: null };
      },
    },
    managedRunner: {
      findUnique: async (args: { where: unknown }) => {
        mappingReads.push(args.where);
        return options.managed ? { id: '33333333-3333-4333-8333-333333333333' } : null;
      },
    },
  } as never;
  return { service: new RunnersService(prisma, undefined, options.runtime as never), writes, mappingReads };
}

test('maxConcurrent 8 on a managed runner with a 4 GiB limit stores 3, and the answer tells the owner why', async () => {
  const w = runnersWorld({ managed: true, runtime: runtimeWith('4Gi') });
  const answer = await w.service.updateRunner(OWNER_ID, RUNNER_ID, { maxConcurrent: 8 });
  assert.equal(w.writes.at(-1)?.maxConcurrent, 3, 'the row holds the clamped value');
  assert.equal(answer.maxConcurrent, 3);
  assert.equal(
    (answer as { notice?: string }).notice,
    'This managed runner has 4 GiB of memory, enough for 3 sessions at once, so Max Concurrent was set to 3 instead of 8.',
  );
  assert.deepEqual(w.mappingReads, [{ runnerId: RUNNER_ID }]);
});

test('a managed runner set within its ceiling stores what was set, with nothing to say', async () => {
  const w = runnersWorld({ managed: true, runtime: runtimeWith('4Gi') });
  const answer = await w.service.updateRunner(OWNER_ID, RUNNER_ID, { maxConcurrent: 3 });
  assert.equal(w.writes.at(-1)?.maxConcurrent, 3);
  assert.equal('notice' in answer, false);
});

test('a self-hosted runner is unchanged: maxConcurrent 8 stores 8, whatever the managed profile says', async () => {
  const w = runnersWorld({ managed: false, runtime: runtimeWith('4Gi') });
  const answer = await w.service.updateRunner(OWNER_ID, RUNNER_ID, { maxConcurrent: 8 });
  assert.equal(w.writes.at(-1)?.maxConcurrent, 8);
  assert.equal(answer.maxConcurrent, 8);
  assert.equal('notice' in answer, false);
});

test('with no managed runner runtime (the switch off) nothing is clamped, and no mapping is read', async () => {
  const w = runnersWorld({ managed: true });
  assert.equal((await w.service.updateRunner(OWNER_ID, RUNNER_ID, { maxConcurrent: 8 })).maxConcurrent, 8);
  assert.deepEqual(w.mappingReads, []);
});
