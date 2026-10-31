import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';

import { listenForRunnerLinkCalls } from '../runner-api/runner-link-call';
import { readRunnerLink } from '../runner-api/runner-link-token';
import { callersIdleTimeoutsMs, KeptAliveConnection } from '../test-support/kept-alive';
import { holdIdleConnections } from './idle-connections';

/**
 * How long the apiserver holds an idle connection (idle-connections.ts), without a database: the timers' order against
 * every caller on both listeners, and what Node does with a connection waiting between requests. A real connection
 * held idle on each listener of the real main.js is idle-connections.pg.spec.ts.
 */

/** The link gateway's listener as listenForRunnerLinkCalls opens it, in front of an app that answers 200. */
async function openLinkListener(): Promise<Server> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const link = readRunnerLink({
    signingKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    linkUrl: 'wss://link.idle-connections.invalid',
    gatewayToken: 'a-gateway-secret-that-is-long-enough-for-the-check',
  });
  assert.ok(link.config, `the test link did not configure: ${link.problems.join('; ')}`);
  const app = {
    get: () => link,
    getHttpAdapter: () => ({ getInstance: () => (_req: unknown, res: { end(): void }) => res.end() }),
  } as unknown as INestApplication;
  const server = await listenForRunnerLinkCalls(app, { port: '0', host: '127.0.0.1' }, {
    log: () => undefined,
    error: (message: string) => assert.fail(message),
  });
  assert.ok(server, 'the link listener opened');
  return server;
}

test('both listeners hold an idle connection longer than every caller keeps one, and their header and request timers longer still', async (t) => {
  const link = await openLinkListener();
  t.after(() => new Promise<void>((resolve) => link.close(() => resolve())));
  const listeners: Record<string, Server> = {
    // main.ts hands the app's server to holdIdleConnections before it listens on PORT.
    'the public listener (PORT)': holdIdleConnections(createServer()),
    'the link listener (RUNNER_LINK_INTERNAL_PORT)': link,
  };
  for (const [listener, server] of Object.entries(listeners)) {
    for (const [caller, callerMs] of Object.entries(callersIdleTimeoutsMs())) {
      assert.ok(
        server.keepAliveTimeout > callerMs,
        `${listener} closes an idle connection after ${server.keepAliveTimeout} ms, no later than ${caller}, which keeps ` +
          `one ${callerMs} ms. The caller must let go first: a request it sends as the apiserver closes is reset.`,
      );
    }
    assert.ok(
      server.headersTimeout > server.keepAliveTimeout,
      `${listener}: headersTimeout ${server.headersTimeout} ms is not above keepAliveTimeout ${server.keepAliveTimeout} ms`,
    );
    assert.ok(
      server.requestTimeout > server.headersTimeout,
      `${listener}: requestTimeout ${server.requestTimeout} ms is not above headersTimeout ${server.headersTimeout} ms`,
    );
  }
});

test('a connection waiting between requests is closed by neither the header timer nor the request timer', async (t) => {
  // Scaled down, and in the opposite order to the listeners': headersTimeout and requestTimeout BELOW keepAliveTimeout,
  // so that a connection can wait past both while keepAliveTimeout still holds it. Were either timer counting that
  // wait, the connection would be closed. The connections are checked against them every 50 ms instead of every 30 s.
  const server = createServer({ connectionsCheckingInterval: 50 }, (_req, res) => res.end('ok'));
  server.keepAliveTimeout = 3_000;
  server.headersTimeout = 300;
  server.requestTimeout = 600;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const kept = await KeptAliveConnection.open((server.address() as AddressInfo).port);
  t.after(() => kept.close());

  assert.equal((await kept.request('GET', '/')).status, 200);
  await sleep(1_000);
  assert.equal(kept.gone, null, 'still open after waiting 1 s, past headersTimeout and requestTimeout');
  assert.equal((await kept.request('GET', '/')).status, 200, 'and the next request on it is answered');

  // The control: the header timer is live here, and counts from a request's first byte. After another wait, a request
  // whose headers stop half way is answered 408 and closed, headersTimeout after that byte rather than after the wait;
  // keepAliveTimeout would have closed it 3.5 s later.
  await sleep(500);
  assert.equal(kept.gone, null, 'still open after waiting another 500 ms');
  const sentAt = Date.now();
  kept.send('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  const late = await kept.answer(5_000);
  const after = Date.now() - sentAt;
  assert.equal(late.status, 408);
  assert.ok(after >= 250 && after < 2_500, `the half-sent request was refused ${after} ms after its first byte`);
});
