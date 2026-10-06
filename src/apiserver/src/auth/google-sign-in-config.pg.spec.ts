/**
 * Google sign-in's configuration, and its default — off (docs/google-sign-in-design.md §4.1, §6,
 * §7.1, migration 0387) — against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty and the production apiserver, `build/main.js`. What it is held to:
 *
 *   (1) 0387 made the table it describes — its columns and which of them are NOT NULL, its
 *       defaults, the primary key, the two CHECKs, and no foreign key or trigger — runs again
 *       unchanged, and writes no row: a deployment that migrates has Google sign-in off;
 *   (2) not configured (no row): /auth/methods offers the password alone, /auth/google/start sends
 *       the Web and the native client back with GOOGLE_NOT_CONFIGURED and writes nothing, and the
 *       first-run bootstrap, the password login and the refresh answer as they did before Google —
 *       the same token pair, the same user, the same JWT claims;
 *   (3) the admin setting saves and reads back: the secret is stored encrypted, decrypting to what
 *       was sent; a save without one keeps it byte for byte; `updated_by_id` is the administrator;
 *       and a save is one INSERT … ON CONFLICT statement, as db-write-inventory.ts files it;
 *   (4) saved and switched off, or switched on without a client ID or a secret: the answers of
 *       (2), password doors included. Switched on with both, /auth/methods offers Google — sign-up
 *       only under OPEN — and /start stops answering GOOGLE_NOT_CONFIGURED; switched off again, (2);
 *   (5) only a signed-in ADMIN reaches the setting: nobody is 401, a MEMBER 403, and an access token
 *       holding every scope 403 PAT_FORBIDDEN ADMIN; none of them changes it (the token's refused PUT
 *       is recorded as `pat.request.denied`, as every refused write by a token is: pat-request-audit.ts);
 *   (6) no answer the apiserver gave in this run, nor its log, carries the secret or what is stored
 *       for it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/google-sign-in-config.pg.spec.ts
 *
 * It needs the fresh database that script makes: the first-run bootstrap is only open while no user
 * exists, and (2) checks it.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { decryptSecret } from '../providers/provider-crypto';
import { call, startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';
import { PAT_SCOPES, PatService } from './pat.service';
import { SignInProvidersService } from './sign-in-providers.service';

const URL = process.env.COORDINATOR_PG_URL;
// The apiserver child and this process encrypt and decrypt with the same key.
process.env.PROVIDER_SECRET_KEY = `google-sign-in-config-${randomUUID()}`;
const ORIGIN = 'https://orbit.example.test';
const REDIRECT_URI = `${ORIGIN}/api/auth/google/callback`;
const RUN = randomUUID().slice(0, 8);
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0387_sign_in_provider/migration.sql'),
  'utf8',
);
const CLIENT_ID = `1234-${RUN}.apps.googleusercontent.com`;
const SECRET = `GOCSPX-${RUN}-not-a-real-secret`;
const OFF = { password: true, google: false, googleSignup: false };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The claims of a JWT, unverified: what the token carries is the shape under test, not its signature. */
function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

test('Google sign-in configuration: off until an administrator turns it on, the password doors unchanged either way, the secret stored encrypted and never answered', {
  skip: !URL, concurrency: 1, timeout: 300_000,
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

  /** Every answer the apiserver gave in this run, for (6). */
  const answers: Reply[] = [];
  const ask = async (method: string, route: string, bearer?: string, body?: unknown) => {
    const reply = await call(server!, method, route, bearer, body);
    answers.push(reply);
    return reply;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providerRows = async (): Promise<any[]> => (await sql.query('SELECT * FROM sign_in_provider ORDER BY provider')).rows;
  /** Every value `client_secret_enc` held in this run, for (6). */
  const stored = new Set<string>();

  await t.test('(1) 0387 made the table it describes, writes no row, and runs again', async () => {
    const applied = await sql.query(
      `SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0387_sign_in_provider'`,
    );
    assert.deepEqual(applied.rows, [{ done: true }]);
    const columns = await sql.query(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'sign_in_provider' ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      columns.rows.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`
        + (c.column_default === null ? '' : ` DEFAULT ${c.column_default}`)),
      [
        'provider text NOT NULL',
        'enabled bool NOT NULL DEFAULT false',
        'client_id text NOT NULL',
        'client_secret_enc text NOT NULL',
        "signup_policy text NOT NULL DEFAULT 'EXISTING_ACCOUNTS'::text",
        'updated_by_id uuid NULL',
        'updated_at timestamptz NOT NULL',
      ],
    );
    const constraints = await sql.query(
      `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'sign_in_provider'::regclass ORDER BY conname`,
    );
    assert.deepEqual(constraints.rows, [
      { conname: 'sign_in_provider_pkey', contype: 'p' },
      { conname: 'sign_in_provider_provider_chk', contype: 'c' },
      { conname: 'sign_in_provider_signup_policy_chk', contype: 'c' },
    ], 'the primary key and the two CHECKs, and no foreign key');
    const triggers = await sql.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'sign_in_provider'::regclass AND NOT tgisinternal`,
    );
    assert.deepEqual(triggers.rows, []);
    assert.deepEqual(await providerRows(), [], 'a migrated deployment has no sign-in provider: Google is off');

    // The CHECKs refuse what they exist to refuse — inside a transaction rolled back, so nothing stays.
    const refusal = async (provider: string, policy: string) => {
      await sql.query('BEGIN');
      try {
        await sql.query(
          `INSERT INTO sign_in_provider (provider, client_id, client_secret_enc, signup_policy, updated_at)
           VALUES ($1, '', '', $2, now())`,
          [provider, policy],
        );
        return 'ACCEPTED';
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        return `${e.code} ${e.constraint}`;
      } finally {
        await sql.query('ROLLBACK');
      }
    };
    assert.equal(await refusal('github', 'EXISTING_ACCOUNTS'), '23514 sign_in_provider_provider_chk');
    assert.equal(await refusal('google', 'open'), '23514 sign_in_provider_signup_policy_chk');
    assert.equal(await refusal('google', 'OPEN'), 'ACCEPTED');
    assert.deepEqual(await providerRows(), []);

    await sql.query(MIGRATION);
    const again = await sql.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'sign_in_provider'::regclass ORDER BY conname`,
    );
    assert.deepEqual(again.rows.map((c) => c.conname), constraints.rows.map((c) => c.conname));
    assert.deepEqual(await providerRows(), []);
  });

  const jwtSecret = `google-sign-in-config-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, { PROVIDER_SECRET_KEY: process.env.PROVIDER_SECRET_KEY, PUBLIC_ORIGIN: ORIGIN });

  const admin = { id: '', email: `admin-${RUN}@google-sign-in-config.invalid`, name: 'First Admin', password: `pw-${RUN}-admin`, accessToken: '' };

  /** A login answer is the pair and the user, exactly as before Google, and its access token the same claims. */
  const assertSession = (reply: Reply, what: string) => {
    assert.equal(reply.status, 201, `${what} answered ${reply.status}: ${reply.text}`);
    assert.deepEqual(Object.keys(reply.json).sort(), ['accessToken', 'refreshToken', 'user'], what);
    // Ids leave as public ids, with the `publicId` twin every response body gets (common/public-id-body.ts).
    assert.deepEqual(Object.keys(reply.json.user).sort(), ['email', 'id', 'name', 'publicId'], what);
    assert.equal(toUuid(reply.json.user.id), admin.id, what);
    assert.equal(reply.json.user.publicId, uuidToBase62(admin.id), what);
    assert.equal(reply.json.user.email, admin.email, what);
    assert.equal(reply.json.user.name, admin.name, what);
    const claims = claimsOf(reply.json.accessToken);
    assert.deepEqual(Object.keys(claims).sort(), ['email', 'exp', 'iat', 'sub'], what);
    assert.equal(claims.sub, admin.id, what);
    assert.equal(claims.email, admin.email, what);
    assert.match(reply.json.refreshToken, /^[A-Za-z0-9_-]{43}$/, what);
  };

  /**
   * The doors while Google sign-in is off: the methods, a start from each client, and the password
   * login and refresh — which answer as they did before Google whatever the setting says.
   */
  const assertOff = async (state: string) => {
    const before = await providerRows();
    const methods = await ask('GET', '/api/auth/methods');
    assert.equal(methods.status, 200, `${state}: ${methods.text}`);
    assert.deepEqual(methods.json, OFF, state);

    const web = await ask('GET', `/api/auth/google/start?client=web&code_challenge=${'a'.repeat(43)}`);
    assert.equal(web.status, 302, `${state}: web /start answered ${web.status}: ${web.text}`);
    assert.equal(web.headers.location, '/login?google_error=GOOGLE_NOT_CONFIGURED', state);
    assert.equal(web.headers['set-cookie'], undefined, `${state}: a refused start binds no flow to the browser`);
    const native = await ask('GET', `/api/auth/google/start?client=native&code_challenge=${'a'.repeat(43)}&client_state=app-${RUN}`);
    assert.equal(native.status, 302, `${state}: native /start answered ${native.status}: ${native.text}`);
    assert.equal(native.headers.location, `orbit://auth/google?error=GOOGLE_NOT_CONFIGURED&state=app-${RUN}`, state);
    const noClient = await ask('GET', '/api/auth/google/start');
    assert.equal(noClient.status, 400, `${state}: ${noClient.text}`);
    assert.deepEqual(await providerRows(), before, `${state}: reading the methods or refusing a start writes nothing`);

    const login = await ask('POST', '/api/auth/login', undefined, { email: admin.email, password: admin.password });
    assertSession(login, `${state}: the password login`);
    const wrong = await ask('POST', '/api/auth/login', undefined, { email: admin.email, password: 'not-the-password' });
    assert.equal(wrong.status, 401, `${state}: ${wrong.text}`);
    assert.equal(wrong.json?.message, 'invalid credentials', state);

    const refreshed = await ask('POST', '/api/auth/refresh', undefined, { refreshToken: login.json.refreshToken });
    assertSession(refreshed, `${state}: the refresh`);
    assert.notEqual(refreshed.json.refreshToken, login.json.refreshToken, `${state}: the refresh rotates`);
    const presented = await sql.query('SELECT revoked_at IS NOT NULL AS revoked FROM refresh_token WHERE token_hash = $1', [sha256(login.json.refreshToken)]);
    assert.deepEqual(presented.rows, [{ revoked: true }], `${state}: the presented refresh token is consumed`);
    // Replaying a consumed refresh token is theft: refused, and the family it rotated into with it.
    const replay = await ask('POST', '/api/auth/refresh', undefined, { refreshToken: login.json.refreshToken });
    assert.equal(replay.status, 401, `${state}: ${replay.text}`);
    assert.equal(replay.json?.message, 'refresh token reuse detected', state);
    const family = await ask('POST', '/api/auth/refresh', undefined, { refreshToken: refreshed.json.refreshToken });
    assert.equal(family.status, 401, `${state}: ${family.text}`);
  };

  await t.test('(2) not configured: the first-run bootstrap, the password alone in /auth/methods, /start refused back to each client, login and refresh as before', async () => {
    const users = await sql.query('SELECT count(*)::int AS n FROM "user"');
    assert.deepEqual(users.rows, [{ n: 0 }], 'the bootstrap is only open on the fresh database run-pg-spec.sh makes');
    const first = await ask('POST', '/api/auth/bootstrap', undefined, { email: admin.email, name: admin.name, password: admin.password });
    assert.equal(first.status, 201, first.text);
    admin.id = toUuid(first.json.user.id);
    assertSession(first, 'the bootstrap');
    admin.accessToken = first.json.accessToken;
    const role = await sql.query('SELECT role FROM "user" WHERE id = $1', [admin.id]);
    assert.deepEqual(role.rows, [{ role: 'ADMIN' }], 'the first user is the deployment\'s ADMIN');
    const second = await ask('POST', '/api/auth/bootstrap', undefined, { email: `second-${RUN}@google-sign-in-config.invalid`, password: 'pw-second' });
    assert.equal(second.status, 409, second.text);

    await assertOff('not configured');
    assert.deepEqual(await providerRows(), []);
  });

  await t.test('(3) the admin setting saves and reads back, the secret encrypted, a save without one keeping it, one statement per save', async () => {
    const empty = await ask('GET', '/api/admin/sign-in/google', admin.accessToken);
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(empty.json, { enabled: false, clientId: '', hasSecret: false, signupPolicy: 'EXISTING_ACCOUNTS', redirectUri: REDIRECT_URI });

    const view = { enabled: false, clientId: CLIENT_ID, hasSecret: true, signupPolicy: 'OPEN', redirectUri: REDIRECT_URI };
    const saved = await ask('PUT', '/api/admin/sign-in/google', admin.accessToken,
      { enabled: false, clientId: CLIENT_ID, clientSecret: SECRET, signupPolicy: 'OPEN' });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json, view);
    const [row] = await providerRows();
    stored.add(row.client_secret_enc);
    assert.equal(row.provider, 'google');
    assert.equal(row.enabled, false);
    assert.equal(row.client_id, CLIENT_ID);
    assert.equal(row.signup_policy, 'OPEN');
    assert.equal(row.updated_by_id, admin.id);
    assert.notEqual(row.client_secret_enc, SECRET);
    assert.ok(!row.client_secret_enc.includes(SECRET), 'what is stored does not contain the secret');
    assert.equal(decryptSecret(row.client_secret_enc), SECRET, 'what is stored decrypts to the secret');
    assert.deepEqual((await ask('GET', '/api/admin/sign-in/google', admin.accessToken)).json, view);

    const kept = await ask('PUT', '/api/admin/sign-in/google', admin.accessToken,
      { enabled: false, clientId: CLIENT_ID, signupPolicy: 'OPEN' });
    assert.equal(kept.status, 200, kept.text);
    assert.deepEqual(kept.json, view);
    const [after] = await providerRows();
    assert.equal(after.client_secret_enc, row.client_secret_enc, 'a save without a secret keeps the stored one byte for byte');
    assert.ok(after.updated_at >= row.updated_at);

    // The save as the inventory files it: one statement, an upsert on the primary key.
    const logged = new PrismaClient({ adapter: new PrismaPg(url), log: [{ emit: 'event', level: 'query' }] });
    try {
      const queries: string[] = [];
      logged.$on('query', (event) => queries.push(event.query));
      const service = new SignInProvidersService(logged as unknown as PrismaService);
      await service.updateGoogle(admin.id, { enabled: false, clientId: CLIENT_ID, signupPolicy: 'OPEN' });
      assert.equal(queries.length, 1, `one statement per save, not ${queries.length}:\n${queries.join('\n')}`);
      assert.match(queries[0], /^INSERT INTO "\w+"\."sign_in_provider" .* ON CONFLICT \("provider"\) DO UPDATE SET /s);
    } finally {
      await logged.$disconnect();
    }
    assert.equal((await providerRows())[0].client_secret_enc, row.client_secret_enc);
  });

  await t.test('(4) switched off, or on without a client ID or a secret, it answers as not configured; on with both it offers Google; off again, not', async () => {
    await assertOff('saved and switched off, sign-up OPEN');

    const noClientId = await ask('PUT', '/api/admin/sign-in/google', admin.accessToken,
      { enabled: true, clientId: '  ', signupPolicy: 'OPEN' });
    assert.equal(noClientId.status, 200, noClientId.text);
    assert.deepEqual(noClientId.json, { enabled: true, clientId: '', hasSecret: true, signupPolicy: 'OPEN', redirectUri: REDIRECT_URI });
    await assertOff('switched on without a client ID');

    // No door saves an empty secret (a save without one keeps the old), so the row is made so here.
    const restored = await ask('PUT', '/api/admin/sign-in/google', admin.accessToken,
      { enabled: true, clientId: CLIENT_ID, signupPolicy: 'OPEN' });
    assert.equal(restored.status, 200, restored.text);
    const [withSecret] = await providerRows();
    await sql.query(`UPDATE sign_in_provider SET client_secret_enc = '' WHERE provider = 'google'`);
    assert.equal((await ask('GET', '/api/admin/sign-in/google', admin.accessToken)).json.hasSecret, false);
    await assertOff('switched on without a secret');

    // On, with both: Google is offered, sign-up only under OPEN, and /start is past the refusal.
    const on = await ask('PUT', '/api/admin/sign-in/google', admin.accessToken,
      { enabled: true, clientId: CLIENT_ID, clientSecret: SECRET, signupPolicy: 'EXISTING_ACCOUNTS' });
    assert.equal(on.status, 200, on.text);
    const [onRow] = await providerRows();
    stored.add(onRow.client_secret_enc);
    assert.notEqual(onRow.client_secret_enc, withSecret.client_secret_enc, 'a fresh IV each time the secret is saved');
    assert.equal(decryptSecret(onRow.client_secret_enc), SECRET);
    assert.deepEqual((await ask('GET', '/api/auth/methods')).json, { password: true, google: true, googleSignup: false });
    await ask('PUT', '/api/admin/sign-in/google', admin.accessToken, { enabled: true, clientId: CLIENT_ID, signupPolicy: 'OPEN' });
    assert.deepEqual((await ask('GET', '/api/auth/methods')).json, { password: true, google: true, googleSignup: true });
    const started = await ask('GET', `/api/auth/google/start?client=web&code_challenge=${'a'.repeat(43)}`);
    assert.notEqual(started.headers.location, '/login?google_error=GOOGLE_NOT_CONFIGURED', started.text);

    const off = await ask('PUT', '/api/admin/sign-in/google', admin.accessToken,
      { enabled: false, clientId: CLIENT_ID, signupPolicy: 'OPEN' });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json, { enabled: false, clientId: CLIENT_ID, hasSecret: true, signupPolicy: 'OPEN', redirectUri: REDIRECT_URI });
    await assertOff('switched off again');
  });

  await t.test('(5) only a signed-in ADMIN reaches the setting; nobody, a MEMBER and an access token change nothing in it', async () => {
    const memberId = randomUUID();
    const memberEmail = `member-${RUN}@google-sign-in-config.invalid`;
    await db.user.create({ data: { id: memberId, email: memberEmail, name: 'Member', passwordHash: 'x' } });
    const member = await new JwtService({ secret: jwtSecret }).signAsync({ sub: memberId, email: memberEmail });
    const pats = new PatService(db as unknown as PrismaService);
    const token = (await pats.issue(admin.id, { name: `every scope ${RUN}`, scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB' })).token;

    const before = await providerRows();
    const body = { enabled: true, clientId: 'someone-else', clientSecret: 'not-theirs-to-set', signupPolicy: 'OPEN' };
    for (const [who, bearer, status] of [['nobody', undefined, 401], ['a MEMBER', member, 403], ["the ADMIN's access token", token, 403]] as const) {
      const read = await ask('GET', '/api/admin/sign-in/google', bearer);
      assert.equal(read.status, status, `GET by ${who}: ${read.text}`);
      const write = await ask('PUT', '/api/admin/sign-in/google', bearer, body);
      assert.equal(write.status, status, `PUT by ${who}: ${write.text}`);
      if (bearer === token) {
        for (const reply of [read, write]) {
          assert.equal(reply.json?.code, 'PAT_FORBIDDEN', reply.text);
          assert.equal(reply.json?.reason, 'ADMIN', reply.text);
        }
      }
    }
    assert.deepEqual(await providerRows(), before, 'none of them changed the setting');
  });

  await t.test('(6) no answer in this run, nor the apiserver\'s log, carries the secret or what is stored for it', async () => {
    assert.ok(answers.length > 40, `only ${answers.length} answers were recorded`);
    assert.ok(stored.size >= 2);
    const leaks = answers.filter((reply) =>
      [SECRET, ...stored].some((secret) => reply.text.includes(secret))
      || /clientSecret|client_secret/.test(reply.text));
    assert.deepEqual(leaks.map((reply) => reply.text), []);
    const log = server!.output();
    assert.ok(!log.includes(SECRET), 'the apiserver logged the secret');
    for (const secret of stored) assert.ok(!log.includes(secret), 'the apiserver logged what is stored for the secret');
  });
});
