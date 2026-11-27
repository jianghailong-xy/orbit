import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { recordTransactionUnit, resetDbConflictMetrics } from '../common/db-conflict-metrics';
import { drainable } from '../common/graceful-stop';
import { PrismaService } from '../prisma/prisma.service';
import { listenForMetricsScrapes, metricsScrapeListener } from './metrics-listener';
import { MetricsController } from './metrics.controller';

/**
 * The internal listener Prometheus scrapes (metrics-listener.ts), over real sockets: it answers `/metrics` with the
 * body `GET /api/metrics` serves behind its token, refuses every other path and method itself, never hands a request
 * to the app, and stops with the drain main.ts runs on SIGTERM.
 */

/** Routes the app serves on its public listener, which the metrics listener must not reach. */
@Controller()
class ProbeController {
  static hits = 0;

  @Get('probe')
  probe(): string {
    ProbeController.hits += 1;
    return 'reached the app';
  }

  @Get('runner/heartbeat')
  heartbeat(): string {
    ProbeController.hits += 1;
    return 'reached the app';
  }
}

@Module({
  imports: [JwtModule.register({ secret: 'metrics-listener-spec-not-a-real-secret' })],
  controllers: [MetricsController, ProbeController],
  // No database: the gauges read from it are left out, as metrics.controller.spec.ts boots the route.
  providers: [{ provide: PrismaService, useValue: null }],
})
class LiveModule {}

/** One raw request: the path goes on the wire exactly as given, which fetch would normalize. */
function send(port: number, method: string, rawPath: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path: rawPath, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;

test('the internal listener serves /metrics alone, and nothing it refuses reaches the app', async (t) => {
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
  const publicPort = portOf(app.getHttpServer());
  const logged: string[] = [];
  const log = { log: (m: string) => logged.push(m), error: (m: string) => logged.push(`error: ${m}`) };
  const server = await listenForMetricsScrapes(app, { port: '0', host: '127.0.0.1' }, log);
  assert.ok(server, `the listener did not open: ${logged.join('; ')}`);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });
  const port = portOf(server);
  assert.match(logged.join('\n'), new RegExp(`metrics are served for scraping on 127\\.0\\.0\\.1:${port}/metrics`));

  await t.test('GET /metrics is the body GET /api/metrics serves, as text a scraper parses, without a token', async () => {
    const answer = await send(port, 'GET', '/metrics');
    assert.equal(answer.status, 200);
    assert.match(String(answer.headers['content-type']), /^text\/plain/);
    assert.match(String(answer.headers['content-type']), /version=0\.0\.4/);
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.match(answer.body, /^orbit_db_transaction_units_total\{.*operation="tasks\.create".*\} 1$/m);
    // A query string is still the one path.
    assert.equal((await send(port, 'GET', '/metrics?format=text')).status, 200);
    // HEAD has the headers and no body.
    const head = await send(port, 'HEAD', '/metrics');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  });

  await t.test('the JWT route on the public listener is unchanged: no token, no metrics', async () => {
    assert.equal((await send(publicPort, 'GET', '/api/metrics')).status, 401);
  });

  await t.test('every other path is refused with 404 by the listener itself', async () => {
    // The public listener does serve the probe routes, so a refusal below is the door's and not a missing route.
    assert.equal((await send(publicPort, 'GET', '/api/probe')).status, 200);
    const before = ProbeController.hits;
    const paths = [
      '/', '/api', '/api/metrics', '/api/probe', '/api/runner/heartbeat', '/api/sessions', '/probe', '/healthz',
      '/metrics/', '//metrics', '/metrics/../api/probe', '/METRICS', '/metricsx', '/metrics%2F', '/%6detrics',
      '/api/../metrics', '*', 'http://127.0.0.1/api/probe',
    ];
    for (const rawPath of paths) {
      const answer = await send(port, 'GET', rawPath);
      assert.equal(answer.status, 404, `${rawPath} answered ${answer.status}`);
      assert.equal(JSON.parse(answer.body).code, 'METRICS_ROUTE_UNKNOWN', rawPath);
    }
    assert.equal(ProbeController.hits, before, 'a request to the metrics listener reached the app');
  });

  await t.test('every other method on /metrics is refused with 405', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const answer = await send(port, method, '/metrics');
      assert.equal(answer.status, 405, method);
      assert.equal(answer.headers.allow, 'GET, HEAD', method);
      assert.equal(JSON.parse(answer.body).code, 'METRICS_METHOD_NOT_ALLOWED', method);
    }
  });
});

test('a port that is unset or not a port opens no listener, and says why when it is not a port', async () => {
  const app = await NestFactory.create(LiveModule, { logger: false });
  try {
    for (const [port, said] of [[undefined, false], ['', false], ['  ', false], ['metrics', true], ['70000', true], ['-1', true]] as const) {
      const logged: string[] = [];
      const log = { log: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
      assert.equal(await listenForMetricsScrapes(app, { port }, log), null, String(port));
      assert.equal(logged.some((m) => /METRICS_INTERNAL_PORT=.* is not a port/.test(m)), said, String(port));
    }
  } finally {
    await app.close();
  }
});

test('a body that cannot be read is a 500, not a crash', async (t) => {
  const errors: string[] = [];
  const server = createServer(metricsScrapeListener(() => Promise.reject(new Error('database gone')), { error: (m) => errors.push(m) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const answer = await send(portOf(server), 'GET', '/metrics');
  assert.equal(answer.status, 500);
  assert.equal(JSON.parse(answer.body).code, 'METRICS_UNAVAILABLE');
  assert.deepEqual(errors, ['metrics could not be read: database gone']);
});

test('the drain answers a scrape in flight, then refuses new ones', async () => {
  let release: () => void = () => undefined;
  const slow = new Promise<string>((resolve) => (release = () => resolve('orbit_up 1\n')));
  const server = createServer(metricsScrapeListener(() => slow));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = portOf(server);
  const listener = drainable(server);
  const inFlight = send(port, 'GET', '/metrics');
  while (listener.inFlight() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const drained = listener.drain(Date.now() + 5_000);
  setTimeout(release, 50);
  const answer = await inFlight;
  assert.equal(answer.status, 200);
  assert.equal(answer.body, 'orbit_up 1\n');
  assert.equal(await drained, 0, 'the scrape in flight was cut');
  await assert.rejects(send(port, 'GET', '/metrics'), /ECONNREFUSED/);
});

test('main.ts opens the listener from METRICS_INTERNAL_PORT and HOST, and drains it with the others', () => {
  const main = readFileSync(path.resolve(__dirname, '../../src/main.ts'), 'utf8');
  assert.match(main, /listenForMetricsScrapes\(app, \{\s*port: config\.get<string>\('METRICS_INTERNAL_PORT'\),\s*host: config\.get<string>\('METRICS_INTERNAL_HOST'\),\s*\}\)/);
  assert.match(main, /if \(metricsServer\) listeners\.push\(drainable\(metricsServer\)\);\n\s*started\(\{ app, listeners \}\);/);
});
