import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrismaService } from '../prisma/prisma.service';
import {
  PROJECT_ROLLUP_CANDIDATE_GROWTH_LIMIT,
  PROJECT_ROLLUP_CANDIDATE_REBUILD_MS,
  ProjectRollupCandidateService,
} from './project-rollup-candidate';

/**
 * When the candidate table is rebuilt, without a database in the way. That a rebuild leaves exactly
 * the right rows, and never drops one a concurrent writer appended, is
 * `project-rollup-candidate.pg.spec.ts`; this holds the cadence: at boot, after ten minutes, and as
 * soon as an import has appended more than the growth limit — and a failed rebuild costs nothing.
 */

function fakePrisma(state: { rows: number; rebuilds: number; fail?: boolean }): PrismaService {
  return {
    $executeRaw: async () => {
      if (state.fail) throw new Error('the database went away');
      state.rebuilds += 1;
      return state.rows;
    },
    $queryRaw: async () => [{ rows: state.rows }],
  } as unknown as PrismaService;
}

test('the first tick rebuilds, and a quiet table waits for its ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const state = { rows: 250, rebuilds: 0 };
  const service = new ProjectRollupCandidateService(fakePrisma(state));

  await service.tick();
  assert.equal(state.rebuilds, 1, 'the seed is replaced at boot');

  state.rows += 40;
  t.mock.timers.tick(PROJECT_ROLLUP_CANDIDATE_REBUILD_MS - 1);
  await service.tick();
  assert.equal(state.rebuilds, 1, 'forty appended rows do not bring the rebuild forward');

  t.mock.timers.tick(1);
  await service.tick();
  assert.equal(state.rebuilds, 2, 'ten minutes after the last one, it rebuilds');
});

test('an import that appends more than the growth limit is rebuilt at the next tick', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const state = { rows: 250, rebuilds: 0 };
  const service = new ProjectRollupCandidateService(fakePrisma(state));
  await service.tick();

  state.rows = 250 + PROJECT_ROLLUP_CANDIDATE_GROWTH_LIMIT;
  await service.tick();
  assert.equal(state.rebuilds, 1, 'exactly the limit is still ordinary growth');

  state.rows += 1;
  await service.tick();
  assert.equal(state.rebuilds, 2, 'one past the limit is an import');
});

test('a failed rebuild is retried at the next tick and does not wedge the service', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const state = { rows: 250, rebuilds: 0, fail: true };
  const service = new ProjectRollupCandidateService(fakePrisma(state));
  // The error is logged, not thrown: a tick runs from a timer with nobody to catch it.
  (service as unknown as { logger: { error: () => void } }).logger = { error: () => undefined };

  await service.tick();
  assert.equal(state.rebuilds, 0);

  state.fail = false;
  await service.tick();
  assert.equal(state.rebuilds, 1, 'the boot rebuild that failed is the next tick’s');
});
