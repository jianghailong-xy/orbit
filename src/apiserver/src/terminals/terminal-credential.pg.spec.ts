/**
 * The TERMINAL credential (docs/terminal-session-design.md, "The terminal credential"), held against the production
 * apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates
 * from empty. What it is held to:
 *
 *   (a) a terminal sign-in is started and polled with the machine's RUNNER credential only — none, a login and a
 *       request made on behalf of a session are refused — and is bound to that runner and its owner: the short code,
 *       the runner's name, three seconds, ten minutes; the row keeps the device code's sha256; the owner's
 *       GET /terminals/requests lists it and another account's does not;
 *   (b) only the account owner's app login approves: a personal access token holding every scope is refused 403
 *       OWNER_INTERACTIVE_CREDENTIAL_REQUIRED, the runner credential 401, a live TERMINAL credential 403
 *       TERMINAL_ROUTE_NOT_ALLOWED, another account's login 404 — and none of them decides anything; the owner's
 *       login approves, the next poll by that runner (and no other) mints the credential, once, and it ends exactly
 *       30 days after the approval;
 *   (c) a live TERMINAL credential authenticates — GET /terminals/self answers its machine and account — and is
 *       refused 403 TERMINAL_ROUTE_NOT_ALLOWED on routes off its allowlist (terminal-routes.pg.spec.ts holds the
 *       allowlist): the session list, a session's merge receipts on its own runner, GET and POST project routes, an owner-channel route (an
 *       evidence decision), its own account's list and the approval of another terminal; it writes nothing there, a
 *       login is answered by the same routes, and it is never taken from a URL;
 *   (d) denying tells the terminal so and mints nothing; approving a denied request is 409;
 *   (e) GET /terminals lists the owner's live terminals (machine name, created, last used, expires — never a hash)
 *       and no other account's; DELETE /terminals/:id revokes one and another account's is 404; a revoked
 *       credential is 401 on its next request; DELETE /terminals/self revokes the calling terminal;
 *   (f) an expired credential is 401, and a request past its ten minutes polls expired and cannot be approved;
 *   (g) no row keeps a credential, and no answer but the collecting polls carries one.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/terminals/terminal-credential.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const TERMINAL_REFUSED = {
  code: 'TERMINAL_ROUTE_NOT_ALLOWED',
  credentialKind: 'TERMINAL',
  message: 'A terminal credential cannot call this route; do this in the Orbit app',
};

test('the TERMINAL credential: started by a runner, approved only by the owner\'s app login, 30 days, refused everywhere else, listed, revoked and expired', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const jwtSecret = `terminal-credential-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  /** An account of this run: signed in, with a runner whose credential this spec holds, a workspace, and a token. */
  async function account(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@terminal-credential.invalid`;
    await db.user.create({ data: { id, email, name, role: 'MEMBER', passwordHash: hashPassword(`${name}-password-1`) } });
    const runnerId = randomUUID();
    const runnerToken = `runner-${name}-${RUN}-${randomUUID()}`;
    await db.runner.create({ data: { id: runnerId, ownerId: id, name: `${name}-laptop`, tokenHash: sha256(runnerToken) } });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId: id, runnerId, name: `${name} ${RUN}`, enabled: true } });
    const pat = (await new PatService(db as unknown as PrismaService).issue(id, {
      name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB',
    })).token;
    return { id, email, runnerId, runnerToken, workspaceId, pat, login: await jwt.signAsync({ sub: id, email }) };
  }
  const owner = await account('owner');
  const stranger = await account('stranger');
  server = await startApiserver(url, jwtSecret);

  /** Every answer this run is given, so (g) can say where a credential ever appeared. */
  const answers: Array<{ request: string; text: string }> = [];
  const api = async (method: string, path: string, bearer?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const reply = await call(server!, method, `/api${path}`, bearer, body, headers);
    answers.push({ request: `${method} ${path}`, text: reply.text });
    return reply;
  };
  const expect = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };
  const start = async (who = owner) =>
    expect(await api('POST', '/runner/terminal-login/start', who.runnerToken, {}), 201, 'starting a terminal sign-in');
  const poll = (deviceCode: string, who = owner) => api('POST', '/runner/terminal-login/poll', who.runnerToken, { deviceCode });
  const pollStatus = async (deviceCode: string) => expect(await poll(deviceCode), 200, 'polling').status;
  const decide = (bearer: string, id: string, decision: 'approve' | 'deny') => api('POST', `/terminals/requests/${id}/${decision}`, bearer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requestRow = async (deviceCode: string): Promise<any> =>
    db.terminalLogin.findUniqueOrThrow({ where: { deviceCodeHash: sha256(deviceCode) } });
  const requestIdOf = async (deviceCode: string) => (await requestRow(deviceCode)).id as string;
  const credentialsOf = (who: { id: string }) => db.terminalCredential.findMany({ where: { ownerId: who.id }, orderBy: { createdAt: 'asc' } });
  const collected: string[] = [];
  /** A full sign-in: started by the owner's runner, approved by the owner's login, collected by the next poll. */
  const signIn = async () => {
    const started = await start();
    expect(await decide(owner.login, await requestIdOf(started.deviceCode), 'approve'), 200, 'approving');
    const answer = expect(await poll(started.deviceCode), 200, 'collecting');
    assert.equal(answer.status, 'approved');
    collected.push(answer.token);
    return { ...answer, deviceCode: started.deviceCode };
  };

  await t.test('(a) a sign-in is started and polled with the machine\'s runner credential, bound to that runner and its owner', async () => {
    expect(await api('POST', '/runner/terminal-login/start', undefined, {}), 401, 'starting with no credential');
    expect(await api('POST', '/runner/terminal-login/start', owner.login, {}), 401, 'starting with a login');
    const fromSession = await api('POST', '/runner/terminal-login/start', owner.runnerToken, {}, { 'x-orbit-session-id': randomUUID() });
    assert.equal(expect(fromSession, 403, 'starting on behalf of a session').code, 'TERMINAL_LOGIN_FROM_SESSION');
    assert.equal(await db.terminalLogin.count({ where: { ownerId: owner.id } }), 0, 'nothing was started');

    const started = await start();
    assert.match(started.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(started.userCode, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    assert.equal(started.machineName, 'owner-laptop');
    assert.equal(started.interval, 3);
    assert.equal(started.expiresIn, 600);
    const row = await requestRow(started.deviceCode);
    assert.equal(row.ownerId, owner.id);
    assert.equal(row.runnerId, owner.runnerId);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.userCode, started.userCode);
    assert.equal(row.deviceCodeHash, sha256(started.deviceCode));
    assert.ok(!JSON.stringify(row).includes(started.deviceCode), 'the row keeps the hash, never the code');
    assert.equal(await pollStatus(started.deviceCode), 'pending');
    expect(await poll(started.deviceCode, stranger), 404, 'another runner polling it');

    const pending = expect(await api('GET', '/terminals/requests', owner.login), 200, 'the owner reading the card').requests;
    assert.deepEqual(pending.map((r: { id: string }) => toUuid(r.id)), [row.id]);
    assert.equal(pending[0].userCode, started.userCode);
    assert.equal(pending[0].machineName, 'owner-laptop');
    assert.deepEqual(expect(await api('GET', '/terminals/requests', stranger.login), 200, 'another account reading its cards').requests, []);
    expect(await decide(owner.login, row.id, 'deny'), 200, 'clearing the request for the cases below');
  });

  // The credential the cases below knock with: one terminal of the owner's, already signed in.
  const first = await signIn();

  await t.test('(b) only the account owner\'s app login approves; a token, the runner and a terminal are refused and decide nothing', async () => {
    const started = await start();
    const id = await requestIdOf(started.deviceCode);

    const byToken = await decide(owner.pat, id, 'approve');
    assert.equal(expect(byToken, 403, 'a token approving').code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    expect(await decide(owner.runnerToken, id, 'approve'), 401, 'the runner credential approving');
    assert.deepEqual(expect(await decide(first.token, id, 'approve'), 403, 'a terminal approving'), TERMINAL_REFUSED);
    expect(await decide(stranger.login, id, 'approve'), 404, 'another account approving');
    expect(await decide(stranger.login, id, 'deny'), 404, 'another account denying');
    expect(await decide(owner.pat, id, 'deny'), 403, 'a token denying');
    assert.deepEqual(expect(await decide(first.token, id, 'deny'), 403, 'a terminal denying'), TERMINAL_REFUSED);
    for (const bearer of [owner.pat, first.token]) {
      expect(await api('GET', '/terminals/requests', bearer), 403, 'the card read with a token or a terminal');
    }
    assert.equal((await requestRow(started.deviceCode)).status, 'PENDING', 'nobody but the owner decided it');
    assert.equal(await pollStatus(started.deviceCode), 'pending');

    const approved = expect(await decide(owner.login, id, 'approve'), 200, 'the owner approving');
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.machineName, 'owner-laptop');
    expect(await decide(owner.login, id, 'approve'), 200, 'approving it again: answered as it stands');
    assert.equal((await credentialsOf(owner)).length, 1, 'approving mints nothing until the terminal collects it');
    expect(await poll(started.deviceCode, stranger), 404, 'another runner collecting it');

    const answer = expect(await poll(started.deviceCode), 200, 'the terminal collecting');
    collected.push(answer.token);
    assert.equal(answer.status, 'approved');
    assert.match(answer.token, /^orbit_term_[A-Za-z0-9_-]{43}$/);
    assert.equal(answer.machineName, 'owner-laptop');
    assert.equal(await pollStatus(started.deviceCode), 'delivered', 'a second poll collects nothing');
    const minted = await credentialsOf(owner);
    assert.equal(minted.length, 2, 'one credential per approval');
    const credential = minted.find((c) => c.tokenHash === sha256(answer.token))!;
    const decidedAt = (await requestRow(started.deviceCode)).decidedAt as Date;
    assert.equal(credential.runnerId, owner.runnerId);
    assert.equal(credential.approvedAt.getTime(), decidedAt.getTime());
    assert.equal(credential.expiresAt.getTime() - decidedAt.getTime(), 30 * DAY_MS, 'it ends 30 days after the approval');
    assert.equal(new Date(answer.expiresAt).getTime(), credential.expiresAt.getTime());
  });

  await t.test('(c) a live TERMINAL credential authenticates, and is refused 403 on every ordinary route', async () => {
    const self = expect(await api('GET', '/terminals/self', first.token), 200, 'the terminal reading itself');
    assert.equal(self.email, owner.email);
    assert.equal(self.terminal.machineName, 'owner-laptop');
    assert.equal(toUuid(self.terminal.runnerId), owner.runnerId);
    assert.equal(toUuid(self.terminal.id), toUuid(first.terminalId));
    expect(await api('GET', '/terminals/self', owner.login), 403, 'a login asking for "its" terminal');

    // What the routes are knocked on: the owner's own session and project, made with the owner's login.
    const sessionId = toUuid(expect(await api('POST', '/sessions', owner.login, { prompt: 'knocked on', workspaceId: owner.workspaceId }), 201, 'a login opening a session').id);
    const projectId = toUuid(expect(await api('POST', '/projects', owner.login, {
      title: 'knocked on', acceptanceCriteriaItems: [{ text: 'a terminal is refused', verificationMethod: 'this spec' }],
    }), 201, 'a login making a project').id);
    const counts = async () => ({
      sessions: await db.session.count({ where: { ownerId: owner.id } }),
      projects: await db.project.count({ where: { ownerId: owner.id } }),
    });
    const before = await counts();
    const routes: Array<{ method: string; path: string; body?: unknown; login: number }> = [
      { method: 'GET', path: '/sessions', login: 200 },
      // A session route off the allowlist, on a session of the terminal's own runner. (Its approval list is on the
      // allowlist since 21c1921d3: the TUI reads it on open; terminal-routes.pg.spec.ts holds that.)
      { method: 'GET', path: `/sessions/${sessionId}/merge-receipts`, login: 200 },
      // An owner-channel door other than answering an approval card: a task's evidence decision (no such task).
      {
        method: 'POST', path: `/tasks/${randomUUID()}/evidence/decision`,
        body: { decision: 'CONFIRM', evidenceRevision: '1', decidingSessionId: randomUUID() }, login: 404,
      },
      { method: 'GET', path: `/projects/${projectId}`, login: 200 },
      { method: 'POST', path: '/projects', body: { title: 'from a terminal', acceptanceCriteriaItems: [{ text: 'x', verificationMethod: 'y' }] }, login: 201 },
      { method: 'GET', path: '/users/me', login: 200 },
      { method: 'GET', path: '/terminals', login: 200 },
      { method: 'GET', path: '/access-tokens', login: 200 },
    ];
    for (const route of routes) {
      const byTerminal = await api(route.method, route.path, first.token, route.body);
      assert.deepEqual(expect(byTerminal, 403, `a terminal on ${route.method} ${route.path}`), TERMINAL_REFUSED);
    }
    assert.deepEqual(await counts(), before, 'the terminal wrote nothing');
    for (const route of routes) {
      expect(await api(route.method, route.path, owner.login, route.body), route.login, `a login on ${route.method} ${route.path}`);
    }
    // Never from a URL: the event stream takes a login's token from its query, and a terminal's is refused there.
    expect(await api('GET', `/events?access_token=${encodeURIComponent(first.token)}`), 401, 'a terminal in a URL');
  });

  await t.test('(d) denying tells the terminal so and mints nothing; approving a denied request is 409', async () => {
    const started = await start();
    const id = await requestIdOf(started.deviceCode);
    const count = (await credentialsOf(owner)).length;
    assert.equal(expect(await decide(owner.login, id, 'deny'), 200, 'denying').status, 'DENIED');
    assert.equal(await pollStatus(started.deviceCode), 'denied');
    assert.equal(expect(await decide(owner.login, id, 'approve'), 409, 'approving a denied request').code, 'TERMINAL_LOGIN_DECIDED');
    expect(await decide(owner.login, id, 'deny'), 200, 'denying it again: answered as it stands');
    assert.equal((await credentialsOf(owner)).length, count);
  });

  await t.test('(e) list and revoke: the owner\'s live terminals, another account\'s refused, revoked is 401 next time', async () => {
    const second = await signIn();
    expect(await api('GET', '/terminals/self', second.token), 200, 'refreshing last used');
    // `last_used_at` is written after the answer, never awaited by the request: wait for the row.
    for (let i = 0; i < 100; i++) {
      if ((await db.terminalCredential.findUniqueOrThrow({ where: { tokenHash: sha256(second.token) } })).lastUsedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const listed = expect(await api('GET', '/terminals', owner.login), 200, 'listing').terminals;
    assert.ok(listed.length >= 2);
    for (const row of listed) {
      assert.deepEqual(Object.keys(row).filter((k) => k !== 'publicId' && !k.endsWith('PublicId')).sort(),
        ['approvedAt', 'createdAt', 'expiresAt', 'id', 'lastUsedAt', 'machineName', 'runnerId']);
      assert.equal(row.machineName, 'owner-laptop');
    }
    const secondRow = listed.find((r: { id: string }) => toUuid(r.id) === toUuid(second.terminalId));
    assert.ok(secondRow?.lastUsedAt, 'last used is recorded');
    assert.deepEqual(expect(await api('GET', '/terminals', stranger.login), 200, 'another account listing').terminals, []);

    expect(await api('DELETE', `/terminals/${toUuid(first.terminalId)}`, stranger.login), 404, 'another account revoking');
    expect(await api('DELETE', `/terminals/${toUuid(first.terminalId)}`, owner.pat), 403, 'a token revoking');
    expect(await api('GET', '/terminals/self', first.token), 200, 'still live after both');

    const revoked = expect(await api('DELETE', `/terminals/${toUuid(first.terminalId)}`, owner.login), 200, 'the owner revoking');
    assert.ok(revoked.revokedAt);
    expect(await api('GET', '/terminals/self', first.token), 401, 'a revoked credential on its next request');
    expect(await api('POST', '/sessions', first.token, { prompt: 'x', workspaceId: owner.workspaceId }), 401, 'a revoked credential anywhere');
    expect(await api('DELETE', `/terminals/${toUuid(first.terminalId)}`, owner.login), 200, 'revoking it again: answered as it stands');
    const after = expect(await api('GET', '/terminals', owner.login), 200, 'listing again').terminals.map((r: { id: string }) => toUuid(r.id));
    assert.ok(!after.includes(toUuid(first.terminalId)), 'a revoked terminal is not listed');

    expect(await api('DELETE', '/terminals/self', second.token), 200, 'a terminal revoking itself');
    expect(await api('GET', '/terminals/self', second.token), 401, 'and is refused after');
  });

  await t.test('(f) an expired credential is 401; a request past its ten minutes polls expired and cannot be approved', async () => {
    const live = await signIn();
    expect(await api('GET', '/terminals/self', live.token), 200, 'live');
    await db.terminalCredential.update({ where: { tokenHash: sha256(live.token) }, data: { expiresAt: new Date(Date.now() - 1000), approvedAt: new Date(Date.now() - 31 * DAY_MS) } });
    expect(await api('GET', '/terminals/self', live.token), 401, 'expired');
    const listed = expect(await api('GET', '/terminals', owner.login), 200, 'listing').terminals.map((r: { id: string }) => toUuid(r.id));
    assert.ok(!listed.includes(toUuid(live.terminalId)), 'an expired terminal is not listed');

    const started = await start();
    const id = await requestIdOf(started.deviceCode);
    await db.terminalLogin.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal(await pollStatus(started.deviceCode), 'expired');
    expect(await decide(owner.login, id, 'approve'), 404, 'approving an expired request');
  });

  await t.test('(g) no row keeps a credential, and only the collecting polls carry one', async () => {
    const rows = JSON.stringify([
      ...(await db.terminalLogin.findMany({ where: { ownerId: owner.id } })),
      ...(await credentialsOf(owner)),
    ]);
    for (const token of collected) {
      assert.ok(!rows.includes(token), 'a row holds a credential');
      const carriers = answers.filter((a) => a.text.includes(token)).map((a) => a.request);
      assert.deepEqual(carriers, ['POST /runner/terminal-login/poll'], `the credential appeared in ${carriers.join(', ')}`);
    }
  });
});
