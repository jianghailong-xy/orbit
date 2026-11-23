import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';

import {
  cachedFleetGauges,
  FLEET_GAUGES_TTL_MS,
  renderFleetMetrics,
  resetFleetGauges,
  RUNNER_STATES,
  WORK_STATES,
} from './fleet-metrics';

/**
 * The runner, session and task gauges: read at most once per FLEET_GAUGES_TTL_MS per process, from closed label sets,
 * and saying so when the read failed. What the SQL counts is held against PostgreSQL in fleet-metrics.pg.spec.ts.
 */

const ROW = {
  runners_online: 3,
  runners_draining: 1,
  runners_silent: 2,
  runners_offline: 5,
  oldest_beat_age_seconds: 41.5,
  sessions_queued: 4,
  sessions_running: 6,
  tasks_queued: 2,
  tasks_running: 3,
};

/** A database that answers ROW (or fails), counting its reads, each answered after `delayMs`. */
function database(options: { fail?: boolean; delayMs?: number } = {}) {
  const db = {
    reads: 0,
    fail: options.fail ?? false,
    $queryRaw: async () => {
      db.reads += 1;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (db.fail) throw new Error('the database is down');
      return [ROW];
    },
  };
  return db;
}

const asReader = (db: ReturnType<typeof database>) => db as unknown as Pick<PrismaClient, '$queryRaw'>;

test('a scrape within the TTL is answered from the last read; the first after it reads again', async () => {
  resetFleetGauges();
  const db = database();
  let now = 1_000_000;
  const clock = () => now;
  await renderFleetMetrics(asReader(db), clock);
  assert.equal(db.reads, 1);
  // Prometheus every 15 s, and an operator's curl between: still the one read.
  now += 15_000;
  await renderFleetMetrics(asReader(db), clock);
  now += FLEET_GAUGES_TTL_MS - 15_001;
  await renderFleetMetrics(asReader(db), clock);
  assert.equal(db.reads, 1, 'every scrape inside the TTL is answered from the kept read');
  now += 1;
  await renderFleetMetrics(asReader(db), clock);
  assert.equal(db.reads, 2, 'the first scrape past the TTL reads again');
  assert.ok(FLEET_GAUGES_TTL_MS >= 15_000 && FLEET_GAUGES_TTL_MS <= 30_000, 'cached for 15 to 30 s');
});

test('scrapes that arrive during a read wait for it rather than reading too', async () => {
  resetFleetGauges();
  const db = database({ delayMs: 30 });
  const bodies = await Promise.all([1, 2, 3, 4].map(() => renderFleetMetrics(asReader(db))));
  assert.equal(db.reads, 1);
  assert.equal(new Set(bodies).size, 1);
});

test('a read that failed says up 0 and is not kept: the next scrape reads again', async () => {
  resetFleetGauges();
  const db = database({ fail: true });
  const failed = await renderFleetMetrics(asReader(db));
  const samples = failed.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(samples, ['orbit_fleet_gauges_up 0'], 'no gauge is served from a read that did not happen');
  db.fail = false;
  const body = await renderFleetMetrics(asReader(db));
  assert.equal(db.reads, 2);
  assert.match(body, /^orbit_fleet_gauges_up 1$/m);
});

test('every gauge is served, each state of its closed set present, and nothing else is a label', async () => {
  resetFleetGauges();
  const body = await renderFleetMetrics(asReader(database()));
  for (const name of ['orbit_runners', 'orbit_runner_oldest_heartbeat_age_seconds', 'orbit_sessions', 'orbit_tasks']) {
    assert.match(body, new RegExp(`^# TYPE ${name} gauge$`, 'm'));
  }
  assert.match(body, /^orbit_runners\{state="online"\} 3$/m);
  assert.match(body, /^orbit_runners\{state="draining"\} 1$/m);
  assert.match(body, /^orbit_runners\{state="silent"\} 2$/m);
  assert.match(body, /^orbit_runners\{state="offline"\} 5$/m);
  assert.match(body, /^orbit_runner_oldest_heartbeat_age_seconds 41\.5$/m);
  assert.match(body, /^orbit_sessions\{state="queued"\} 4$/m);
  assert.match(body, /^orbit_sessions\{state="running"\} 6$/m);
  assert.match(body, /^orbit_tasks\{state="queued"\} 2$/m);
  assert.match(body, /^orbit_tasks\{state="running"\} 3$/m);

  // The whole label space, and so the series count, is fixed by the code: 4 runner states, 2 + 2 work states, 2 unlabelled.
  const samples = body.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(samples.length, 1 + RUNNER_STATES.length + 1 + WORK_STATES.length * 2);
  for (const line of samples) {
    assert.match(line, /^orbit_[a-z_]+(?:\{state="(?:online|draining|silent|offline|queued|running)"\})? [0-9.]+$/, line);
  }
});

test('the kept read is the same object until the TTL passes', async () => {
  resetFleetGauges();
  const db = database();
  let now = 0;
  const first = await cachedFleetGauges(asReader(db), () => now);
  now = FLEET_GAUGES_TTL_MS - 1;
  assert.equal(await cachedFleetGauges(asReader(db), () => now), first);
  now = FLEET_GAUGES_TTL_MS;
  assert.notEqual(await cachedFleetGauges(asReader(db), () => now), first);
});

test('without a database there is nothing to serve', async () => {
  resetFleetGauges();
  assert.equal(await renderFleetMetrics(undefined), '');
});
