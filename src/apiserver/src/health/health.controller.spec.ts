import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { NestFactory } from '@nestjs/core';

import { HealthModule } from './health.module';

/**
 * `GET /api/health`, over a real socket.
 *
 * The route answered 404 because nothing served it: the only health surfaces in the deployment
 * were nginx's own `/healthz` on the gateway and the web container, neither of which says
 * anything about the control plane behind them. So two claims, and the second is the one that
 * regressed into a 404 in the first place:
 *  - the route answers 200 to a caller with no credentials, because a probe has none; and
 *  - it is mounted in the module the server actually boots, not only in a test module.
 */

test('the control plane answers a liveness probe on /api/health', async (t) => {
  const app = await NestFactory.create(HealthModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  await t.test('an unauthenticated probe gets 200 and a body it can match on', async () => {
    const response = await fetch(`${base}/api/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  await t.test('the answer is not cacheable', async () => {
    // A cached 200 is a probe that keeps reporting a dead server as healthy.
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('the module is wired into the app the server boots', () => {
  // The failure this endpoint exists to end was a 404, i.e. a route that nothing mounted. A
  // controller reachable only from this file's own test module would reproduce it exactly.
  const appModule = readFileSync(path.resolve(__dirname, '../..', 'src', 'app.module.ts'), 'utf8');
  assert.match(appModule, /HealthModule/, 'AppModule does not import HealthModule');
});
