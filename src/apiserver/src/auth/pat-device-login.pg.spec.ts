/**
 * `orbit login` through the browser (docs/personal-access-token-design.md §7.3), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty. What it is held to:
 *
 *   (1) POST /access-tokens/device/start needs no credential and answers a device code, a user code,
 *       how often to poll and how long the request lives (ten minutes); the row keeps the device
 *       code's sha256, never the code. What it asks for is checked as issuing checks it: an unknown
 *       scope, a blank name, both or neither of scopes and preset, a lifetime other than 30, 90, 365
 *       or null are 400 and write nothing;
 *   (2) the approval page reads the request signed in — the name, the scopes (a preset expanded),
 *       the lifetime, the host, PENDING — while the CLI's poll, with no credential, answers pending;
 *   (3) approving issues nothing yet; the next poll issues the token to whoever approved — created
 *       CLI_DEVICE, the requested scopes, 90 days when no lifetime was asked for — and answers it,
 *       the one answer of this run that carries it; the token works (GET /pat/self is the
 *       approver); a second poll answers delivered and issues no second token; never-expiring and
 *       listed scopes are issued as asked;
 *   (4) denying answers the CLI denied and issues nothing; approving a denied request is 409, and
 *       denying it again is answered as it stands;
 *   (5) a request past its ten minutes polls expired, and its page, approval and denial are 404;
 *       an approval the CLI did not collect within them polls expired and issues nothing;
 *   (6) a name one of the approver's live tokens holds: the page says nameInUse, approving is 409
 *       PAT_NAME_IN_USE and leaves the request PENDING;
 *   (7) a token, even one holding every scope, is refused the page, the approval and the denial —
 *       403 PAT_FORBIDDEN, TOKEN_MANAGEMENT — and decides nothing;
 *   (8) an unknown device code polls 404; an unknown user code is 404 to the page;
 *   (9) no row of pat_device_login holds a token, and no answer but the collecting polls carries one.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/pat-device-login.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates or to a request it starts.
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
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PAT_FORBIDDEN_REASONS } from './pat-scope.decorator';
import { PAT_SCOPES } from './pat.service';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;
const READ_SCOPES = PAT_SCOPES.filter((scope) => scope.endsWith(':read'));

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('orbit login through the browser: started and polled with no credential, decided signed in, the token issued to the approver by the next poll, once; denied, expired, a taken name, and closed to every token', {
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

  const jwtSecret = `pat-device-login-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  /** A user of this run, signed in. Each case has its own: the page's lookups are throttled per user. */
  async function user(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@pat-device-login.invalid`;
    await db.user.create({ data: { id, email, name, role: 'MEMBER', passwordHash: hashPassword(`${name}-password-1`) } });
    return { id, email, login: await jwt.signAsync({ sub: id, email }) };
  }
  server = await startApiserver(url, jwtSecret);

  /** Every answer this run is given, so (9) can say where a token ever appeared. */
  const answers: Array<{ request: string; text: string }> = [];
  const api = async (method: string, path: string, bearer?: string, body?: unknown): Promise<Reply> => {
    const reply = await call(server!, method, `/api${path}`, bearer, body);
    answers.push({ request: `${method} ${path}`, text: reply.text });
    return reply;
  };
  const expect = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };
  const collected: string[] = [];
  const start = async (body: Record<string, unknown>) =>
    expect(await api('POST', '/access-tokens/device/start', undefined, body), 201, `starting ${JSON.stringify(body)}`);
  const poll = (deviceCode: string) => api('POST', '/access-tokens/device/poll', undefined, { deviceCode });
  const pollStatus = async (deviceCode: string) => expect(await poll(deviceCode), 200, 'polling').status;
  const page = (bearer: string, userCode: string) => api('GET', `/access-tokens/device/${encodeURIComponent(userCode)}`, bearer);
  const decide = (bearer: string, userCode: string, decision: 'approve' | 'deny') =>
    api('POST', `/access-tokens/device/${encodeURIComponent(userCode)}/${decision}`, bearer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const request = async (userCode: string): Promise<any> =>
    (await sql.query('SELECT * FROM pat_device_login WHERE user_code = $1', [userCode])).rows[0];
  const tokensOf = async (owner: { id: string }) =>
    (await sql.query('SELECT * FROM personal_access_token WHERE owner_id = $1 ORDER BY created_at', [owner.id])).rows;
  const nearly = (iso: string | null, days: number) =>
    iso !== null && Math.abs(new Date(iso).getTime() - (Date.now() + days * DAY_MS)) < 120_000;

  await t.test('(1) start needs no credential, keeps only the device code\'s hash, and refuses what no token can hold', async () => {
    const before = Date.now();
    const started = await start({ name: 'orbit CLI on devbox', preset: 'read-only', hostname: 'devbox' });
    assert.match(started.deviceCode, /^[A-Za-z0-9_-]{43}$/);
    assert.match(started.userCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    assert.equal(started.interval, 3);
    assert.equal(started.expiresIn, 600);
    const row = await request(started.userCode);
    assert.equal(row.device_code_hash, sha256(started.deviceCode));
    assert.ok(!JSON.stringify(row).includes(started.deviceCode), 'the device code itself is never stored');
    assert.equal(row.status, 'PENDING');
    assert.equal(row.decided_by_id, null);
    assert.ok(Math.abs(row.expires_at.getTime() - (before + 600_000)) < 60_000, `ten minutes: ${row.expires_at.toISOString()}`);

    const count = async () => (await sql.query('SELECT count(*)::int AS n FROM pat_device_login')).rows[0].n;
    const rows = await count();
    const refused: Array<[string, Record<string, unknown>]> = [
      ['a scope that does not exist', { scopes: ['tasks:read', 'admin:write'] }],
      ['no scope', { scopes: [] }],
      ['a preset that does not exist', { preset: 'everything' }],
      ['both scopes and a preset', { scopes: ['tasks:read'], preset: 'read-only' }],
      ['neither scopes nor a preset', {}],
      ['a week', { preset: 'read-only', expiresInDays: 7 }],
      ['ninety as text', { preset: 'read-only', expiresInDays: '90' }],
      ['a blank name', { name: '   ', preset: 'read-only' }],
      ['a name of 101 characters', { name: 'x'.repeat(101), preset: 'read-only' }],
    ];
    for (const [what, body] of refused) {
      expect(await api('POST', '/access-tokens/device/start', undefined, { name: `refused: ${what}`, ...body }), 400, what);
    }
    assert.equal(await count(), rows, 'nothing refused was written');
  });

  await t.test('(2)(3) the page reads it signed in; approving issues nothing until the next poll issues the approver\'s token, once', async () => {
    const owner = await user('approver');
    const started = await start({ name: 'orbit CLI on devbox', preset: 'read-only', hostname: 'devbox' });
    assert.equal(await pollStatus(started.deviceCode), 'pending');

    const shown = expect(await page(owner.login, started.userCode), 200, 'the approval page');
    assert.deepEqual(shown, {
      userCode: started.userCode,
      name: 'orbit CLI on devbox',
      scopes: READ_SCOPES,
      expiresInDays: 90,
      hostname: 'devbox',
      status: 'PENDING',
      createdAt: shown.createdAt,
      expiresAt: shown.expiresAt,
      nameInUse: false,
    });
    assert.equal(await pollStatus(started.deviceCode), 'pending', 'reading the page decides nothing');

    assert.deepEqual(expect(await decide(owner.login, started.userCode, 'approve'), 201, 'approving'), {
      status: 'APPROVED', name: 'orbit CLI on devbox',
    });
    const approved = await request(started.userCode);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.decided_by_id, owner.id);
    assert.ok(approved.decided_at instanceof Date);
    assert.deepEqual(await tokensOf(owner), [], 'approving issues no token: the CLI collects it');
    // Approving again, as the same person, answers it as it stands.
    expect(await decide(owner.login, started.userCode, 'approve'), 201, 'approving again');

    const answer = expect(await poll(started.deviceCode), 200, 'the collecting poll');
    collected.push(answer.token);
    assert.equal(answer.status, 'approved');
    assert.match(answer.token, /^orbit_pat_[A-Za-z0-9_-]{43}$/);
    assert.equal(answer.name, 'orbit CLI on devbox');
    assert.deepEqual(answer.scopes, READ_SCOPES);
    assert.equal(answer.createdVia, 'CLI_DEVICE');
    assert.ok(nearly(answer.expiresAt, 90), `ninety days when none was asked for: ${answer.expiresAt}`);
    const [token, ...more] = await tokensOf(owner);
    assert.deepEqual(more, [], 'one token');
    assert.equal(token.id, toUuid(answer.id));
    assert.equal(token.token_hash, sha256(answer.token));
    assert.equal(token.created_via, 'CLI_DEVICE');
    assert.equal((await request(started.userCode)).status, 'DELIVERED');

    const self = expect(await api('GET', '/pat/self', answer.token), 200, 'the collected token reading itself');
    assert.equal(toUuid(self.userId), owner.id, 'the token acts as whoever approved it');
    assert.equal(self.email, owner.email);
    assert.equal(self.token.id, answer.id);
    assert.equal(self.token.name, 'orbit CLI on devbox');
    const listed = expect(await api('GET', '/access-tokens', owner.login), 200, 'the settings list').tokens;
    assert.deepEqual(listed.map((t: { name: string; createdVia: string }) => [t.name, t.createdVia]), [['orbit CLI on devbox', 'CLI_DEVICE']]);

    // Polling again — a CLI retrying an answer it lost — issues nothing more.
    assert.equal(await pollStatus(started.deviceCode), 'delivered');
    assert.equal((await tokensOf(owner)).length, 1);
    // Decided, it stays decided: the page shows it, and denying is refused.
    assert.equal(expect(await page(owner.login, started.userCode), 200, 'the page after').status, 'DELIVERED');
    assert.equal(expect(await decide(owner.login, started.userCode, 'deny'), 409, 'denying a collected request').code, 'PAT_DEVICE_LOGIN_DECIDED');

    // Listed scopes and a token that never expires, as asked.
    const forever = await start({ name: 'never expires', scopes: ['tasks:read', 'tasks:write'], expiresInDays: null });
    expect(await decide(owner.login, forever.userCode, 'approve'), 201, 'approving the never-expiring one');
    const issued = expect(await poll(forever.deviceCode), 200, 'collecting it');
    collected.push(issued.token);
    assert.deepEqual(issued.scopes, ['tasks:read', 'tasks:write']);
    assert.equal(issued.expiresAt, null);
    const thirty = await start({ name: 'thirty days', preset: 'read-write', expiresInDays: 30 });
    expect(await decide(owner.login, thirty.userCode, 'approve'), 201, 'approving the thirty-day one');
    const short = expect(await poll(thirty.deviceCode), 200, 'collecting it');
    collected.push(short.token);
    assert.deepEqual(short.scopes, [...PAT_SCOPES]);
    assert.ok(nearly(short.expiresAt, 30), `thirty days: ${short.expiresAt}`);
  });

  await t.test('(4) denied: the CLI is told, nothing is issued, and the decision stands', async () => {
    const owner = await user('denier');
    const started = await start({ name: 'denied one', preset: 'read-only', hostname: 'somewhere' });
    assert.deepEqual(expect(await decide(owner.login, started.userCode, 'deny'), 201, 'denying'), { status: 'DENIED', name: 'denied one' });
    const row = await request(started.userCode);
    assert.equal(row.status, 'DENIED');
    assert.equal(row.decided_by_id, owner.id);
    assert.equal(await pollStatus(started.deviceCode), 'denied');
    assert.equal(await pollStatus(started.deviceCode), 'denied', 'and stays so');
    const approving = expect(await decide(owner.login, started.userCode, 'approve'), 409, 'approving a denied request');
    assert.equal(approving.code, 'PAT_DEVICE_LOGIN_DECIDED');
    assert.match(approving.message, /already denied/);
    expect(await decide(owner.login, started.userCode, 'deny'), 201, 'denying again');
    // Someone else cannot overturn it either.
    const other = await user('latecomer');
    assert.equal(expect(await decide(other.login, started.userCode, 'approve'), 409, 'another account approving').code, 'PAT_DEVICE_LOGIN_DECIDED');
    assert.deepEqual(await tokensOf(owner), []);
    assert.deepEqual(await tokensOf(other), []);
    assert.equal(await pollStatus(started.deviceCode), 'denied');
  });

  await t.test('(5) expired: a request past its ten minutes polls expired and cannot be decided; an approval not collected in time issues nothing', async () => {
    const owner = await user('late');
    const lapse = (userCode: string) =>
      sql.query(`UPDATE pat_device_login SET expires_at = now() - interval '1 second' WHERE user_code = $1`, [userCode]);

    const pending = await start({ name: 'never decided', preset: 'read-only' });
    await lapse(pending.userCode);
    assert.equal(await pollStatus(pending.deviceCode), 'expired');
    for (const reply of [
      await page(owner.login, pending.userCode),
      await decide(owner.login, pending.userCode, 'approve'),
      await decide(owner.login, pending.userCode, 'deny'),
    ]) {
      assert.equal(reply.status, 404, reply.text);
      assert.match(reply.json.message, /not found or expired/);
    }
    assert.equal((await request(pending.userCode)).status, 'PENDING', 'nothing decided it');

    const uncollected = await start({ name: 'approved, never collected', preset: 'read-only' });
    expect(await decide(owner.login, uncollected.userCode, 'approve'), 201, 'approving');
    await lapse(uncollected.userCode);
    assert.equal(await pollStatus(uncollected.deviceCode), 'expired');
    assert.equal((await request(uncollected.userCode)).status, 'APPROVED');
    assert.deepEqual(await tokensOf(owner), [], 'an approval collected too late issues nothing');
  });

  await t.test('(6) a name one of the approver\'s live tokens holds: the page says so, and approving is refused and decides nothing', async () => {
    const owner = await user('taken');
    const first = await start({ name: 'orbit CLI on laptop', preset: 'read-only' });
    expect(await decide(owner.login, first.userCode, 'approve'), 201, 'approving the first');
    collected.push(expect(await poll(first.deviceCode), 200, 'collecting the first').token);

    const second = await start({ name: 'orbit CLI on laptop', preset: 'read-only' });
    assert.equal(expect(await page(owner.login, second.userCode), 200, 'the page').nameInUse, true);
    const refused = expect(await decide(owner.login, second.userCode, 'approve'), 409, 'approving a taken name');
    assert.equal(refused.code, 'PAT_NAME_IN_USE');
    assert.equal((await request(second.userCode)).status, 'PENDING');
    assert.equal(await pollStatus(second.deviceCode), 'pending');
    // Another account holds no such token: the name is theirs to take.
    const other = await user('other');
    assert.equal(expect(await page(other.login, second.userCode), 200, 'their page').nameInUse, false);
    assert.equal((await tokensOf(owner)).length, 1);
  });

  await t.test('(7) a token holding every scope is refused the page, the approval and the denial, TOKEN_MANAGEMENT, and decides nothing', async () => {
    const owner = await user('scripted');
    const everything = expect(
      await api('POST', '/access-tokens', owner.login, { name: 'every scope', scopes: [...PAT_SCOPES] }), 201, 'issuing a token');
    const started = await start({ name: 'asked of a token', preset: 'read-write' });
    for (const reply of [
      await page(everything.token, started.userCode),
      await decide(everything.token, started.userCode, 'approve'),
      await decide(everything.token, started.userCode, 'deny'),
    ]) {
      assert.equal(reply.status, 403, reply.text);
      assert.deepEqual(reply.json, {
        code: 'PAT_FORBIDDEN',
        reason: 'TOKEN_MANAGEMENT',
        requiredAction: 'OPEN_ORBIT',
        message: PAT_FORBIDDEN_REASONS.TOKEN_MANAGEMENT,
      });
    }
    assert.equal((await request(started.userCode)).status, 'PENDING');
    assert.equal(await pollStatus(started.deviceCode), 'pending');
    assert.equal((await tokensOf(owner)).length, 1, 'only the token the login issued');
    // Its holder signed in decides it.
    expect(await decide(owner.login, started.userCode, 'deny'), 201, 'denying signed in');
  });

  await t.test('(8) an unknown device code polls 404, an unknown user code is 404 to the page, and the page needs a sign-in', async () => {
    const owner = await user('lost');
    expect(await poll('not-a-device-code'), 404, 'an unknown device code');
    expect(await api('POST', '/access-tokens/device/poll', undefined, {}), 400, 'no device code');
    expect(await page(owner.login, 'AAAAA-AAAAA'), 404, 'an unknown user code');
    const started = await start({ name: 'signed out', preset: 'read-only' });
    expect(await page('', started.userCode), 401, 'the page signed out');
    expect(await api('POST', `/access-tokens/device/${started.userCode}/approve`), 401, 'approving signed out');
  });

  await t.test('(9) no request row holds a token, and no answer but the collecting polls carries one', async () => {
    assert.ok(collected.length >= 4, `collected ${collected.length}`);
    const rows = JSON.stringify((await sql.query('SELECT * FROM pat_device_login')).rows);
    for (const token of collected) {
      assert.ok(!rows.includes(token), 'a token is in pat_device_login');
      const carriers = answers.filter((answer) => answer.text.includes(token)).map((answer) => answer.request);
      assert.deepEqual(carriers, ['POST /access-tokens/device/poll'], `where ${token.slice(0, 14)}… appeared`);
    }
    assert.ok(!rows.includes('orbit_pat_'), 'no token prefix anywhere in pat_device_login');
  });
});
