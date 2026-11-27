import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';

import {
  recordTransactionUnit,
  resetDbConflictMetrics,
} from '../common/db-conflict-metrics';
import { recordHttpRequest, resetHttpRequestMetrics } from '../common/http-request-metrics';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { resetFleetGauges } from './fleet-metrics';
import { MetricsController, renderMetrics } from './metrics.controller';

/**
 * The counters, over a real socket.
 *
 * `db-conflict-metrics.spec.ts` proves what the numbers say; this proves an operator can get at
 * them, which is a different claim and the one the runbook's `curl` depends on. Two things have to
 * hold: the route is behind the same bearer token as every other route, so the counters are not a
 * hole in the API's authentication; and the body is served as text a scraper and `promtool` parse,
 * not as the JSON Nest would otherwise make of a returned string.
 */

const SECRET = 'metrics-spec-not-a-real-secret';

@Module({
  imports: [JwtModule.register({ secret: SECRET })],
  controllers: [MetricsController],
  providers: [JwtAuthGuard, Reflector],
})
class LiveModule {}

test('the counters are served as Prometheus text, and only to a caller with a token', async (t) => {
  resetDbConflictMetrics();
  recordTransactionUnit({
    operation: 'tasks.create',
    outcome: 'committed',
    handling: 'absorbed',
    attempts: 2,
    durationMs: 12,
    error: { family: 'TRANSIENT', reason: 'DEADLOCK', evidence: '40P01' },
  });

  const app = await NestFactory.create(LiveModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  await t.test('without a token there is nothing to read', async () => {
    const response = await fetch(`${base}/api/metrics`);
    assert.equal(response.status, 401);
  });

  await t.test('with one, the registry comes back as text a scraper parses', async () => {
    const token = await app.get(JwtService).signAsync({ sub: 'u1', email: 'operator@example.test' });
    const response = await fetch(`${base}/api/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    // The exact content type a scraper content-negotiates for. Without it an ad-hoc `curl` and a
    // browser both treat this as a file to download rather than as text.
    const contentType = response.headers.get('content-type') ?? '';
    assert.match(contentType, /^text\/plain\b/, contentType);
    assert.match(contentType, /version=0\.0\.4/, contentType);
    // A counter is a running total; a cached one is a wrong one.
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = await response.text();
    assert.match(body, /^# HELP orbit_db_transaction_units_total /m);
    assert.ok(
      body.includes(
        'orbit_db_transaction_units_total{operation="tasks.create",outcome="committed",' +
          'handling="absorbed",origin="service",classifier="deadlock",sqlstate="40P01",attempt="2"} 1',
      ),
      `the recorded series is not in the exposition:\n${body}`,
    );
  });
});

test('the body carries the request histogram and the runner, session and task gauges', async () => {
  resetHttpRequestMetrics();
  resetFleetGauges();
  recordHttpRequest({ route: '/api/sessions/:id', method: 'GET', status: 200, durationSeconds: 0.02 });
  // Answers the fleet read alone; the Watch and wiki reads fail, and say so in their own up gauges.
  const prisma = {
    $queryRaw: async (...args: unknown[]) => {
      if (!renderRawQuery(args).text.includes('runner_state')) throw new Error('not this read');
      return [{
      runners_online: 2, runners_draining: 0, runners_silent: 1, runners_offline: 4, oldest_beat_age_seconds: 12,
      sessions_queued: 1, sessions_running: 2, tasks_queued: 0, tasks_running: 1,
      }];
    },
  } as unknown as PrismaService;
  const body = await renderMetrics(prisma);
  assert.match(body, /^orbit_http_request_duration_seconds_count\{route="\/api\/sessions\/:id",method="GET",status="2xx"\} 1$/m);
  assert.match(body, /^orbit_fleet_gauges_up 1$/m);
  assert.match(body, /^orbit_runners\{state="online"\} 2$/m);
  assert.match(body, /^orbit_runner_oldest_heartbeat_age_seconds 12$/m);
  assert.match(body, /^orbit_sessions\{state="running"\} 2$/m);
  assert.match(body, /^orbit_tasks\{state="running"\} 1$/m);
  // One HELP and one TYPE per family, whatever else the body holds: what promtool checks first.
  const types = body.split('\n').filter((line) => line.startsWith('# TYPE ')).map((line) => line.split(' ')[2]);
  assert.equal(new Set(types).size, types.length, `a family is declared twice: ${types.join(', ')}`);
});
