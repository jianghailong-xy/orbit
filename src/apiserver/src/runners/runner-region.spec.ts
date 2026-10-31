import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_REGION_CARRY_OVER_MS, CLAUDE_REGION_V1, CLAUDE_REGIONS_AS_OF, type RunnerRegion } from '@orbit/shared';
import {
  REGION_CHECK_REQUEST_TTL_MS,
  parseRunnerRegion,
  regionCheckAnswer,
  regionCheckRequestOf,
  runnerRegionView,
} from './runner-region';

/**
 * The Claude region check's rules on the control plane (runner-region.ts, docs/claude-region-check-contract.md §3–§7),
 * without a database. runner-region-check.pg.spec.ts holds the route, runner.region and the reads on PostgreSQL.
 */

const trusted = (country?: string | string[], regionCode?: string, viaProxy = false) =>
  regionCheckAnswer({ trusted: true, country, regionCode, viaProxy });

test('a trusted request answers what Cloudflare\'s headers decide against the list; any other request is unknown', () => {
  assert.deepEqual(trusted('SG'), {
    verdict: 'allowed', country: 'SG', regionCode: null, name: 'Singapore', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
  });
  assert.deepEqual(trusted('CN', undefined, true), {
    verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: true, asOf: CLAUDE_REGIONS_AS_OF,
  });
  // Ukraine's answer needs the region, as Cloudflare writes it (no country) or in full.
  assert.deepEqual(trusted('UA', '43'), {
    verdict: 'blocked', country: 'UA', regionCode: 'UA-43', name: 'Crimea', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
  });
  assert.equal(trusted('ua', 'UA-14').name, 'Donetsk');
  assert.deepEqual(trusted('UA', '30'), {
    verdict: 'allowed', country: 'UA', regionCode: 'UA-30', name: 'Ukraine', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
  });
  // A region is carried for Ukraine alone.
  assert.equal(trusted('US', 'CA').regionCode, null);
  const unknown = { verdict: 'unknown', country: null, regionCode: null, name: null, viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF };
  // Cloudflare's no-data and Tor codes, Ukraine without a region, no header, and a header sent twice.
  for (const country of ['XX', 'T1', 'UA', undefined, 'ZZ', 'US, CN']) {
    assert.deepEqual(trusted(country), unknown, String(country));
  }
  assert.deepEqual(trusted(['CN', 'CN']), unknown, 'a header given twice');
  // From a hop TRUSTED_PROXIES does not name, the same headers are the client's own words.
  for (const [country, regionCode] of [['CN'], ['UA', '43'], ['SG']] as const) {
    assert.deepEqual(regionCheckAnswer({ trusted: false, country, regionCode, viaProxy: true }), { ...unknown, viaProxy: true });
  }
});

const STORED: RunnerRegion = {
  verdict: 'blocked',
  country: 'CN',
  regionCode: null,
  name: 'mainland China',
  viaProxy: false,
  decidedAt: '2026-11-01T08:00:00.000Z',
  checkedAt: '2026-11-01T09:00:00.000Z',
  blockedChecks: 2,
};

test('runner.region reads back only as the eight fields of a decided check', () => {
  assert.deepEqual(parseRunnerRegion(STORED), STORED);
  assert.deepEqual(parseRunnerRegion({ ...STORED, ip: '203.0.113.24' }), STORED, 'nothing else is carried out of the row');
  for (const bad of [
    null, undefined, 'CN', [], {},
    { ...STORED, verdict: 'unknown' },
    { ...STORED, country: null },
    { ...STORED, regionCode: 43 },
    { ...STORED, viaProxy: 'no' },
    { ...STORED, decidedAt: undefined },
    { ...STORED, checkedAt: 7 },
    { ...STORED, blockedChecks: -1 },
    { ...STORED, blockedChecks: 1.5 },
  ]) {
    assert.equal(parseRunnerRegion(bad), null, JSON.stringify(bad));
  }
});

test('the list reads the effective verdict, and null for a runner without claude-region/v1 or a decided check', () => {
  const capable = [CLAUDE_REGION_V1, 'cursor-key-check/v1'];
  const decided = Date.parse(STORED.decidedAt);
  const view = runnerRegionView({ region: STORED, capabilities: capable }, new Date(decided + 60_000));
  assert.deepEqual(view, {
    verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false, checkedAt: STORED.checkedAt,
  });
  // Decided 24 hours ago or more, a blocked verdict no longer gates; the place stays as it was found.
  const stale = runnerRegionView({ region: STORED, capabilities: capable }, new Date(decided + CLAUDE_REGION_CARRY_OVER_MS));
  assert.deepEqual(stale, { ...view, verdict: 'allowed' });
  const allowed = { ...STORED, verdict: 'allowed', country: 'SG', name: 'Singapore', blockedChecks: 0 };
  assert.equal(runnerRegionView({ region: allowed, capabilities: capable }, new Date(decided))?.verdict, 'allowed');
  // Never gated: the capability is not declared, whatever the row holds.
  for (const capabilities of [[], ['cursor-key-check/v1'], null, undefined]) {
    assert.equal(runnerRegionView({ region: STORED, capabilities }, new Date(decided)), null, JSON.stringify(capabilities));
  }
  // No check has decided yet.
  assert.equal(runnerRegionView({ region: null, capabilities: capable }, new Date(decided)), null);
});

test('Check again is handed over while it waits, for ten minutes at most', () => {
  const asked = new Date('2026-11-01T10:00:00.000Z');
  assert.equal(regionCheckRequestOf(null, asked), undefined);
  assert.equal(regionCheckRequestOf(undefined, asked), undefined);
  assert.deepEqual(regionCheckRequestOf(asked, asked), { requestedAt: '2026-11-01T10:00:00.000Z' });
  assert.deepEqual(regionCheckRequestOf(asked, new Date(asked.getTime() + REGION_CHECK_REQUEST_TTL_MS)), {
    requestedAt: '2026-11-01T10:00:00.000Z',
  });
  assert.equal(regionCheckRequestOf(asked, new Date(asked.getTime() + REGION_CHECK_REQUEST_TTL_MS + 1)), undefined);
  assert.equal(REGION_CHECK_REQUEST_TTL_MS, 10 * 60_000);
});
