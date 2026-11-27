/**
 * browser_clear_logins and `orbit browser clear-logins` (runner-api/runner-browser-clear-approval.ts,
 * runner-browser.controller.ts; board docs/mocks/runner-browser/03-agent-tools.html ②), on the production apiserver —
 * `build/main.js`, the whole AppModule, run as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty. The spec plays the runners' `orbit mcp`: it files the card on the approvals route, the owner
 * answers it on theirs, and the tool's clear goes to POST /api/runner/browser/clear naming the card. It plays the
 * managed runner's instance on POST /api/runner/heartbeat, whose answer's `clearBrowserProfile` IS the profile-clear
 * request sent to the runner (it then stops Chrome and deletes ~/.orbit/browser/profile).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-browser-clear-logins.pg.spec.ts
 *
 * Account A owns a managed runner R with a session SR on it, and a self-managed runner M with a session SM on it.
 * Account B is a stranger with a self-managed runner N and a session SN on it.
 *
 *   1. With the browser switch off, no card is filed and the clear route is 404.
 *   2. With it on, the card is the server's: English copy saying the browser stops and every saved login on the runner
 *      is removed, and A's Orbit Cloud runner, whatever the asker sent. While it waits, a clear naming it is refused.
 *   3. Declined, expired (its reader went away unanswered: the reaper's ABANDONED) or allowed by no person: the clear is
 *      403 and nothing is sent to the runner — the row asks for no clear and R's next beat is handed none.
 *   4. Confirmed: the clear is 202, R's next beat is handed clearBrowserProfile exactly once; the spent card clears
 *      nothing a second time. Any session of the account may (SM, on another machine); another session's card is
 *      refused, another account's session reaches only its own account (no Orbit Cloud runner: 404), B's runner naming
 *      A's session is 403, and B is filed no card.
 *
 * Not destructive: every row belongs to the accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { RunnerStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { reapApprovalsOfEndedTurns } from '../sessions/abandoned-approvals';
import { BROWSER_CLEAR_CARD_TEXT } from './runner-browser-clear-approval';
// The heartbeat is called over plain HTTP, as the link gateway's forwarded call reaches the same handler.
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const INSTANCE_CAPABILITY = 'managed-runner-instance-v1';
const BROWSER_CLEAR = 'browser-clear/v1';
const TOOL = 'orbit_browser_clear_logins';

test('browser_clear_logins: the profile is cleared only on the owner\'s yes; a declined or expired card sends nothing', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  const servers: Apiserver[] = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const JWT_SECRET = `browser-clear-${randomUUID()}`;
  const jwt = new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '1h' } });
  const account = async (name: string) => {
    const user = { id: randomUUID(), email: `${name}-${RUN}@browser-clear.invalid` };
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [user.id, user.email, name, hashPassword(`pw-${name}-${RUN}`)]);
    return { ...user, login: () => jwt.signAsync({ sub: user.id, email: user.email }) };
  };
  const a = await account('owner');
  const b = await account('stranger');
  const runner = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `browser-clear-${name}-${randomUUID()}`;
    await prisma.runner.create({
      data: { id, ownerId, name: `machine ${name}`, tokenHash: sha256(token), status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
    });
    return { id, token };
  };
  const session = async (ownerId: string, runnerId: string, title: string) =>
    (await prisma.session.create({
      data: {
        ownerId, creatorId: ownerId, assignedRunnerId: runnerId, provider: 'claude', engine: 'claude', model: 'claude-opus-5-5',
        title, prompt: 'browse', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      },
      select: { id: true },
    })).id;
  const r = await runner(a.id, 'managed');
  const m = await runner(a.id, 'self-managed');
  const n = await runner(b.id, 'stranger');
  const podUid = randomUUID();
  await prisma.managedRunner.create({
    data: {
      ownerId: a.id, runnerId: r.id, clusterKey: 'browser-clear-spec', namespace: 'orbit', pvcName: `mr-data-${r.id}`,
      desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
    },
  });
  await prisma.runner.update({ where: { id: r.id }, data: { capabilities: [INSTANCE_CAPABILITY, BROWSER_CLEAR] } });
  const sr = await session(a.id, r.id, 'a session on the Orbit Cloud runner');
  const sm = await session(a.id, m.id, 'a session on a machine of the owner');
  const sn = await session(b.id, n.id, 'the stranger\'s session');

  const boot = async (browser: string) => {
    const server = await startApiserver(url, JWT_SECRET, {
      ORBIT_MANAGED_RUNNERS_ENABLED: 'true', ORBIT_MANAGED_RUNNERS_PROFILE: '', ORBIT_MANAGED_RUNNER_BROWSER_ENABLED: browser,
    });
    servers.push(server);
    return server;
  };
  /** R's own credential is a managed runner's: its calls name the instance, as `orbit mcp` in R's Pod does. */
  const headersOf = (token: string): Record<string, string> => (token === r.token
    ? {
      'x-orbit-runner-capabilities': `${INSTANCE_CAPABILITY},${BROWSER_CLEAR}`,
      'x-orbit-cloud-runner-generation': '1',
      'x-orbit-cloud-runner-pod-uid': podUid,
    }
    : {});
  type Who = { token: string; sessionId: string };
  const SR: Who = { token: r.token, sessionId: sr };
  const SM: Who = { token: m.token, sessionId: sm };
  const SN: Who = { token: n.token, sessionId: sn };
  /** What browser_clear_logins files: nothing of its own in the input. Extra fields are what a caller might try. */
  const fileCard = (server: Apiserver, who: Who, extra: Record<string, unknown> = {}) =>
    call(server, 'POST', `/api/runner/sessions/${who.sessionId}/approvals`, who.token,
      { toolName: TOOL, input: {}, ...extra }, headersOf(who.token));
  const answer = async (server: Apiserver, sessionId: string, approvalId: string, behavior: 'allow' | 'deny') => {
    const reply = await call(server, 'POST', `/api/sessions/${sessionId}/approvals/${approvalId}/decision`, await a.login(), { behavior });
    assert.ok(reply.status < 300, reply.text);
  };
  const clear = (server: Apiserver, who: Who, approvalId: unknown) =>
    call(server, 'POST', '/api/runner/browser/clear', who.token, { approvalId }, {
      ...headersOf(who.token), 'x-orbit-session-id': who.sessionId,
    });
  const beat = async (server: Apiserver) => {
    const reply = await call(server, 'POST', '/api/runner/heartbeat', r.token,
      { version: '0.1.0', browser: { running: true, viewers: 0, savedLogins: true } }, headersOf(r.token));
    assert.equal(reply.status, 201, `R's heartbeat: ${reply.text}`);
    return reply.json as { clearBrowserProfile?: boolean };
  };
  const clearRequested = async () =>
    (await prisma.runner.findUniqueOrThrow({ where: { id: r.id }, select: { browserClearRequestedAt: true } })).browserClearRequestedAt;
  /** Nothing was sent to the runner: the row asks for no clear, and R's next beat is handed none. */
  const nothingSent = async (server: Apiserver, why: string) => {
    assert.equal(await clearRequested(), null, `${why}: the row asks R for a clear`);
    assert.equal((await beat(server)).clearBrowserProfile, undefined, `${why}: R's beat is handed the clear`);
  };

  await t.test('1. with the browser switch off, no card is filed and the clear is absent', async () => {
    const off = await boot('');
    const filed = await fileCard(off, SR);
    assert.equal(filed.status, 404, filed.text);
    assert.equal(await prisma.approval.count({ where: { sessionId: sr, toolName: TOOL } }), 0, 'a card was filed');
    const cleared = await clear(off, SR, randomUUID());
    assert.equal(cleared.status, 404, cleared.text);
    assert.match(cleared.text, /Cannot POST \/api\/runner\/browser\/clear/);
    await off.stop();
  });

  const on = await boot('true');
  await beat(on);

  await t.test('2. the card is the server\'s, in English; while it waits nothing is cleared', async () => {
    const filed = await fileCard(on, SR, { input: { runnerId: n.id, description: 'a harmless refresh' } });
    assert.ok(filed.status < 300, filed.text);
    assert.equal(filed.json.status, 'PENDING');
    const stored = await prisma.approval.findUniqueOrThrow({ where: { id: toUuid(filed.json.id as string) }, select: { input: true } });
    assert.deepEqual(stored.input, { description: BROWSER_CLEAR_CARD_TEXT, runnerId: r.id, runnerName: 'machine managed' });
    assert.match(BROWSER_CLEAR_CARD_TEXT, /the browser stops, and every saved login on the runner is removed/);
    assert.doesNotMatch(BROWSER_CLEAR_CARD_TEXT, /[一-鿿]/);
    const early = await clear(on, SR, filed.json.id);
    assert.equal(early.status, 403, early.text);
    assert.match(early.text, /BROWSER_CLEAR_APPROVAL_REQUIRED/);
    await nothingSent(on, 'a waiting card');
    await answer(on, sr, filed.json.id as string, 'deny');
  });

  await t.test('3. declined, expired or allowed by no person: nothing is sent to the runner', async () => {
    const declined = await fileCard(on, SR);
    await answer(on, sr, declined.json.id as string, 'deny');
    const afterNo = await clear(on, SR, declined.json.id);
    assert.equal(afterNo.status, 403, afterNo.text);
    await nothingSent(on, 'a declined card');

    // Expired: the runner-hosted job that asked (browser_clear_logins hands its wait to one) went away unanswered, and
    // the reaper collects the card.
    const expiring = await fileCard(on, SR, { backgroundJobId: `bgj_gone_${RUN}` });
    assert.equal(expiring.json.status, 'PENDING', expiring.text);
    assert.ok(await reapApprovalsOfEndedTurns(prisma, sr) >= 1);
    const expired = await prisma.approval.findUniqueOrThrow({ where: { id: toUuid(expiring.json.id as string) }, select: { status: true } });
    assert.equal(expired.status, 'ABANDONED');
    const afterExpiry = await clear(on, SR, expiring.json.id);
    assert.equal(afterExpiry.status, 403, afterExpiry.text);
    await nothingSent(on, 'an expired card');

    // ALLOWED with no person behind it (a standing rule's allow): nobody was asked.
    const ruled = await fileCard(on, SR);
    await prisma.approval.update({ where: { id: toUuid(ruled.json.id as string) }, data: { status: 'ALLOWED', decidedAt: new Date() } });
    const afterRule = await clear(on, SR, ruled.json.id);
    assert.equal(afterRule.status, 403, afterRule.text);
    for (const bogus of [undefined, '', randomUUID()]) {
      const reply = await clear(on, SR, bogus);
      assert.equal(reply.status, 403, `${String(bogus)}: ${reply.text}`);
    }
    // An id that decodes to nothing is refused before the handler runs (the body's PublicIdPipe).
    const garbled = await clear(on, SR, 'not-an-id');
    assert.equal(garbled.status, 400, garbled.text);
    await nothingSent(on, 'no person\'s yes');
  });

  await t.test('4. confirmed: the clear is sent once; any session of the account, never another\'s card or account', async () => {
    const yes = await fileCard(on, SR);
    await answer(on, sr, yes.json.id as string, 'allow');

    // Another session of the account may not spend SR's yes. Another account's session reaches only its own account,
    // which has no Orbit Cloud runner (404, naming nothing of A's), and B's runner naming A's session is refused.
    for (const [who, caller, code] of [['SM with SR\'s card', SM, 403], ['B\'s session', SN, 404]] as const) {
      const reply = await clear(on, caller, yes.json.id);
      assert.equal(reply.status, code, `${who}: ${reply.text}`);
    }
    const crossed = await call(on, 'POST', '/api/runner/browser/clear', n.token, { approvalId: yes.json.id }, { 'x-orbit-session-id': sr });
    assert.equal(crossed.status, 403, `B's runner naming SR: ${crossed.text}`);
    await nothingSent(on, 'a refused caller');

    const sent = await clear(on, SR, yes.json.id);
    assert.equal(sent.status, 202, sent.text);
    assert.equal(toUuid(sent.json.runnerId as string), r.id);
    assert.equal(toUuid(sent.json.approvalId as string), toUuid(yes.json.id as string));
    assert.equal((await clearRequested())?.toISOString(), sent.json.requestedAt);
    assert.equal((await beat(on)).clearBrowserProfile, true, 'R\'s next beat is handed the clear');
    assert.equal((await beat(on)).clearBrowserProfile, undefined, 'exactly once');

    const again = await clear(on, SR, yes.json.id);
    assert.equal(again.status, 403, `the spent card: ${again.text}`);
    await nothingSent(on, 'a spent card');

    // Any session of the account: SM, on another machine, asks and is answered yes.
    const fromM = await fileCard(on, SM);
    assert.ok(fromM.status < 300, fromM.text);
    await answer(on, sm, fromM.json.id as string, 'allow');
    const sentM = await clear(on, SM, fromM.json.id);
    assert.equal(sentM.status, 202, sentM.text);
    assert.equal((await beat(on)).clearBrowserProfile, true);

    // B has no Orbit Cloud runner: no card is filed, as there is nothing a yes could clear.
    const strangers = await fileCard(on, SN);
    assert.equal(strangers.status, 404, strangers.text);
    assert.equal(await prisma.approval.count({ where: { sessionId: sn } }), 0);
  });
});
