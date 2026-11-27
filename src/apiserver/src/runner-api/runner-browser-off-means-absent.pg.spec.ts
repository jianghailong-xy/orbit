/**
 * Off means absent, for every route the four browser tools use (project 350APJYncG4Ssfwaeehyt; docs/runner-browser-design.md §2).
 *
 * browser_status, browser_open, browser_clear_logins and browser_request_sign_in reach the apiserver through
 *   GET  /api/runner/browser                    (browser_status)
 *   POST /api/runner/browser/open               (browser_open)
 *   POST /api/runner/browser/clear              (browser_clear_logins, after its card)
 *   POST /api/runner/browser/sign-in-requests   (browser_request_sign_in)
 * after a card filed on the general approvals route (POST /api/runner/sessions/:id/approvals, toolName
 * orbit_browser_clear_logins), and the owner's own page reaches the same browser through
 *   GET  /api/runners/:id/browser
 *   POST /api/runners/:id/browser/clear
 *
 *   1. ORBIT_MANAGED_RUNNER_BROWSER_ENABLED absent, `false`, or `true` with managed runners off: each route answers 404,
 *      with or without a login, before anything else looks at the request.
 *   2. Control: with both switches on, the same routes are not 404 (401 without a login), so 1 is the switch and not a typo.
 *
 * Not destructive: every row belongs to the account this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;

const ROUTES: ReadonlyArray<readonly [string, string, unknown]> = [
  ['GET', '/api/runner/browser', undefined],
  ['POST', '/api/runner/browser/open', {}],
  ['POST', '/api/runner/browser/clear', {}],
  ['POST', '/api/runner/browser/sign-in-requests', { site: 'github.com', reason: 'sign in' }],
  ['GET', '/api/runners/00000000-0000-4000-8000-000000000000/browser', undefined],
  ['POST', '/api/runners/00000000-0000-4000-8000-000000000000/browser/clear', {}],
];

test('every route of the four browser tools answers 404 with the switch off, absent or managed runners off', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const RUN = randomUUID().slice(0, 8);
  const userId = randomUUID();
  await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
    [userId, `owner-${RUN}@browser-off.invalid`, 'owner', hashPassword(`pw-${RUN}`)]);
  const runnerId = randomUUID();
  const token = `browser-off-${randomUUID()}`;
  await prisma.runner.create({
    data: { id: runnerId, ownerId: userId, name: 'machine', tokenHash: sha256(token), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
  });
  const sessionId = (await prisma.session.create({
    data: {
      ownerId: userId, creatorId: userId, assignedRunnerId: runnerId, provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
      title: 'browsing', prompt: 'browse', turnState: 'IN_FLIGHT', dispatchOrigin: SessionDispatchOrigin.USER,
    },
    select: { id: true },
  })).id;
  const jwtSecret = `browser-off-${randomUUID()}`;
  const boot = async (managed: string, browser: string) => {
    const server = await startApiserver(url, jwtSecret, {
      ORBIT_MANAGED_RUNNERS_ENABLED: managed, ORBIT_MANAGED_RUNNERS_PROFILE: '', ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser,
    });
    servers.push(server);
    return server;
  };

  const cardRoute = `/api/runner/sessions/${sessionId}/approvals`;
  const card = { toolName: 'orbit_browser_clear_logins', input: {} };

  for (const [label, managed, browser] of [
    ['the browser switch absent', 'true', ''],
    ['the browser switch false', 'true', 'false'],
    ['the browser switch on with managed runners off', 'false', 'true'],
  ] as const) {
    await t.test(`1. ${label}: all seven routes are 404`, async () => {
      const server = await boot(managed, browser);
      for (const [method, route, body] of ROUTES) {
        for (const bearer of [undefined, 'not-a-real-token']) {
          const reply = await call(server, method, route, bearer, body);
          assert.equal(reply.status, 404, `${label}: ${method} ${route} ${bearer ? 'with' : 'without'} a login: ${reply.text}`);
        }
      }
      const filed = await call(server, 'POST', cardRoute, token, card);
      assert.equal(filed.status, 404, `${label}: the clear card: ${filed.text}`);
      const cards = await sql.query(`SELECT count(*)::int AS n FROM "approval" WHERE "session_id" = $1`, [sessionId]);
      assert.equal(cards.rows[0].n, 0, `${label}: a card was written`);
      await server.stop();
    });
  }

  await t.test('2. control: with both switches on, no route is 404 (the login is what is missing)', async () => {
    const server = await boot('true', 'true');
    for (const [method, route, body] of ROUTES) {
      const reply = await call(server, method, route, undefined, body);
      assert.equal(reply.status, 401, `${method} ${route}: ${reply.text}`);
    }
    await server.stop();
  });
});
