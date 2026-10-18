/**
 * Which Orbit account a Google sign-in signs in as (docs/google-sign-in-design.md §5.2), and accounts
 * without a password (§5.1, §5.4, migration 0392), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty: the controllers, the global pipe, interceptors and
 * filters main.ts installs, and the real AuthService, PatService, SignInProvidersService,
 * GoogleLoginService and AdminController over that database. Only Google is not real: the in-process
 * fake (test-support/fake-google.ts) answers its token endpoint, and nothing reaches the network.
 * What it is held to:
 *
 *   (1) 0392 made `user.password_hash` nullable and nothing else of `user` changed — each column's
 *       NULL or NOT NULL, the email's unique index still on the address as written, no index on
 *       lower(email) — and it runs again without touching a password;
 *   (2) §5.2's table (test-support/google-account-resolution-cases.ts), every row, ACCOUNT_DISABLED
 *       (§5.5) included, under both sign-up policies, end to end — /start, Google, the callback and
 *       the exchange — read back from the tables: who is signed in, which identity is linked, which
 *       account is opened, the Activity row (credential_kind LOGIN) — and a refusal writes nothing;
 *   (3) first sign-ins of one Google account at once, made to meet at their INSERT by a lock this spec
 *       holds: under OPEN one account is opened and one identity linked, and to an account its
 *       authoritative email finds one identity is linked — and every one of them is signed in, as
 *       that account;
 *   (4) an account without a password: the password login answers it exactly as a wrong password,
 *       and the password change is a 400 PASSWORD_NOT_SET;
 *   (5) POST /admin/users with `passwordless`: an account whose password_hash is NULL and no password
 *       answered; refused with `force` — the existing password the same byte for byte — and with a
 *       password; and the account it makes signs in with Google.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/google-account-resolution.pg.spec.ts
 *
 * It needs the fresh database that script makes: row 2 is a deployment with no account, and the
 * administrator is made after it by the first-run bootstrap.
 */
process.env.PROVIDER_SECRET_KEY = `google-account-resolution-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { generateToken, hashPassword } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { FakeGoogle, type FakeGoogleAccount } from '../test-support/fake-google';
import { RESOLUTION_CASES, tagged, type ResolutionCase } from '../test-support/google-account-resolution-cases';
import { AdminController } from '../users/admin.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleLoginService, IDENTITY_LINKED_ACTIVITY } from './google-login.service';
import { GoogleOAuthClient, s256 } from './google-oauth.client';
import { PatService } from './pat.service';
import { SIGNUP_POLICIES, SignInProvidersService, type SignupPolicy } from './sign-in-providers.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CLIENT_ID = `1234-${RUN}.apps.googleusercontent.com`;
const CLIENT_SECRET = `GOCSPX-${RUN}-resolution`;
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0392_user_password_hash_nullable/migration.sql'),
  'utf8',
);
/** The password every account a case starts with has: scrypt once, not per account. */
const SEEDED_PASSWORD = `pw-${RUN}-seeded`;
const SEEDED_HASH = hashPassword(SEEDED_PASSWORD);
/** How many first sign-ins of one Google account (3) races. */
const RACERS = 6;

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  location: string | null;
  setCookie: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

test('Google account resolution on PostgreSQL: 0392, §5.2 row by row under both policies, first sign-ins racing, accounts without a password', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db = prismaClientFor(url);
  const google = new FakeGoogle(CLIENT_ID, CLIENT_SECRET);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  await t.test('(1) 0392 made user.password_hash nullable and changed nothing else of `user`; it runs again and touches no password', async () => {
    assert.deepEqual(
      await rows(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0392_user_password_hash_nullable'`),
      [{ done: true }],
    );
    const columns = async () => (await rows(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'user' ORDER BY ordinal_position`,
    )).map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`
      + (c.column_default === null ? '' : ` DEFAULT ${c.column_default}`));
    const shape = [
      'id uuid NOT NULL',
      'email text NOT NULL',
      'name text NOT NULL',
      'password_hash text NULL',
      'created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP',
      "preferences jsonb NOT NULL DEFAULT '{}'::jsonb",
      "role text NOT NULL DEFAULT 'MEMBER'::text",
      'claude_oauth_token_enc text NULL',
      'claude_oauth_token_set_at timestamp NULL',
      // 0396, after it (§5.5): when an administrator disabled the account.
      'disabled_at timestamp NULL',
    ];
    assert.deepEqual(await columns(), shape);
    const indexes = async () => (await rows(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'user' ORDER BY indexname`,
    )).map((index) => `${index.indexname} ${/UNIQUE/.test(index.indexdef) ? 'UNIQUE ' : ''}${/\((.*)\)/.exec(index.indexdef)![1]}`);
    assert.deepEqual(await indexes(), ['user_email_key UNIQUE email', 'user_pkey UNIQUE id'], 'the email is unique as written, and nothing indexes lower(email)');
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM "user"'), [{ n: 0 }], 'no row is written');

    // Run again over an account that has a password, and one that does not.
    const kept = randomUUID();
    const none = randomUUID();
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'Kept', $3), ($4, $5, 'None', NULL)`,
      [kept, `kept-${RUN}@migration.invalid`, SEEDED_HASH, none, `none-${RUN}@migration.invalid`]);
    await sql.query(MIGRATION);
    assert.deepEqual(await columns(), shape, 'a second run changes nothing');
    assert.deepEqual(await indexes(), ['user_email_key UNIQUE email', 'user_pkey UNIQUE id']);
    assert.deepEqual(
      await rows('SELECT id, password_hash FROM "user" ORDER BY name'),
      [{ id: kept, password_hash: SEEDED_HASH }, { id: none, password_hash: null }],
      'no password is touched',
    );
    // The email stays unique as written: the same address in other letter cases is another row.
    await sql.query(`INSERT INTO "user" (id, email, name) VALUES ($1, $2, 'Upper')`, [randomUUID(), `KEPT-${RUN}@Migration.invalid`]);
    await assert.rejects(
      sql.query(`INSERT INTO "user" (id, email, name) VALUES ($1, $2, 'Twice')`, [randomUUID(), `kept-${RUN}@migration.invalid`]),
      { constraint: 'user_email_key' },
    );
    await sql.query('DELETE FROM "user"');
  });

  // The apiserver: as main.ts sets it up, over this database, with Google faked.
  @Module({
    controllers: [AuthController, GoogleAuthController, AdminController],
    providers: [
      AuthService,
      PatService,
      SignInProvidersService,
      GoogleLoginService,
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(google.fetch) },
      { provide: JwtService, useValue: new JwtService({ secret: `resolution-${RUN}`, signOptions: { expiresIn: '7d' } }) },
      { provide: PrismaService, useValue: db },
    ],
  })
  class GoogleAccountResolutionHarness {}
  app = await NestFactory.create(GoogleAccountResolutionHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const signInProviders = new SignInProvidersService(db as unknown as PrismaService);

  let addresses = 0;
  const call = async (method: string, route: string, options: { body?: unknown; cookie?: string; bearer?: string } = {}): Promise<Answer> => {
    const response = await fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
        'x-real-ip': `198.51.100.${(addresses += 1) % 250}`,
        ...(options.cookie ? { cookie: `orbit_oauth_flow=${options.cookie}` } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, text, json, location: response.headers.get('location'), setCookie: response.headers.get('set-cookie') };
  };
  /** A sign-in up to its ticket: /start from a fresh browser, `account` at Google's page, the callback with the cookie /start set. */
  const ticketFor = async (account: FakeGoogleAccount) => {
    const verifier = generateToken(32);
    const started = await call('GET', `/api/auth/google/start?client=web&code_challenge=${s256(verifier)}`);
    assert.equal(started.status, 302, started.text);
    const cookie = /^orbit_oauth_flow=([A-Za-z0-9_-]{43});/.exec(started.setCookie ?? '')![1];
    const back = await call('GET', google.authorize(started.location!, account), { cookie });
    const ticket = /^\/login\?google_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location ?? '')?.[1];
    assert.ok(ticket, `the callback hands the Web a ticket: ${back.location}`);
    return { ticket, verifier };
  };
  const exchange = ({ ticket, verifier }: { ticket: string; verifier: string }) =>
    call('POST', '/api/auth/google/exchange', { body: { ticket, codeVerifier: verifier } });
  const signInWithGoogle = async (account: FakeGoogleAccount) => exchange(await ticketFor(account));
  /** The Google setting, on, with this sign-up policy. */
  const setPolicy = (policy: SignupPolicy, adminId: string = randomUUID()) =>
    signInProviders.updateGoogle(adminId, { enabled: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signupPolicy: policy });
  /** Everything a refusal must leave as it was. */
  const everything = async () => ({
    users: await rows('SELECT * FROM "user" ORDER BY id'),
    identities: await rows('SELECT * FROM user_identity ORDER BY id'),
    activity: await rows('SELECT * FROM activity ORDER BY id'),
    refreshTokens: await rows('SELECT count(*)::int AS n FROM refresh_token'),
  });
  const activitySince = async (before: Row[]) => (await rows(
    `SELECT actor_id, type, payload, credential_kind, credential_id FROM activity WHERE NOT (id = ANY($1::uuid[])) ORDER BY id`,
    [before.map((row) => row.id)],
  ));

  const admin = { id: '', token: '', email: `admin-${RUN}@resolution.invalid`, password: `pw-${RUN}-admin` };

  /** One row of §5.2 under one policy, end to end, read back from the tables. */
  const runCase = async (policy: SignupPolicy, entry: ResolutionCase, index: number) => {
    const tag = `${RUN}-c${index}-${policy.toLowerCase()}`;
    await setPolicy(policy, admin.id || undefined);
    const me: FakeGoogleAccount = {
      sub: `me-${tag}`,
      email: tagged(entry.signingIn.email, tag),
      ...(entry.signingIn.hd === undefined ? {} : { hd: entry.signingIn.hd }),
      ...(entry.signingIn.name === undefined ? {} : { name: entry.signingIn.name }),
    };
    const accounts: Array<{ id: string; email: string }> = [];
    for (const account of entry.accounts) {
      const seeded = { id: randomUUID(), email: tagged(account.email, tag) };
      await sql.query(`INSERT INTO "user" (id, email, name, password_hash, disabled_at) VALUES ($1, $2, 'Seeded', $3, $4)`,
        [seeded.id, seeded.email, SEEDED_HASH, account.disabled ? new Date() : null]);
      if (account.linkedTo) {
        await sql.query(
          `INSERT INTO user_identity (id, user_id, provider, subject, email) VALUES (gen_random_uuid(), $1, 'google', $2, $3)`,
          [seeded.id, account.linkedTo === 'ME' ? me.sub : `other-${tag}`, account.linkedTo === 'ME' ? `old.${tag}@gmail.com` : me.email],
        );
      }
      accounts.push(seeded);
    }
    const before = await everything();
    const answer = await signInWithGoogle(me);
    const outcome = entry.expect[policy];

    if ('refused' in outcome) {
      assert.equal(answer.status, 403, answer.text);
      assert.equal(answer.json?.code, outcome.refused);
      assert.ok(!('accessToken' in (answer.json ?? {})));
      assert.deepEqual(await everything(), before, 'nothing was written: no account, identity, record or session');
      return;
    }

    assert.equal(answer.status, 201, answer.text);
    const signedIn = toUuid(answer.json.user.id);
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM refresh_token WHERE user_id = $1', [signedIn]), [{ n: 1 }]);
    const [identity, ...more] = await rows('SELECT user_id, email, hosted_domain, last_sign_in_at FROM user_identity WHERE subject = $1', [me.sub]);
    assert.equal(more.length, 0);
    assert.equal(identity.user_id, signedIn, 'the Google account is linked to the account signed in');
    assert.equal(identity.email, me.email);
    assert.equal(identity.hosted_domain, me.hd ?? null);
    assert.ok(identity.last_sign_in_at instanceof Date);

    if ('signsInAs' in outcome) {
      const account = accounts[outcome.signsInAs];
      assert.equal(signedIn, account.id);
      assert.equal(answer.json.user.email, account.email, "the account's own email, not Google's");
      assert.deepEqual(await rows('SELECT * FROM "user" ORDER BY id'), before.users, 'no account opened, and the account as it was');
      const recorded = await activitySince(before.activity);
      if (outcome.links) {
        assert.equal((await rows('SELECT count(*)::int AS n FROM user_identity')).at(0).n, before.identities.length + 1);
        assert.deepEqual(recorded, [{
          actor_id: account.id,
          type: IDENTITY_LINKED_ACTIVITY,
          payload: { provider: 'google', email: me.email, method: 'AUTO' },
          credential_kind: 'LOGIN',
          credential_id: null,
        }]);
      } else {
        assert.equal((await rows('SELECT count(*)::int AS n FROM user_identity')).at(0).n, before.identities.length);
        assert.deepEqual(recorded, [], 'a linked account signing in records no link');
      }
      return;
    }

    const opened = await rows('SELECT id, email, name, role, password_hash FROM "user" WHERE NOT (id = ANY($1::uuid[]))', [before.users.map((user) => user.id)]);
    assert.deepEqual(opened, [{ id: signedIn, email: me.email, name: tagged(outcome.opens.name, tag), role: 'MEMBER', password_hash: null }],
      'one account opened: a MEMBER without a password, named as Google names the person');
    assert.deepEqual(await activitySince(before.activity), [{
      actor_id: signedIn,
      type: IDENTITY_LINKED_ACTIVITY,
      payload: { provider: 'google', email: me.email, method: 'SIGNUP' },
      credential_kind: 'LOGIN',
      credential_id: null,
    }]);
  };

  await t.test('(2) §5.2 row by row, ACCOUNT_DISABLED included, under EXISTING_ACCOUNTS and under OPEN, end to end', async (t) => {
    // Row 2 first, while the deployment has no account; then the administrator, and every other row.
    const ordered = [...RESOLUTION_CASES.entries()].sort(([, a], [, b]) => Number(a.accounts.length > 0) - Number(b.accounts.length > 0));
    for (const [index, entry] of ordered) {
      if (entry.accounts.length > 0 && admin.id === '') {
        assert.deepEqual(await rows('SELECT count(*)::int AS n FROM "user"'), [{ n: 0 }]);
        const bootstrap = await call('POST', '/api/auth/bootstrap', { body: { email: admin.email, name: 'First Admin', password: admin.password } });
        assert.equal(bootstrap.status, 201, bootstrap.text);
        admin.id = toUuid(bootstrap.json.user.id);
        admin.token = bootstrap.json.accessToken;
      }
      for (const policy of SIGNUP_POLICIES) {
        await t.test(`${policy} · row ${entry.row}: ${entry.what}`, () => runCase(policy, entry, index));
      }
    }
  });

  await t.test('(3) first sign-ins of one Google account at once, made to meet at their INSERT: one account, one identity, one record — and every one signed in, as it', async (t) => {
    /**
     * `count` exchanges of one Google account, released together: this spec holds `table` in SHARE
     * mode, which every read takes past and every INSERT waits on, until each exchange is waiting at
     * its INSERT. Then the first to insert wins, and the unique keys fail the others.
     */
    const race = async (account: FakeGoogleAccount, table: string) => {
      const tickets = [];
      for (let i = 0; i < RACERS; i += 1) tickets.push(await ticketFor(account));
      const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`LOCK TABLE "${table}" IN SHARE MODE`);
        const answers = Promise.all(tickets.map(exchange));
        const waiting = async () => (await rows(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'relation' AND relation = $1::regclass AND NOT granted`,
          [`"${table}"`],
        ))[0].n;
        const deadline = Date.now() + 20_000;
        while ((await waiting()) < RACERS) {
          assert.ok(Date.now() < deadline, `only ${await waiting()} of ${RACERS} exchanges reached their INSERT`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await holder.query('COMMIT');
        return await answers;
      } finally {
        await holder.end().catch(() => undefined);
      }
    };

    await t.test('OPEN: a Google account no account has the email of — one account opened', async () => {
      await setPolicy('OPEN', admin.id);
      const racer: FakeGoogleAccount = { sub: `racer-${RUN}`, email: `racer-${RUN}@gmail.com`, name: 'Racer' };
      const answers = await race(racer, 'user');
      assert.deepEqual(answers.map((answer) => answer.status), Array(RACERS).fill(201), answers.map((answer) => answer.text).join('\n'));
      const signedIn = new Set(answers.map((answer) => toUuid(answer.json.user.id)));
      assert.equal(signedIn.size, 1, 'every one signed in as the same account');
      const [id] = signedIn;
      assert.deepEqual(await rows('SELECT id, role, password_hash FROM "user" WHERE lower(email) = lower($1)', [racer.email]), [{ id, role: 'MEMBER', password_hash: null }], 'one account');
      assert.deepEqual(await rows('SELECT user_id FROM user_identity WHERE subject = $1', [racer.sub]), [{ user_id: id }], 'one identity');
      assert.deepEqual(
        await rows(`SELECT actor_id, payload->>'method' AS method FROM activity WHERE type = $1 AND payload->>'email' = $2`, [IDENTITY_LINKED_ACTIVITY, racer.email]),
        [{ actor_id: id, method: 'SIGNUP' }],
        'one record',
      );
      assert.deepEqual(await rows('SELECT count(*)::int AS n FROM refresh_token WHERE user_id = $1', [id]), [{ n: RACERS }], 'a session each');
    });

    await t.test('an account its authoritative email finds — one identity linked', async () => {
      await setPolicy('EXISTING_ACCOUNTS', admin.id);
      const account = randomUUID();
      const linker: FakeGoogleAccount = { sub: `linker-${RUN}`, email: `linker-${RUN}@gmail.com` };
      await sql.query(`INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'Linker', $3)`, [account, linker.email, SEEDED_HASH]);
      const answers = await race(linker, 'user_identity');
      assert.deepEqual(answers.map((answer) => answer.status), Array(RACERS).fill(201), answers.map((answer) => answer.text).join('\n'));
      assert.deepEqual([...new Set(answers.map((answer) => toUuid(answer.json.user.id)))], [account]);
      assert.deepEqual(await rows('SELECT user_id FROM user_identity WHERE subject = $1', [linker.sub]), [{ user_id: account }], 'one identity');
      assert.deepEqual(await rows('SELECT count(*)::int AS n FROM user_identity WHERE user_id = $1', [account]), [{ n: 1 }]);
      assert.deepEqual(
        await rows(`SELECT actor_id, payload->>'method' AS method FROM activity WHERE type = $1 AND payload->>'email' = $2`, [IDENTITY_LINKED_ACTIVITY, linker.email]),
        [{ actor_id: account, method: 'AUTO' }],
        'one record',
      );
    });
  });

  await t.test('(4) an account without a password: the password login answers it exactly as a wrong password, and the password change is a 400 that says why', async () => {
    await setPolicy('OPEN', admin.id);
    const googleOnly: FakeGoogleAccount = { sub: `google-only-${RUN}`, email: `google-only-${RUN}@gmail.com`, name: 'Google Only' };
    const opened = await signInWithGoogle(googleOnly);
    assert.equal(opened.status, 201, opened.text);
    assert.deepEqual(await rows('SELECT password_hash FROM "user" WHERE id = $1', [toUuid(opened.json.user.id)]), [{ password_hash: null }]);

    const login = (email: string, password: string) => call('POST', '/api/auth/login', { body: { email, password } });
    const wrong = await login(admin.email, 'not-the-password');
    assert.equal(wrong.status, 401);
    for (const [what, answer] of [
      ['an account without a password', await login(googleOnly.email, 'any-password')],
      ['an account without a password, and an empty one', await login(googleOnly.email, '')],
      ['no account at all', await login(`nobody-${RUN}@resolution.invalid`, 'any-password')],
    ] as const) {
      assert.equal(answer.status, 401, what);
      assert.equal(answer.text, wrong.text, `${what}: the answer a wrong password gets, byte for byte`);
    }
    assert.equal((await login(admin.email, admin.password)).status, 201, 'the control: the right password');

    const change = await call('POST', '/api/auth/change-password', {
      bearer: opened.json.accessToken,
      body: { currentPassword: 'any-password', newPassword: 'a-new-password' },
    });
    assert.equal(change.status, 400, `a 400, not a 401 that would sign the Web out: ${change.text}`);
    assert.equal(change.json?.code, 'PASSWORD_NOT_SET');
    assert.match(change.json?.message, /signs in with Google and has no password/);
    assert.deepEqual(await rows('SELECT password_hash FROM "user" WHERE id = $1', [toUuid(opened.json.user.id)]), [{ password_hash: null }]);
  });

  await t.test('(5) POST /admin/users with passwordless: password_hash NULL, no password answered; refused with force or a password; and the account signs in with Google', async () => {
    const create = (body: Row) => call('POST', '/api/admin/users', { bearer: admin.token, body });
    const email = `admin-made-${RUN}@gmail.com`;
    const created = await create({ email, name: 'Admin Made', passwordless: true });
    assert.equal(created.status, 201, created.text);
    assert.ok(!('generatedPassword' in created.json), 'no password is generated');
    const [made] = await rows('SELECT id, name, role, password_hash FROM "user" WHERE email = $1', [email]);
    assert.deepEqual({ name: made.name, role: made.role, password_hash: made.password_hash }, { name: 'Admin Made', role: 'MEMBER', password_hash: null });
    assert.equal((await call('POST', '/api/auth/login', { body: { email, password: 'any-password' } })).status, 401);

    const kept = await create({ email: `kept-${RUN}@resolution.invalid` });
    assert.equal(kept.status, 201, kept.text);
    const keptHash = (await rows('SELECT password_hash FROM "user" WHERE email = $1', [`kept-${RUN}@resolution.invalid`]))[0].password_hash;
    assert.ok(typeof keptHash === 'string' && keptHash !== '');
    for (const [what, body] of [
      ['with force, on an account that exists', { email: `kept-${RUN}@resolution.invalid`, passwordless: true, force: true }],
      ['with force, on an address no account has', { email: `fresh-${RUN}@resolution.invalid`, passwordless: true, force: true }],
      ['with a password', { email: `fresh-${RUN}@resolution.invalid`, passwordless: true, password: 'a-password' }],
    ] as const) {
      const refused = await create(body);
      assert.equal(refused.status, 400, `${what}: ${refused.text}`);
      assert.match(refused.json?.message, /passwordless/, what);
    }
    assert.deepEqual(await rows('SELECT password_hash FROM "user" WHERE email = $1', [`kept-${RUN}@resolution.invalid`]), [{ password_hash: keptHash }], 'the existing password, byte for byte');
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM "user" WHERE email = $1', [`fresh-${RUN}@resolution.invalid`]), [{ n: 0 }], 'nothing was created');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: `kept-${RUN}@resolution.invalid`, password: kept.json.generatedPassword } })).status, 201);

    // What it is for (§5.4): the person signs in with the Google account of that address.
    await setPolicy('EXISTING_ACCOUNTS', admin.id);
    const signedIn = await signInWithGoogle({ sub: `admin-made-${RUN}`, email, name: 'Admin Made' });
    assert.equal(signedIn.status, 201, signedIn.text);
    assert.equal(toUuid(signedIn.json.user.id), made.id);
    assert.deepEqual(await rows('SELECT user_id FROM user_identity WHERE subject = $1', [`admin-made-${RUN}`]), [{ user_id: made.id }]);
  });
});
