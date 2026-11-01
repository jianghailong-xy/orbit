// First, before anything loads shared/public-surface.guard.ts, which reads TRUSTED_PROXIES once: 198.51.100.0/24
// stands for Cloudflare's edges, so a check through one is decided from its headers.
process.env.TRUSTED_PROXIES = '198.51.100.0/24';

/**
 * The check route's push (docs/claude-region-check-contract.md §10, board 04 "push (flip)"): the owner hears of a
 * confirmed flip once — on the blocked check that takes blockedChecks to 2 — and never of a single blocked check, of the
 * checks after the flip, or of an unknown check that finds the count at 2. The stored row is the one recordRegionCheck
 * answers; its counting on real PostgreSQL is queue/claude-region-hold.pg.spec.ts (9).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RunnerRegion } from '@orbit/shared';

import { RunnerApiController } from './runner-api.controller';

function stored(over: Partial<RunnerRegion>): RunnerRegion {
  return {
    verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false,
    decidedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), blockedChecks: 1, ...over,
  };
}

/** One check through an edge with `country`, the row it leaves behind, and what the push was asked to send. */
async function checkThrough(country: string | undefined, row: RunnerRegion | null) {
  const pushed: Array<{ runnerId: string; region: string }> = [];
  const prisma = { $queryRaw: async () => (row ? [{ region: row }] : []) };
  const push = { notifyClaudeRegionBlocked: async (runnerId: string, region: string) => { pushed.push({ runnerId, region }); } };
  const api = new RunnerApiController(prisma as never, {} as never, {} as never, push as never, {} as never, {} as never);
  const request = {
    headers: { 'x-real-ip': '198.51.100.7', ...(country ? { 'cf-ipcountry': country } : {}) },
    socket: { remoteAddress: '10.0.0.2' },
  };
  const answer = await api.regionCheck({ id: 'runner-1' }, request as never, '1');
  return { answer, pushed };
}

test('the check that confirms the flip pushes once, naming the place', async () => {
  const { answer, pushed } = await checkThrough('CN', stored({ blockedChecks: 2 }));
  assert.equal(answer.verdict, 'blocked', 'the edge’s headers decided it');
  assert.deepEqual(pushed, [{ runnerId: 'runner-1', region: 'mainland China' }]);
});

test('a single blocked check, the checks after the flip, and every other answer push nothing', async () => {
  for (const [what, country, row] of [
    ['a single blocked check', 'CN', stored({ blockedChecks: 1 })],
    ['a check after the flip', 'CN', stored({ blockedChecks: 3 })],
    ['an unknown check right after the flip', 'XX', stored({ blockedChecks: 2 })],
    ['an allowed check', 'US', stored({ verdict: 'allowed', country: 'US', name: 'United States', blockedChecks: 0 })],
    ['a check that keeps no row', undefined, null],
  ] as const) {
    const { pushed } = await checkThrough(country, row);
    assert.deepEqual(pushed, [], what);
  }
});
