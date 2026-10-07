import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIKI_SYSTEM_MODEL, WIKI_SYSTEM_MODEL_READ_STATES } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';
import { NO_WIKI_MODEL_CALLS, renderWikiModelMetrics, WIKI_MODEL_CALL_OUTCOMES } from './wiki-model-metrics';

/**
 * The System model's series on GET /api/metrics (wiki-model-metrics.ts, contract `systemModel.metrics`), rendered from
 * a stand-in for the one row: the state as the read answers it, the heartbeat's age, and the calls' series — named,
 * typed and labelled now, and at zero and with no observation until the request queue counts them.
 */

const NOW = new Date('2026-10-07T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

/** A database holding `row` as wiki_model_status's one row (or none). */
function holding(row: Record<string, unknown> | null): PrismaService {
  return { wikiModelStatus: { findUnique: async () => row } } as unknown as PrismaService;
}

function samples(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of body.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-z_]+(?:\{[^}]*\})?) (\S+)$/.exec(line);
    assert.ok(match, `not a sample line: ${line}`);
    found.set(match[1], match[2]);
  }
  return found;
}

test('without a database: the calls\' series alone, at zero and with no observation, each with HELP and TYPE', async () => {
  const body = await renderWikiModelMetrics(undefined, NO_WIKI_MODEL_CALLS, NOW);
  assert.match(body, /^# TYPE orbit_wiki_model_calls_total counter$/m);
  assert.match(body, /^# TYPE orbit_wiki_model_call_duration_seconds summary$/m);
  assert.doesNotMatch(body, /orbit_wiki_model_state/);
  const found = samples(body);
  for (const outcome of WIKI_MODEL_CALL_OUTCOMES) assert.equal(found.get(`orbit_wiki_model_calls_total{outcome="${outcome}"}`), '0');
  assert.deepEqual(WIKI_MODEL_CALL_OUTCOMES, ['succeeded', 'retryable', 'unauthorized', 'other']);
  assert.equal(found.get('orbit_wiki_model_call_duration_seconds{quantile="0.5"}'), 'NaN');
  assert.equal(found.get('orbit_wiki_model_call_duration_seconds{quantile="0.95"}'), 'NaN');
  assert.equal(found.get('orbit_wiki_model_call_duration_seconds_count'), '0');
});

test('the state is one-hot over the read\'s states, and the heartbeat\'s age is in seconds', async () => {
  const row = { state: 'down', model: 'qwen3-coder', since: ago(120), checkedAt: ago(4), workerSeenAt: ago(4) };
  const found = samples(await renderWikiModelMetrics(holding(row), NO_WIKI_MODEL_CALLS, NOW));
  for (const state of WIKI_SYSTEM_MODEL_READ_STATES) {
    assert.equal(found.get(`orbit_wiki_model_state{state="${state}"}`), state === 'down' ? '1' : '0', state);
  }
  assert.equal(found.get('orbit_wiki_worker_heartbeat_age_seconds'), '4');
});

test('a heartbeat older than workerStaleSeconds, or none at all, is worker_not_running', async () => {
  const stale = { state: 'up', model: 'qwen3-coder', since: ago(3600), checkedAt: ago(61), workerSeenAt: ago(WIKI_SYSTEM_MODEL.workerStaleSeconds + 1) };
  const old = samples(await renderWikiModelMetrics(holding(stale), NO_WIKI_MODEL_CALLS, NOW));
  assert.equal(old.get('orbit_wiki_model_state{state="worker_not_running"}'), '1');
  assert.equal(old.get('orbit_wiki_model_state{state="up"}'), '0');
  assert.equal(old.get('orbit_wiki_worker_heartbeat_age_seconds'), String(WIKI_SYSTEM_MODEL.workerStaleSeconds + 1));

  const never = samples(await renderWikiModelMetrics(holding(null), NO_WIKI_MODEL_CALLS, NOW));
  assert.equal(never.get('orbit_wiki_model_state{state="worker_not_running"}'), '1');
  assert.equal(never.has('orbit_wiki_worker_heartbeat_age_seconds'), false);
});

test('what the request queue will count is rendered as given', async () => {
  const found = samples(await renderWikiModelMetrics(undefined, {
    calls: { succeeded: 12, retryable: 3, unauthorized: 1, other: 2 },
    duration: { p50: 41.5, p95: 610, sum: 1234.5, count: 18 },
  }, NOW));
  assert.equal(found.get('orbit_wiki_model_calls_total{outcome="succeeded"}'), '12');
  assert.equal(found.get('orbit_wiki_model_calls_total{outcome="unauthorized"}'), '1');
  assert.equal(found.get('orbit_wiki_model_call_duration_seconds{quantile="0.95"}'), '610');
  assert.equal(found.get('orbit_wiki_model_call_duration_seconds_sum'), '1234.5');
  assert.equal(found.get('orbit_wiki_model_call_duration_seconds_count'), '18');
});

test('a database that cannot be read leaves the state out, and the rest is still served', async () => {
  const broken = { wikiModelStatus: { findUnique: async () => { throw new Error('connection lost'); } } } as unknown as PrismaService;
  const body = await renderWikiModelMetrics(broken, NO_WIKI_MODEL_CALLS, NOW);
  assert.doesNotMatch(body, /orbit_wiki_model_state/);
  assert.match(body, /^orbit_wiki_model_calls_total\{outcome="succeeded"\} 0$/m);
});
