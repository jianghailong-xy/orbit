import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { interval, map } from 'rxjs';

import { KeptAliveConnection } from '../test-support/kept-alive';
import { DRAIN_MS, drainable, endStreams, STOP_MS, untilStopping } from './graceful-stop';
import { holdIdleConnections } from './idle-connections';

/**
 * How a listener drains as the apiserver stops (graceful-stop.ts), on a listener with the apiserver's own idle timeouts
 * (keepAliveTimeout 120 s): without a database, the same order main.ts runs it in.
 */

async function listen(handler: (route: string, res: ServerResponse) => void) {
  const server = holdIdleConnections(createServer((req, res) => handler(req.url ?? '/', res)));
  const drain = drainable(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, drain, port: (server.address() as AddressInfo).port };
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function until(what: string, check: () => boolean, ms = 5_000): Promise<void> {
  for (const start = Date.now(); !check(); await sleep(20)) {
    assert.ok(Date.now() - start < ms, `${what}: not within ${ms} ms`);
  }
}

test('a stop refuses new connections, answers what is in flight with Connection: close, and is not held up by a connection busy when it began', async () => {
  let release: () => void = () => undefined;
  const { server, drain, port } = await listen((route, res) => {
    if (route === '/slow') {
      release = () => res.end('slow');
      return;
    }
    res.end('quick');
  });

  // Busy when the stop begins: its answer is still to come. And one idle between two requests.
  const busy = await KeptAliveConnection.open(port);
  assert.equal((await busy.request('GET', '/quick')).status, 200, 'the busy connection has served a request before');
  busy.send('GET /slow HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  const idle = await KeptAliveConnection.open(port);
  assert.equal((await idle.request('GET', '/quick')).status, 200);
  await until('the slow request reached the handler', () => drain.inFlight() === 1);

  const began = Date.now();
  let cut: number | null = null;
  void drain.drain(began + 10_000).then((n) => (cut = n));

  assert.ok(await refused(port), 'a new connection is refused once the stop began');
  await until('the idle connection is closed', () => idle.gone !== null);
  assert.equal(busy.gone, null, 'the busy connection stays open for its answer');

  await sleep(200);
  release();
  const answer = await busy.answer(5_000);
  assert.equal(answer.status, 200);
  assert.equal(answer.body, 'slow');
  assert.equal(answer.headers.connection, 'close', 'the answer tells the caller not to send on this connection again');
  await until('the busy connection is closed after its answer', () => busy.gone !== null);
  await until('the drain ends', () => cut !== null);
  assert.equal(cut, 0, 'nothing was cut');
  const took = Date.now() - began;
  assert.ok(took < 3_000, `the stop took ${took} ms: a connection busy when it began held it up (keepAliveTimeout is ${server.keepAliveTimeout} ms)`);
});

test('a request still unanswered at the deadline is cut, and the drain ends then', async () => {
  const { drain, port } = await listen(() => undefined); // never answers
  const conn = await KeptAliveConnection.open(port);
  conn.send('GET /never HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await until('the request reached the handler', () => drain.inFlight() === 1);
  const began = Date.now();
  const cut = await drain.drain(began + 300);
  assert.equal(cut, 1);
  assert.ok(Date.now() - began < 2_000);
  await until('its connection is closed', () => conn.gone !== null);
});

test('a stream following untilStopping ends when the streams end, and its connection closes with it', async () => {
  const { drain, port } = await listen((_route, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const sub = interval(20)
      .pipe(map((n) => `data: ${n}\n\n`), untilStopping())
      .subscribe({ next: (chunk) => res.write(chunk), complete: () => res.end() });
    res.once('close', () => sub.unsubscribe());
  });
  const conn = await KeptAliveConnection.open(port);
  conn.send('GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await until('the stream started', () => drain.inFlight() === 1);
  await sleep(100);
  const began = Date.now();
  const drained = drain.drain(began + 10_000);
  endStreams();
  assert.equal(await drained, 0, 'the stream ended rather than being cut');
  assert.ok(Date.now() - began < 2_000);
  await until('its connection is closed', () => conn.gone !== null);
});

test('the whole stop ends inside the grace period docker stop gives the apiserver', () => {
  // `build/common` → the repo.
  const compose = readFileSync(path.resolve(__dirname, '../../../../docker-compose.yml'), 'utf8');
  const service = compose.slice(compose.indexOf('\n  apiserver:\n'), compose.indexOf('\n  wiki-worker:\n'));
  const set = service.match(/^ {4}stop_grace_period: (\d+)s$/m);
  // None set is Docker's default, 10 s.
  const graceMs = set ? Number(set[1]) * 1_000 : 10_000;
  assert.ok(DRAIN_MS < STOP_MS, `the drain (${DRAIN_MS} ms) leaves the shutdown hooks no time before ${STOP_MS} ms`);
  assert.ok(STOP_MS < graceMs, `a stop may take ${STOP_MS} ms, and Docker SIGKILLs the apiserver after ${graceMs} ms`);
});
