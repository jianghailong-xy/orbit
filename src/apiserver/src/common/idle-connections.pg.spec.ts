/**
 * Both listeners of a real apiserver keep a kept-alive connection open past Node's default idle timeout
 * (idle-connections.ts): `node build/main.js` as the container starts it, with the runner link on, over a disposable
 * PostgreSQL. The public listener is PORT, which the web gateway's nginx calls; the link listener is
 * RUNNER_LINK_INTERNAL_PORT, which the link gateway calls. On one connection to each, a request is answered, the
 * connection waits 7 s, past Node's default 5 s and the 1 s Node 26 adds to it, and a second request goes on the same
 * socket. At Node's default the apiserver has closed the connection by then, and a caller sending on it as it closes
 * is reset (C2b's judged hour, 2026-10-31); now the request is answered. Each answer also says how long the listener
 * keeps an idle connection (`Keep-Alive: timeout=`), which must be longer than every caller keeps one.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/common/idle-connections.pg.spec.ts
 *
 * Needs COORDINATOR_PG_URL (the script provides a disposable one). The spec writes nothing; the apiserver writes
 * what any apiserver writes as it starts.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from 'pg';

import { startApiserver } from '../auth/pat-test-apiserver';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { callersIdleTimeoutsMs, KeptAliveConnection } from '../test-support/kept-alive';

const URL = process.env.COORDINATOR_PG_URL;
const GATEWAY_TOKEN = `the-link-gateway-secret:${randomUUID()}`;
/** Past Node's default keepAliveTimeout (5 s) and the keepAliveTimeoutBuffer (1 s) Node 26 adds to it. */
const IDLE_MS = 7_000;
/** The revocation list: the link gateway reads it, and both listeners serve it to the gateway's token. */
const ROUTE = '/api/runner/link-token/revocations';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test("on both of a real apiserver's listeners, a connection waits past Node's default idle timeout and its next request is answered", {
  skip: !URL, concurrency: 2, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  t.after(() => sql.end().catch(() => undefined));
  await verifyCoordinatorPgIdentity(sql);

  const { privateKey } = generateKeyPairSync('ed25519');
  const linkPort = await freePort();
  const apiserver = await startApiserver(url, `idle-connections-${randomUUID()}`, {
    RUNNER_LINK_SIGNING_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    RUNNER_LINK_URL: 'wss://link.idle-connections.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
    RUNNER_LINK_INTERNAL_PORT: String(linkPort),
    RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
  });
  t.after(() => apiserver.stop());
  // The link listener opens just after the public one answers.
  const served = `runner link calls are served on 127.0.0.1:${linkPort}`;
  for (let waited = 0; !apiserver.output().includes(served); waited += 100) {
    assert.ok(waited < 30_000, `the link listener did not open:\n${apiserver.output().slice(-3_000)}`);
    await sleep(100);
  }

  const listeners = { 'the public listener (PORT)': apiserver.port, 'the link listener (RUNNER_LINK_INTERNAL_PORT)': linkPort };
  await Promise.all(Object.entries(listeners).map(([listener, port]) => t.test(listener, async () => {
    const kept = await KeptAliveConnection.open(port);
    try {
      const first = await kept.request('GET', ROUTE, { Authorization: `Bearer ${GATEWAY_TOKEN}` });
      assert.equal(first.status, 200, `${listener} answered the first request: ${first.body}`);
      await sleep(IDLE_MS);
      const second = await kept
        .request('GET', ROUTE, { Authorization: `Bearer ${GATEWAY_TOKEN}` })
        .catch((error: Error) => assert.fail(`after ${IDLE_MS} ms idle, ${listener}'s connection is gone: ${error.message}`));
      assert.equal(second.status, 200, `${listener} answered the second request on the same connection: ${second.body}`);

      const advertised = /^timeout=(\d+)$/.exec(first.headers['keep-alive'] ?? '');
      assert.ok(advertised, `${listener} says how long it keeps an idle connection: Keep-Alive ${first.headers['keep-alive']}`);
      for (const [caller, callerMs] of Object.entries(callersIdleTimeoutsMs())) {
        assert.ok(
          Number(advertised[1]) * 1_000 > callerMs,
          `${listener} keeps an idle connection ${advertised[1]} s, no longer than ${caller} keeps one (${callerMs} ms)`,
        );
      }
    } finally {
      kept.close();
    }
  })));
});
