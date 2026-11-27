import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { All, Controller, Get, HttpCode, NotFoundException, Module, Post, Req, Res, Sse } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response } from 'express';
import { of } from 'rxjs';

import {
  HTTP_DURATION_BUCKETS_SECONDS,
  HTTP_MAX_SERIES,
  httpRequestMetrics,
  httpRequestMetricsSnapshot,
  recordHttpRequest,
  renderHttpRequestMetrics,
  resetHttpRequestMetrics,
} from './http-request-metrics';

/**
 * The request histogram: what it records, when, and what it keeps out.
 *
 * Over a real Nest app mounted as main.ts mounts it (the middleware first, the `api` prefix), because the two claims
 * that matter are about the framework and not about this file: the status is the one the answer was SENT with,
 * including a 500 the exception filter made after every interceptor had returned; and the routes that hold by design
 * (common/held-routes.ts) are named by Express the way HELD_ROUTES spells them, so they are kept out. Then the
 * registry rules of common/db-conflict-metrics.ts: closed label sets, and a cap that is visible when it is hit.
 */

@Controller('things')
class ThingsController {
  @Get(':id')
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  @HttpCode(201)
  create(): { ok: true } {
    return { ok: true };
  }

  @Get(':id/missing')
  missing(): never {
    throw new NotFoundException('no such thing');
  }

  @Get(':id/broken')
  broken(): never {
    throw new Error('a handler that throws is answered 500 by the exception filter');
  }
}

/** The held routes, each declared at the template HELD_ROUTES names. */
@Controller()
class EventsController {
  @Sse('events')
  events() {
    return of({ data: 'one frame, then the stream ends and the response finishes' });
  }
}

@Controller('runner')
class ApprovalController {
  @Get('sessions/:id/approvals/:approvalId')
  async wait(): Promise<{ status: string }> {
    await sleep(50);
    return { status: 'PENDING' };
  }
}

@Controller('gw/codex')
class GatewayController {
  @All(['', '{*path}'])
  forward(@Req() _req: Request, @Res() res: Response): void {
    res.status(200).type('text/event-stream').end('data: a model turn\n\n');
  }
}

@Module({ controllers: [ThingsController, EventsController, ApprovalController, GatewayController] })
class LiveModule {}

async function liveApp() {
  const app = await NestFactory.create(LiveModule, { logger: false });
  app.use(httpRequestMetrics);
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl() };
}

/** The series of one route, once `finish` has recorded it: a response's last byte can reach the client first. */
async function seriesOf(route: string, count = 1) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = httpRequestMetricsSnapshot().filter((one) => one.labels.route === route);
    if (found.reduce((sum, one) => sum + one.count, 0) >= count) return found;
    await sleep(10);
  }
  return httpRequestMetricsSnapshot().filter((one) => one.labels.route === route);
}

test('a request is recorded at its route template, with the status it was answered with', async (t) => {
  resetHttpRequestMetrics();
  const { app, base } = await liveApp();
  t.after(() => app.close());

  assert.equal((await fetch(`${base}/api/things/0193a1b2-uuid-like?token=secret`)).status, 200);
  assert.equal((await fetch(`${base}/api/things`, { method: 'POST' })).status, 201);
  assert.equal((await fetch(`${base}/api/things/7/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/things/7/broken`)).status, 500);
  assert.equal((await fetch(`${base}/api/no/such/route/0193a1b2`)).status, 404);

  const read = await seriesOf('/api/things/:id');
  assert.deepEqual(read.map((one) => one.labels), [{ route: '/api/things/:id', method: 'GET', status: '2xx' }]);
  assert.ok(read[0].sum > 0 && read[0].sum < 5, `a duration in seconds: ${read[0].sum}`);
  assert.deepEqual((await seriesOf('/api/things')).map((one) => one.labels), [{ route: '/api/things', method: 'POST', status: '2xx' }]);
  assert.deepEqual((await seriesOf('/api/things/:id/missing')).map((one) => one.labels.status), ['4xx']);
  // The exception filter wrote this status after every interceptor had returned: only `finish` sees it.
  assert.deepEqual((await seriesOf('/api/things/:id/broken')).map((one) => one.labels.status), ['5xx']);
  // No route matched: one constant, whatever the path said.
  assert.deepEqual((await seriesOf('unmatched')).map((one) => one.labels), [{ route: 'unmatched', method: 'GET', status: '4xx' }]);

  const body = renderHttpRequestMetrics();
  assert.doesNotMatch(body, /0193a1b2|secret|\/7\//, 'no id, path or query reaches a label');
});

test('the routes that hold by design are not observed: SSE, the approval wait, the gateways, a WebSocket upgrade', async (t) => {
  resetHttpRequestMetrics();
  const { app, base } = await liveApp();
  t.after(() => app.close());
  const server = app.getHttpServer() as Server;
  // As the browser viewer listens (managed-runners/browser-viewer.ts): an upgrade is answered on the server's event.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });

  const stream = await fetch(`${base}/api/events`, { headers: { accept: 'text/event-stream' } });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /one frame/, 'the stream ended, so its response finished');
  assert.equal((await fetch(`${base}/api/runner/sessions/s1/approvals/a1`)).status, 200);
  assert.equal((await fetch(`${base}/api/gw/codex/responses`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await fetch(`${base}/api/gw/codex`)).status, 200);
  const upgraded = await new Promise<string>((resolve, reject) => {
    const url = new URL(base);
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write('GET /api/managed-runners/r1/browser/stream HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    let said = '';
    socket.on('data', (chunk) => (said += chunk.toString()));
    socket.on('end', () => resolve(said));
    socket.on('error', reject);
  });
  assert.match(upgraded, /^HTTP\/1\.1 101 /);

  // A request after them all, recorded: theirs had finished before their clients read their ends.
  await fetch(`${base}/api/things/sentinel`);
  await seriesOf('/api/things/:id');
  await sleep(50);
  assert.deepEqual(
    httpRequestMetricsSnapshot().map((one) => one.labels.route),
    ['/api/things/:id'],
    'only the ordinary request was observed',
  );
});

test('no label carries anything a caller sent', () => {
  resetHttpRequestMetrics();
  recordHttpRequest({ route: '/api/x/:id', method: 'BREW', status: 200, durationSeconds: 0.01 });
  recordHttpRequest({ route: '/api/x/"quoted"\n', method: 'GET', status: 200, durationSeconds: 0.01 });
  recordHttpRequest({ route: `/${'a'.repeat(200)}`, method: 'GET', status: 200, durationSeconds: 0.01 });
  recordHttpRequest({ route: '/api/x/:id', method: 'GET', status: 101, durationSeconds: 0.01 });
  recordHttpRequest({ route: '/api/x/:id', method: 'GET', status: 0, durationSeconds: 0.01 });
  recordHttpRequest({ route: undefined, method: 'GET', status: 404, durationSeconds: 0.01 });
  const labels = httpRequestMetricsSnapshot().map((one) => one.labels);
  assert.deepEqual(labels, [
    { route: '/api/x/:id', method: 'other', status: '2xx' },
    { route: 'other', method: 'GET', status: '2xx' },
    { route: '/api/x/:id', method: 'GET', status: 'other' },
    { route: 'unmatched', method: 'GET', status: '4xx' },
  ]);
});

test('the histogram stops growing at its cap, and says so in one overflow series', () => {
  resetHttpRequestMetrics();
  for (let n = 0; n < HTTP_MAX_SERIES + 50; n += 1) {
    recordHttpRequest({ route: `/api/r${n}/:id`, method: 'GET', status: 200, durationSeconds: 0.01 });
  }
  const series = httpRequestMetricsSnapshot();
  assert.ok(series.length <= HTTP_MAX_SERIES + 1, `the registry grew to ${series.length} series`);
  const overflow = series.find((one) => one.labels.route === 'overflow');
  assert.ok(overflow, 'the cap was reached and nothing said so');
  assert.deepEqual(overflow.labels, { route: 'overflow', method: 'overflow', status: 'overflow' });
  assert.equal(overflow.count, 50);
  // A tuple already in the registry keeps counting in its own series.
  recordHttpRequest({ route: '/api/r0/:id', method: 'GET', status: 200, durationSeconds: 0.01 });
  assert.equal(httpRequestMetricsSnapshot().find((one) => one.labels.route === '/api/r0/:id')?.count, 2);
  assert.equal(httpRequestMetricsSnapshot().length, HTTP_MAX_SERIES + 1);
});

test('the exposition is a cumulative histogram whose +Inf bucket is its count', () => {
  resetHttpRequestMetrics();
  for (const seconds of [0.001, 0.03, 0.03, 0.7, 30]) {
    recordHttpRequest({ route: '/api/sessions/:id', method: 'GET', status: 200, durationSeconds: seconds });
  }
  const body = renderHttpRequestMetrics();
  assert.match(body, /^# TYPE orbit_http_request_duration_seconds histogram$/m);
  const at = (le: string) => {
    const line = body.split('\n').find((one) =>
      one.startsWith(`orbit_http_request_duration_seconds_bucket{route="/api/sessions/:id",method="GET",status="2xx",le="${le}"} `));
    assert.ok(line, `no bucket le=${le}:\n${body}`);
    return Number(line.split(' ').pop());
  };
  assert.equal(at('0.005'), 1);
  assert.equal(at('0.025'), 1);
  assert.equal(at('0.05'), 3);
  assert.equal(at('1'), 4);
  assert.equal(at(String(HTTP_DURATION_BUCKETS_SECONDS.at(-1))), 4);
  assert.equal(at('+Inf'), 5);
  assert.match(body, /^orbit_http_request_duration_seconds_count\{route="\/api\/sessions\/:id",method="GET",status="2xx"\} 5$/m);
  assert.match(body, /^orbit_http_request_duration_seconds_sum\{route="\/api\/sessions\/:id",method="GET",status="2xx"\} 30\.76/m);
});
