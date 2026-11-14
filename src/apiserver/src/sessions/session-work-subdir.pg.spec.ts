/**
 * POST /sessions `workSubdir` (sessions/work-subdir.ts): `orbit` typed in a folder below its workspace's directory
 * opens a session that runs in that folder, so it sends the folder, relative to the workspace's directory, with
 * `worktree: false`. Held against the production apiserver — `build/main.js`, the whole AppModule — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   1. a TERMINAL credential's POST /sessions stores a valid workSubdir on the session (and no branch);
 *   2. from a terminal and from the app's login alike, an absolute path, a `..` segment, a path that is not
 *      normalized, an empty one, a non-string, and one sent for a session that has a worktree are each a 400,
 *      and none of them writes a session;
 *   3. the runner's claim and its reclaim deliver it beside the workspace's workDir; a session without one
 *      delivers no such key.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-work-subdir.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import net from 'node:net';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { TerminalCredentials } from '../auth/terminal-credentials';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const WORK_DIR = '/home/dev/shop-api';
const GATEWAY_TOKEN = `work-subdir-gateway-${randomUUID()}`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test('POST /sessions workSubdir: stored when valid, refused 400 with no row otherwise, delivered on the claim', {
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

  const jwtSecret = `work-subdir-${randomUUID()}`;
  const ownerId = randomUUID();
  const email = `work-subdir-${RUN}@work-subdir.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'work-subdir', role: 'MEMBER', passwordHash: hashPassword('work-subdir-password-1') } });
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });
  const runnerToken = `runner-${randomUUID()}`;
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: `work-subdir-${RUN}`, tokenHash: sha256(runnerToken), maxConcurrent: 4 } });
  // The workspace's own setting is worktrees: the terminal's `worktree: false` overrides it.
  const workspaceId = randomUUID();
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `work-subdir ${RUN}`, workDir: WORK_DIR, enableWorktree: true, enabled: true },
  });
  const { token: terminal, tokenHash } = TerminalCredentials.newSecret();
  const approvedAt = new Date();
  await db.terminalCredential.create({
    data: { tokenHash, ownerId, runnerId, machineName: 'dev-laptop', approvedAt, expiresAt: TerminalCredentials.expiryOf(approvedAt) },
  });
  // The runner daemon's claim and reclaim come over the runner link alone: the gateway forwards them to the internal
  // listener (runner-api/runner-link-required.ts).
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingKey = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64');
  const internalPort = await freePort();
  server = await startApiserver(url, jwtSecret, {
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: 'wss://link.work-subdir.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
    RUNNER_LINK_INTERNAL_PORT: String(internalPort),
    RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
  });
  const linkListener: Apiserver = { ...server, port: internalPort };

  const api = (method: string, path: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body, headers);
  const sessionCount = () => db.session.count({ where: { ownerId } });
  const terminalBody = (extra: Record<string, unknown>) =>
    ({ prompt: 'add rate limiting', workspaceId, assignedRunnerId: runnerId, worktree: false, ...extra });

  let subdirSession = '';
  let plainSession = '';

  await t.test('1. a terminal\'s POST /sessions stores a valid workSubdir, with no branch', async () => {
    for (const workSubdir of ['services/api', 'services']) {
      const made = await api('POST', '/sessions', terminal, terminalBody({ workSubdir }));
      assert.equal(made.status, 201, made.text);
      const row = await db.session.findUniqueOrThrow({ where: { id: toUuid(made.json.id) }, select: { workSubdir: true, branch: true } });
      assert.deepEqual(row, { workSubdir, branch: null }, workSubdir);
      if (workSubdir === 'services/api') subdirSession = toUuid(made.json.id);
    }
    const plain = await api('POST', '/sessions', terminal, terminalBody({}));
    assert.equal(plain.status, 201, plain.text);
    plainSession = toUuid(plain.json.id);
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: plainSession } })).workSubdir, null, 'none sent, none stored');
  });

  await t.test('2. absolute, "..", non-normalized and the rest: 400 from every caller, and no session is written', async () => {
    const refused: Array<[unknown, RegExp]> = [
      ['..', /must not contain a "\.\." segment/],
      ['../other', /must not contain a "\.\." segment/],
      ['services/../../etc', /must not contain a "\.\." segment/],
      ['/etc', /must be relative to the workspace directory, not absolute/],
      ['/home/dev/shop-api/services', /must be relative to the workspace directory, not absolute/],
      ['C:/Users/dev', /must be relative to the workspace directory, not absolute/],
      ['services//api', /must be normalized/],
      ['./services', /must be normalized/],
      ['services/./api', /must be normalized/],
      ['services/', /must be normalized/],
      ['services\\api', /must separate folders with "\/"/],
      ['', /names no folder below the workspace directory/],
      ['.', /names no folder below the workspace directory/],
      [42, /workSubdir must be a string/],
    ];
    const before = await sessionCount();
    for (const bearer of [terminal, login]) {
      const who = bearer === terminal ? 'terminal' : 'login';
      for (const [workSubdir, message] of refused) {
        const reply = await api('POST', '/sessions', bearer, terminalBody({ workSubdir }));
        assert.equal(reply.status, 400, `${who} ${JSON.stringify(workSubdir)}: ${reply.text}`);
        assert.match(String(reply.json?.message), message, `${who} ${JSON.stringify(workSubdir)}`);
      }
      // A session with a worktree runs in its own checkout: a folder of the workspace's directory means nothing there.
      for (const worktree of [undefined, true]) {
        const reply = await api('POST', '/sessions', bearer, { ...terminalBody({ workSubdir: 'services' }), worktree });
        assert.equal(reply.status, 400, `${who} worktree ${String(worktree)}: ${reply.text}`);
        assert.match(String(reply.json?.message), /is only for a session with no worktree/);
      }
    }
    assert.equal(await sessionCount(), before, 'no refusal wrote a session');
  });

  await t.test('3. the claim and the reclaim deliver it beside workDir; a session without one delivers none', async () => {
    const leaseOwner = randomUUID();
    const minted = await api('POST', '/runner/link-token', runnerToken, { leaseOwner });
    assert.equal(minted.status, 200, minted.text);
    let n = 0;
    const viaLink = (method: string, path: string, body?: unknown) =>
      call(linkListener, method, `/api${path}`, GATEWAY_TOKEN, body, {
        'x-orbit-runner-link-token': minted.json.token, 'x-orbit-link-request-id': `r:${leaseOwner}:${n++}`,
      });
    const beat = await viaLink('POST', '/runner/heartbeat', {
      leaseOwner, status: 'ONLINE', idleCapacity: 4, engines: [{ engine: 'claude', installed: true, auth: 'yes', version: '2.3.0' }],
    });
    assert.ok(beat.status === 200 || beat.status === 201, `heartbeat ${beat.status}: ${beat.text}`);
    const claimed = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < 6 && !(claimed.has(subdirSession) && claimed.has(plainSession)); i += 1) {
      const claim = await viaLink('GET', '/runner/sessions/claim');
      assert.equal(claim.status, 200, claim.text);
      if (!claim.json?.sessionId) break;
      claimed.set(toUuid(claim.json.sessionId), claim.json);
    }
    assert.ok(claimed.has(subdirSession) && claimed.has(plainSession), `claimed ${[...claimed.keys()].join(', ')}`);
    assert.equal(claimed.get(subdirSession)?.workSubdir, 'services/api');
    assert.equal(claimed.get(subdirSession)?.workDir, WORK_DIR);
    assert.equal('workSubdir' in claimed.get(plainSession)!, false, 'no folder, no key');

    const reclaimed = await viaLink('GET', '/runner/sessions/reclaim');
    assert.equal(reclaimed.status, 200, reclaimed.text);
    const held = new Map<string, Record<string, unknown>>(
      reclaimed.json.sessions.map((s: { sessionId: string }) => [toUuid(s.sessionId), s]),
    );
    assert.equal(held.get(subdirSession)?.workSubdir, 'services/api', 'the reclaim says it too');
    assert.equal(held.get(subdirSession)?.workDir, WORK_DIR);
    assert.equal(held.has(plainSession) && !('workSubdir' in held.get(plainSession)!), true, 'and says nothing for one without');
  });
});
