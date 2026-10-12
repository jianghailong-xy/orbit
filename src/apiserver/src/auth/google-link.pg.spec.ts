/**
 * Linking Google from the profile page and unlinking it (docs/google-sign-in-design.md §5.3), and the
 * `signInMethods` that `me` and the admin list answer (§6), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty: the controllers, the global pipe, interceptors and
 * filters main.ts installs, the real JwtAuthGuard and AdminRoleGuard, and the real AuthService,
 * PatService, SignInProvidersService and GoogleLoginService over that database. Only Google is not
 * real: the in-process fake (test-support/fake-google.ts) answers its token endpoint, and nothing
 * reaches the network. What it is held to:
 *
 *   (1) Connect Google end to end — POST /auth/google/link, Google, the callback, the confirmation —
 *       read back from the tables: the LINK flow as it waits (intent, client, link_user_id, the
 *       profile page's challenge, the cookie's hash), the identity linked by Google's sub to the
 *       account that opened it, the Activity row (SETTINGS, credential_kind LOGIN), and the flow gone;
 *   (2) the confirmation links only for that account and only with its verifier: another account's
 *       session, an empty or another verifier are refused and spend the ticket, a body without a
 *       verifier is refused before the ticket is read, and nothing is written;
 *   (3) a Google account linked to another account is refused GOOGLE_ALREADY_LINKED with nothing
 *       written; and confirmations made to meet at their INSERT by a lock this spec holds — of one
 *       Google account for several accounts, one links and the rest are refused; of one account's
 *       own link twice, both answer it linked — one identity and one record each time;
 *   (4) unlinking: an account without a password is refused GOOGLE_UNLINK_WOULD_LOCK_OUT and keeps its
 *       identity; one with a password unlinks, recorded SETTINGS; an administrator unlinks the account
 *       without a password, recorded ADMIN and naming it; an unknown account is 404;
 *   (5) GET /users/me and GET /admin/users answer signInMethods with only §6's fields, read through
 *       the real Prisma client — never the hash, nor the identity's sub or Workspace domain.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/google-link.pg.spec.ts
 *
 * It needs the fresh database that script makes: the administrator is made by the first-run bootstrap.
 */
process.env.PROVIDER_SECRET_KEY = `google-link-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { generateToken, hashPassword, sha256 } from '../common/crypto.util';
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
import { AdminController } from '../users/admin.controller';
import { UsersController } from '../users/users.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController } from './google-auth.controller';
import { GoogleLoginService, IDENTITY_LINKED_ACTIVITY, IDENTITY_UNLINKED_ACTIVITY } from './google-login.service';
import { GoogleOAuthClient, s256 } from './google-oauth.client';
import { PatService } from './pat.service';
import { SignInProvidersService } from './sign-in-providers.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CLIENT_ID = `1234-${RUN}.apps.googleusercontent.com`;
const CLIENT_SECRET = `GOCSPX-${RUN}-link`;
/** The password every account a case starts with has: scrypt once, not per account. */
const SEEDED_HASH = hashPassword(`pw-${RUN}-seeded`);
/** How many accounts confirm one Google account at once in (3). */
const RACERS = 4;

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  location: string | null;
  setCookie: string | null;
}

interface Account {
  id: string;
  email: string;
  bearer: string;
}

test('Google linking on PostgreSQL: Connect Google end to end, the confirmation only for its account and verifier, links racing, unlinking, and signInMethods', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db = prismaClientFor(url);
  const google = new FakeGoogle(CLIENT_ID, CLIENT_SECRET);
  const jwt = new JwtService({ secret: `link-${RUN}`, signOptions: { expiresIn: '7d' } });
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  // The apiserver: as main.ts sets it up, over this database, with Google faked.
  @Module({
    controllers: [AuthController, GoogleAuthController, UsersController, AdminController],
    providers: [
      AuthService,
      PatService,
      SignInProvidersService,
      GoogleLoginService,
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(google.fetch) },
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: db },
    ],
  })
  class GoogleLinkHarness {}
  app = await NestFactory.create(GoogleLinkHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

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

  /** An account with a password — or, with `passwordHash` null, without one — and a login bearer for it. */
  const account = async (name: string, passwordHash: string | null = SEEDED_HASH): Promise<Account> => {
    const id = randomUUID();
    const email = `${name}-${RUN}@link.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, $3, $4)`, [id, email, name, passwordHash]);
    return { id, email, bearer: await jwt.signAsync({ sub: id, email }) };
  };
  const linkIdentity = (user: Account, google: FakeGoogleAccount) => sql.query(
    `INSERT INTO user_identity (id, user_id, provider, subject, email, hosted_domain) VALUES (gen_random_uuid(), $1, 'google', $2, $3, $4)`,
    [user.id, google.sub, google.email, google.hd ?? null],
  );

  /** Connect Google up to the ticket: POST /auth/google/link, `google` at Google's page, the callback with the cookie the link set. */
  const linkAtGoogle = async (user: Account, google_: FakeGoogleAccount) => {
    const verifier = generateToken(32);
    const opened = await call('POST', '/api/auth/google/link', { bearer: user.bearer, body: { codeChallenge: s256(verifier) } });
    assert.equal(opened.status, 201, opened.text);
    const cookie = /^orbit_oauth_flow=([A-Za-z0-9_-]{43});/.exec(opened.setCookie ?? '')![1];
    const back = await call('GET', google.authorize(opened.json.authorizationUrl, google_), { cookie });
    const ticket = /^\/settings\/profile\?google_link_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location ?? '')?.[1];
    assert.ok(ticket, `the callback hands the profile page a ticket: ${back.location}`);
    return { ticket, verifier, cookie, authorizationUrl: opened.json.authorizationUrl as string };
  };
  const confirm = (user: Account, ticket: string, codeVerifier: string) =>
    call('POST', '/api/auth/google/link/confirm', { bearer: user.bearer, body: { ticket, codeVerifier } });

  /** Everything a refused confirmation or unlink must leave as it was. */
  const everything = async () => ({
    identities: await rows('SELECT * FROM user_identity ORDER BY id'),
    activity: await rows('SELECT * FROM activity ORDER BY id'),
  });
  const activitySince = async (before: Array<{ id: string }>) => rows(
    `SELECT actor_id, type, payload, credential_kind, credential_id FROM activity WHERE NOT (id = ANY($1::uuid[])) ORDER BY id`,
    [before.map((row) => row.id)],
  );
  const refusedWith = (answer: Answer, status: number, code: string, what: string) => {
    assert.equal(answer.status, status, `${what}: ${answer.text}`);
    assert.equal(answer.json?.code, code, what);
  };

  // The first administrator, by the first-run bootstrap; then Google sign-in on.
  assert.deepEqual(await rows('SELECT count(*)::int AS n FROM "user"'), [{ n: 0 }], 'a fresh database');
  const bootstrap = await call('POST', '/api/auth/bootstrap', { body: { email: `root-${RUN}@link.invalid`, name: 'Root', password: `pw-${RUN}-root` } });
  assert.equal(bootstrap.status, 201, bootstrap.text);
  const root: Account = { id: toUuid(bootstrap.json.user.id), email: bootstrap.json.user.email, bearer: bootstrap.json.accessToken };
  await new SignInProvidersService(db as unknown as PrismaService)
    .updateGoogle(root.id, { enabled: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signupPolicy: 'EXISTING_ACCOUNTS' });

  await t.test('(1) Connect Google end to end: a LINK flow naming the account, the identity linked to it by sub, a SETTINGS record, and the flow gone', async () => {
    const ada = await account('ada');
    const adaGoogle: FakeGoogleAccount = { sub: `ada-${RUN}`, email: `ada.${RUN}@gmail.com`, name: 'Ada' };
    const verifier = generateToken(32);
    const opened = await call('POST', '/api/auth/google/link', { bearer: ada.bearer, body: { codeChallenge: s256(verifier) } });
    assert.equal(opened.status, 201, opened.text);
    assert.deepEqual(Object.keys(opened.json), ['authorizationUrl']);
    const cookie = /^orbit_oauth_flow=([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Lax; Path=\/api\/auth\/google; Max-Age=600; Secure$/.exec(opened.setCookie ?? '')?.[1];
    assert.ok(cookie, `the binding cookie /start sets: ${opened.setCookie}`);
    const state = new URL(opened.json.authorizationUrl).searchParams.get('state')!;
    assert.deepEqual(
      await rows(`SELECT intent, client, link_user_id, status, client_state, client_challenge, binding_hash FROM oauth_login_flow WHERE state_hash = $1`, [sha256(state)]),
      [{ intent: 'LINK', client: 'WEB', link_user_id: ada.id, status: 'PENDING', client_state: null, client_challenge: s256(verifier), binding_hash: sha256(cookie) }],
      'the LINK flow, naming the account signed in',
    );

    const back = await call('GET', google.authorize(opened.json.authorizationUrl, adaGoogle), { cookie });
    const ticket = /^\/settings\/profile\?google_link_ticket=([A-Za-z0-9_-]{43})$/.exec(back.location ?? '')?.[1];
    assert.ok(ticket, `back to the profile page with a ticket: ${back.location}`);
    const before = await everything();
    const linked = await confirm(ada, ticket, verifier);
    assert.equal(linked.status, 201, linked.text);
    assert.deepEqual(linked.json, { signInMethods: { password: true, google: { email: adaGoogle.email } } });
    assert.deepEqual(
      await rows(`SELECT user_id, provider, email, hosted_domain FROM user_identity WHERE subject = $1`, [adaGoogle.sub]),
      [{ user_id: ada.id, provider: 'google', email: adaGoogle.email, hosted_domain: null }],
    );
    assert.deepEqual(await activitySince(before.activity), [{
      actor_id: ada.id,
      type: IDENTITY_LINKED_ACTIVITY,
      payload: { provider: 'google', email: adaGoogle.email, method: 'SETTINGS' },
      credential_kind: 'LOGIN',
      credential_id: null,
    }]);
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM oauth_login_flow WHERE link_user_id = $1', [ada.id]), [{ n: 0 }], 'the ticket was spent');
    assert.deepEqual((await call('GET', '/api/users/me', { bearer: ada.bearer })).json.signInMethods, { password: true, google: { email: adaGoogle.email } });
  });

  await t.test('(2) the confirmation links only for the account that opened the flow and only with its verifier — another account, an empty or another verifier link nothing and spend the ticket', async () => {
    const ada = await account('ada2');
    const bob = await account('bob2');
    const adaGoogle: FakeGoogleAccount = { sub: `ada2-${RUN}`, email: `ada2.${RUN}@gmail.com` };
    const before = await everything();

    const carried = await linkAtGoogle(ada, adaGoogle);
    refusedWith(await confirm(bob, carried.ticket, carried.verifier), 400, 'GOOGLE_FLOW_MISMATCH', "Bob's session with Ada's ticket and verifier");
    refusedWith(await confirm(ada, carried.ticket, carried.verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'Ada, once Bob presented it');

    const missing = await linkAtGoogle(ada, adaGoogle);
    const noVerifier = await call('POST', '/api/auth/google/link/confirm', { bearer: ada.bearer, body: { ticket: missing.ticket } });
    assert.equal(noVerifier.status, 400, noVerifier.text);
    assert.deepEqual(await rows('SELECT status FROM oauth_login_flow WHERE ticket_hash = $1', [sha256(missing.ticket)]), [{ status: 'AUTHENTICATED' }], 'not read, so not spent');
    refusedWith(await confirm(ada, missing.ticket, ''), 400, 'GOOGLE_FLOW_MISMATCH', 'an empty verifier');
    refusedWith(await confirm(ada, missing.ticket, missing.verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'the verifier after an empty one');

    const wrong = await linkAtGoogle(ada, adaGoogle);
    refusedWith(await confirm(ada, wrong.ticket, generateToken(32)), 400, 'GOOGLE_FLOW_MISMATCH', 'another verifier');
    refusedWith(await confirm(ada, wrong.ticket, wrong.verifier), 400, 'GOOGLE_FLOW_MISMATCH', 'the verifier after another');

    assert.deepEqual(await everything(), before, 'nothing linked, nothing recorded');
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM oauth_login_flow WHERE link_user_id = $1', [ada.id]), [{ n: 0 }], 'every ticket spent');
  });

  await t.test('(3) a Google account linked to another account is refused GOOGLE_ALREADY_LINKED; confirmations made to meet at their INSERT link once', async (t) => {
    await t.test('linked already: refused, nothing written', async () => {
      const ada = await account('ada3');
      const bob = await account('bob3');
      const shared: FakeGoogleAccount = { sub: `shared-${RUN}`, email: `shared.${RUN}@gmail.com` };
      await linkIdentity(bob, shared);
      const before = await everything();
      const { ticket, verifier } = await linkAtGoogle(ada, shared);
      refusedWith(await confirm(ada, ticket, verifier), 409, 'GOOGLE_ALREADY_LINKED', "Ada confirming Bob's Google account");
      assert.deepEqual(await everything(), before);
    });

    /**
     * `pending` confirmations released together: this spec holds user_identity in SHARE mode, which
     * every read takes past and every INSERT waits on, until each confirmation is waiting at its
     * INSERT. Then the first to insert wins, and the unique keys fail the others, which read again.
     */
    const race = async (pending: Array<{ user: Account; ticket: string; verifier: string }>) => {
      const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE "user_identity" IN SHARE MODE');
        const answers = Promise.all(pending.map(({ user, ticket, verifier }) => confirm(user, ticket, verifier)));
        const waiting = async () => (await rows(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'relation' AND relation = 'user_identity'::regclass AND NOT granted`,
        ))[0].n;
        const deadline = Date.now() + 20_000;
        while ((await waiting()) < pending.length) {
          assert.ok(Date.now() < deadline, `only ${await waiting()} of ${pending.length} confirmations reached their INSERT`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await holder.query('COMMIT');
        return await answers;
      } finally {
        await holder.end().catch(() => undefined);
      }
    };

    await t.test(`one Google account confirmed for ${RACERS} accounts at once: one links it, the others are refused GOOGLE_ALREADY_LINKED`, async () => {
      const contested: FakeGoogleAccount = { sub: `contested-${RUN}`, email: `contested.${RUN}@gmail.com` };
      const pending: Array<{ user: Account; ticket: string; verifier: string }> = [];
      for (let i = 0; i < RACERS; i += 1) {
        const user = await account(`racer${i}`);
        pending.push({ user, ...(await linkAtGoogle(user, contested)) });
      }
      const answers = await race(pending);
      const won = answers.flatMap((answer, i) => (answer.status === 201 ? [pending[i].user.id] : []));
      assert.equal(won.length, 1, answers.map((answer) => `${answer.status} ${answer.text}`).join('\n'));
      for (const answer of answers.filter((a) => a.status !== 201)) refusedWith(answer, 409, 'GOOGLE_ALREADY_LINKED', 'a confirmation that lost');
      assert.deepEqual(await rows('SELECT user_id FROM user_identity WHERE subject = $1', [contested.sub]), [{ user_id: won[0] }], 'one identity');
      assert.deepEqual(
        await rows(`SELECT actor_id, payload->>'method' AS method FROM activity WHERE type = $1 AND payload->>'email' = $2`, [IDENTITY_LINKED_ACTIVITY, contested.email]),
        [{ actor_id: won[0], method: 'SETTINGS' }],
        'one record',
      );
    });

    await t.test('one account confirming its own link twice at once: both answer it linked — one identity, one record', async () => {
      const ada = await account('ada3b');
      const own: FakeGoogleAccount = { sub: `own-${RUN}`, email: `own.${RUN}@gmail.com` };
      const pending = [{ user: ada, ...(await linkAtGoogle(ada, own)) }, { user: ada, ...(await linkAtGoogle(ada, own)) }];
      const answers = await race(pending);
      assert.deepEqual(answers.map((answer) => answer.status), [201, 201], answers.map((answer) => answer.text).join('\n'));
      for (const answer of answers) assert.deepEqual(answer.json, { signInMethods: { password: true, google: { email: own.email } } });
      assert.deepEqual(await rows('SELECT user_id FROM user_identity WHERE subject = $1', [own.sub]), [{ user_id: ada.id }]);
      assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM activity WHERE type = $1 AND actor_id = $2`, [IDENTITY_LINKED_ACTIVITY, ada.id]), [{ n: 1 }]);
    });
  });

  await t.test('(4) unlinking: refused GOOGLE_UNLINK_WOULD_LOCK_OUT without a password; with one, unlinked and recorded; an administrator unlinks anyone, recorded as theirs', async () => {
    const ada = await account('ada4');
    const gina = await account('gina4', null);
    const adaGoogle: FakeGoogleAccount = { sub: `ada4-${RUN}`, email: `ada4.${RUN}@gmail.com` };
    const ginaGoogle: FakeGoogleAccount = { sub: `gina4-${RUN}`, email: `gina4.${RUN}@gmail.com` };
    await linkIdentity(ada, adaGoogle);
    await linkIdentity(gina, ginaGoogle);

    const before = await everything();
    refusedWith(await call('DELETE', '/api/auth/google/link', { bearer: gina.bearer }), 400, 'GOOGLE_UNLINK_WOULD_LOCK_OUT', 'Gina, who has no password');
    assert.deepEqual(await everything(), before, 'Gina keeps her link, and nothing is recorded');

    const unlinked = await call('DELETE', '/api/auth/google/link', { bearer: ada.bearer });
    assert.equal(unlinked.status, 200, unlinked.text);
    assert.deepEqual(unlinked.json, { signInMethods: { password: true, google: null } });
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM user_identity WHERE user_id = $1', [ada.id]), [{ n: 0 }]);
    assert.deepEqual(await activitySince(before.activity), [{
      actor_id: ada.id,
      type: IDENTITY_UNLINKED_ACTIVITY,
      payload: { provider: 'google', email: adaGoogle.email, method: 'SETTINGS' },
      credential_kind: 'LOGIN',
      credential_id: null,
    }]);

    const member = await call('DELETE', `/api/admin/users/${uuidToBase62(gina.id)}/identities/google`, { bearer: ada.bearer });
    assert.equal(member.status, 403, member.text);
    const afterOwn = await everything();
    const admin = await call('DELETE', `/api/admin/users/${uuidToBase62(gina.id)}/identities/google`, { bearer: root.bearer });
    assert.equal(admin.status, 200, admin.text);
    assert.deepEqual(admin.json, { signInMethods: { password: false, google: null } });
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM user_identity WHERE user_id = $1', [gina.id]), [{ n: 0 }]);
    assert.deepEqual(await activitySince(afterOwn.activity), [{
      actor_id: root.id,
      type: IDENTITY_UNLINKED_ACTIVITY,
      payload: { provider: 'google', email: ginaGoogle.email, method: 'ADMIN', userId: gina.id },
      credential_kind: 'LOGIN',
      credential_id: null,
    }]);
    assert.equal((await call('DELETE', `/api/admin/users/${uuidToBase62(randomUUID())}/identities/google`, { bearer: root.bearer })).status, 404);
  });

  await t.test('(5) GET /users/me and GET /admin/users: signInMethods with only §6\'s fields, through the real Prisma client', async () => {
    const both = await account('both5');
    const googleOnly = await account('google5', null);
    const neither = await account('none5', null);
    const bothGoogle: FakeGoogleAccount = { sub: `google-sub-both-${RUN}`, email: `both5.${RUN}@gmail.com` };
    const workspace: FakeGoogleAccount = { sub: `google-sub-workspace-${RUN}`, email: `google5.${RUN}@corp.invalid`, hd: `corp-${RUN}.invalid` };
    await linkIdentity(both, bothGoogle);
    await linkIdentity(googleOnly, workspace);
    await sql.query('UPDATE user_identity SET last_sign_in_at = now() WHERE user_id = ANY($1::uuid[])', [[both.id, googleOnly.id]]);
    const expected = new Map<string, unknown>([
      [both.id, { password: true, google: { email: bothGoogle.email } }],
      [googleOnly.id, { password: false, google: { email: workspace.email } }],
      [neither.id, { password: false, google: null }],
    ]);
    const secret = (text: string) => [SEEDED_HASH, bothGoogle.sub, workspace.sub, workspace.hd!, 'passwordHash', 'password_hash', 'identities', 'subject', 'hostedDomain', 'lastSignInAt']
      .filter((needle) => text.includes(needle));

    for (const user of [both, googleOnly, neither]) {
      const me = await call('GET', '/api/users/me', { bearer: user.bearer });
      assert.equal(me.status, 200, me.text);
      assert.deepEqual(
        Object.keys(me.json).sort(),
        ['avatarUpdatedAt', 'createdAt', 'email', 'id', 'name', 'preferences', 'publicId', 'role', 'signInMethods'],
      );
      assert.deepEqual(me.json.signInMethods, expected.get(user.id), user.email);
      assert.deepEqual(secret(me.text), [], user.email);
    }

    const list = await call('GET', '/api/admin/users', { bearer: root.bearer });
    assert.equal(list.status, 200, list.text);
    const all = await rows(`SELECT u.id, u.password_hash IS NOT NULL AS password, i.email AS google
      FROM "user" u LEFT JOIN user_identity i ON i.user_id = u.id AND i.provider = 'google' ORDER BY u.created_at, u.id`);
    assert.deepEqual(new Set(list.json.map((row: { id: string }) => toUuid(row.id))), new Set(all.map((row) => row.id)), 'every account');
    for (const row of list.json) {
      // §6's other field of a row, disabledAt (§5.5): null, as no account here is disabled.
      assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'disabledAt', 'email', 'id', 'name', 'publicId', 'role', 'signInMethods'], row.email);
      assert.equal(row.disabledAt, null, row.email);
      const truth = all.find((one) => one.id === toUuid(row.id));
      assert.deepEqual(row.signInMethods, { password: truth.password, google: truth.google === null ? null : { email: truth.google } }, row.email);
      if (expected.has(toUuid(row.id))) assert.deepEqual(row.signInMethods, expected.get(toUuid(row.id)), row.email);
    }
    assert.deepEqual(secret(list.text), [], 'the admin list');
  });
});
