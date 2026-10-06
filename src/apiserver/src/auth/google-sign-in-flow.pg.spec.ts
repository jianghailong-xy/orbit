/**
 * Signing in with Google (docs/google-sign-in-design.md §4, §5.1, migration 0391) against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty: the controllers, the global pipe,
 * interceptors and filters main.ts installs, and the real AuthService, PatService,
 * SignInProvidersService and GoogleLoginService over that database. Only Google is not real: the
 * in-process fake (test-support/fake-google.ts) answers its token endpoint, and nothing reaches the
 * network. What it is held to:
 *
 *   (1) 0391 made the two tables it describes — their columns and which of them are NOT NULL, the
 *       defaults, the keys, the CHECKs, the unique and plain indexes, the foreign keys to `user`
 *       (ON DELETE CASCADE) and no trigger — writes no row and runs again; and the constraints refuse
 *       what they exist to refuse;
 *   (2) a Web and a native sign-in end to end on real rows: /start writes one PENDING flow holding
 *       hashes, the callback makes it AUTHENTICATED with the claims and a ticket's hash, and the
 *       exchange deletes it and answers what POST /auth/bootstrap and POST /auth/login answer — the
 *       same keys, user, JWT claims and refresh token, which then refreshes; the identity is brought up
 *       to date, and no Google token is in any table or answer;
 *   (3) the exchange takes the flow with one statement, DELETE … RETURNING, so of concurrent
 *       exchanges of one ticket exactly one is answered a session; and a ticket presented with another
 *       verifier, past its two minutes, or from a LINK flow is spent and refused;
 *   (4) the callback ends the flow it refuses — a missing or foreign binding cookie, Google's error,
 *       a failed code exchange, a claim that does not pass — and a state is used once;
 *   (5) /start sweeps the rows past their end, and past GOOGLE_PENDING_FLOW_CAP flows in flight it is
 *       refused 503 and writes nothing;
 *   (6) deleting a user deletes their identity and the LINK flows naming them, and nothing else.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/google-sign-in-flow.pg.spec.ts
 *
 * It needs the fresh database that script makes: (2) starts with the first-run bootstrap, which is
 * only open while no user exists.
 */
process.env.PROVIDER_SECRET_KEY = `google-sign-in-flow-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { generateToken, sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { countingPrismaClientFor } from '../test-support/counting-prisma-client';
import { FakeGoogle, type FakeGoogleAccount } from '../test-support/fake-google';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleAuthController } from './google-auth.controller';
import { GOOGLE_PENDING_FLOW_CAP, GoogleLoginService } from './google-login.service';
import { GoogleOAuthClient, s256 } from './google-oauth.client';
import { PatService } from './pat.service';
import { SignInProvidersService } from './sign-in-providers.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CLIENT_ID = `1234-${RUN}.apps.googleusercontent.com`;
const CLIENT_SECRET = `GOCSPX-${RUN}-flow`;
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0391_google_login_flow/migration.sql'),
  'utf8',
);
const BINDING_CLEARED = 'orbit_oauth_flow=; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=0; Secure';

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

/** The claims of a JWT, unverified: what the token carries is the shape under test, not its signature. */
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

test('Google sign-in on PostgreSQL: the 0391 tables, the flow end to end, a ticket spent once under concurrency, refusals that end flows, the sweep, the cap and the cascade', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const { prisma: db, statements } = countingPrismaClientFor(url);
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
  const flows = () => rows('SELECT * FROM oauth_login_flow ORDER BY created_at, id');

  await t.test('(1) 0391 made the tables it describes, writes no row, runs again, and its constraints refuse what they exist to refuse', async () => {
    assert.deepEqual(
      await rows(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0391_google_login_flow'`),
      [{ done: true }],
    );
    const columns = async (table: string) => (await rows(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )).map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`
      + (c.column_default === null ? '' : ` DEFAULT ${c.column_default}`));
    assert.deepEqual(await columns('user_identity'), [
      'id uuid NOT NULL',
      'user_id uuid NOT NULL',
      'provider text NOT NULL',
      'subject text NOT NULL',
      'email text NOT NULL',
      'hosted_domain text NULL',
      'created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
      'last_sign_in_at timestamptz NULL',
    ]);
    assert.deepEqual(await columns('oauth_login_flow'), [
      'id uuid NOT NULL',
      'provider text NOT NULL',
      'intent text NOT NULL',
      'client text NOT NULL',
      'state_hash text NOT NULL',
      'binding_hash text NOT NULL',
      'nonce text NOT NULL',
      'provider_code_verifier text NOT NULL',
      'client_challenge text NOT NULL',
      'client_state text NULL',
      'link_user_id uuid NULL',
      "status text NOT NULL DEFAULT 'PENDING'::text",
      'claims jsonb NULL',
      'ticket_hash text NULL',
      'ticket_expires_at timestamptz NULL',
      'expires_at timestamptz NOT NULL',
      'created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]);
    const constraints = async (table: string) => rows(
      `SELECT conname, contype, confdeltype FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
      [table],
    );
    assert.deepEqual(await constraints('user_identity'), [
      { conname: 'user_identity_pkey', contype: 'p', confdeltype: ' ' },
      { conname: 'user_identity_provider_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'user_identity_subject_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'user_identity_user_id_fkey', contype: 'f', confdeltype: 'c' },
    ]);
    assert.deepEqual(await constraints('oauth_login_flow'), [
      { conname: 'oauth_login_flow_client_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'oauth_login_flow_intent_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'oauth_login_flow_link_user_id_fkey', contype: 'f', confdeltype: 'c' },
      { conname: 'oauth_login_flow_pkey', contype: 'p', confdeltype: ' ' },
      { conname: 'oauth_login_flow_provider_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'oauth_login_flow_status_chk', contype: 'c', confdeltype: ' ' },
    ]);
    const indexes = async (table: string) => (await rows(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY indexname`,
      [table],
    )).map((index) => `${index.indexname} ${/UNIQUE/.test(index.indexdef) ? 'UNIQUE ' : ''}${/\((.*)\)/.exec(index.indexdef)![1]}`);
    assert.deepEqual(await indexes('user_identity'), [
      'user_identity_pkey UNIQUE id',
      'user_identity_provider_subject_key UNIQUE provider, subject',
      'user_identity_user_id_provider_key UNIQUE user_id, provider',
    ]);
    assert.deepEqual(await indexes('oauth_login_flow'), [
      'oauth_login_flow_expires_at_idx expires_at',
      'oauth_login_flow_link_user_id_idx link_user_id',
      'oauth_login_flow_pkey UNIQUE id',
      'oauth_login_flow_state_hash_key UNIQUE state_hash',
      'oauth_login_flow_ticket_hash_key UNIQUE ticket_hash',
    ]);
    assert.deepEqual(
      await rows(`SELECT tgname FROM pg_trigger WHERE tgrelid IN ('user_identity'::regclass, 'oauth_login_flow'::regclass) AND NOT tgisinternal`),
      [],
    );
    assert.deepEqual(await rows('SELECT * FROM user_identity'), []);
    assert.deepEqual(await flows(), []);

    // What the constraints refuse — each inside a transaction rolled back, so nothing stays.
    const user = randomUUID();
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'Constraint', 'x')`, [user, `constraint-${RUN}@flow.invalid`]);
    const attempt = async (statement: string, values: unknown[] = []) => {
      await sql.query('BEGIN');
      try {
        await sql.query(`INSERT INTO user_identity (id, user_id, provider, subject, email) VALUES (gen_random_uuid(), $1, 'google', 'taken', 'a@b.c')`, [user]);
        await sql.query(statement, values);
        return 'ACCEPTED';
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        return `${e.code} ${e.constraint}`;
      } finally {
        await sql.query('ROLLBACK');
      }
    };
    const identity = (columns: string) =>
      `INSERT INTO user_identity (id, user_id, provider, subject, email) VALUES (gen_random_uuid(), ${columns})`;
    const other = randomUUID();
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'Other', 'x')`, [other, `other-${RUN}@flow.invalid`]);
    assert.equal(await attempt(identity(`$1, 'google', 'sub-2', 'x@y.z'`), [other]), 'ACCEPTED', 'the control');
    assert.equal(await attempt(identity(`$1, 'github', 'sub-2', 'x@y.z'`), [other]), '23514 user_identity_provider_chk');
    assert.equal(await attempt(identity(`$1, 'google', '', 'x@y.z'`), [other]), '23514 user_identity_subject_chk');
    assert.equal(await attempt(identity(`$1, 'google', 'taken', 'x@y.z'`), [other]), '23505 user_identity_provider_subject_key', 'one Orbit account per Google account');
    assert.equal(await attempt(identity(`$1, 'google', 'sub-2', 'x@y.z'`), [user]), '23505 user_identity_user_id_provider_key', 'one Google account per Orbit account');
    assert.equal(await attempt(identity(`$1, 'google', 'sub-2', 'x@y.z'`), [randomUUID()]), '23503 user_identity_user_id_fkey');

    const flow = (columns: Row) => {
      const values: Row = {
        id: randomUUID(), provider: 'google', intent: 'LOGIN', client: 'WEB', state_hash: randomUUID(), binding_hash: 'b',
        nonce: 'n', provider_code_verifier: 'v', client_challenge: 'c', expires_at: new Date(Date.now() + 60_000), ...columns,
      };
      const names = Object.keys(values);
      return [
        `INSERT INTO oauth_login_flow (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        names.map((name) => values[name]),
      ] as const;
    };
    const authenticated = { status: 'AUTHENTICATED', claims: { sub: 's' }, ticket_hash: randomUUID(), ticket_expires_at: new Date(Date.now() + 60_000) };
    const cases: Array<[string, Row, string]> = [
      ['a PENDING LOGIN flow', {}, 'ACCEPTED'],
      ['an AUTHENTICATED flow with claims and a ticket', authenticated, 'ACCEPTED'],
      ['a LINK flow naming its user', { intent: 'LINK', link_user_id: user }, 'ACCEPTED'],
      ['another provider', { provider: 'github' }, '23514 oauth_login_flow_provider_chk'],
      ['another client', { client: 'IOS' }, '23514 oauth_login_flow_client_chk'],
      ['another intent', { intent: 'SIGNUP' }, '23514 oauth_login_flow_intent_chk'],
      ['a LINK flow naming nobody', { intent: 'LINK' }, '23514 oauth_login_flow_intent_chk'],
      ['a LOGIN flow naming a user', { link_user_id: user }, '23514 oauth_login_flow_intent_chk'],
      ['another status', { status: 'DONE' }, '23514 oauth_login_flow_status_chk'],
      ['AUTHENTICATED without claims', { ...authenticated, claims: null }, '23514 oauth_login_flow_status_chk'],
      ['AUTHENTICATED without a ticket', { ...authenticated, ticket_hash: null, ticket_expires_at: null }, '23514 oauth_login_flow_status_chk'],
      ['a ticket without its expiry', { ...authenticated, ticket_expires_at: null }, '23514 oauth_login_flow_status_chk'],
      ['PENDING with a ticket', { ticket_hash: 't', ticket_expires_at: new Date() }, '23514 oauth_login_flow_status_chk'],
      ['PENDING with claims', { claims: { sub: 's' } }, '23514 oauth_login_flow_status_chk'],
      ['a LINK flow for a user that does not exist', { intent: 'LINK', link_user_id: randomUUID() }, '23503 oauth_login_flow_link_user_id_fkey'],
    ];
    for (const [what, columns, outcome] of cases) {
      const [statement, values] = flow(columns);
      assert.equal(await attempt(statement, values as unknown[]), outcome, what);
    }
    // One state per flow, and one ticket.
    const [first, firstValues] = flow({ state_hash: 'same', ...authenticated, ticket_hash: 'same-ticket' });
    const [second, secondValues] = flow({ state_hash: 'same' });
    const [third, thirdValues] = flow({ ...authenticated, ticket_hash: 'same-ticket' });
    await sql.query('BEGIN');
    try {
      await sql.query(first, firstValues as unknown[]);
      await assert.rejects(sql.query('SAVEPOINT s').then(() => sql.query(second, secondValues as unknown[])), { constraint: 'oauth_login_flow_state_hash_key' });
      await sql.query('ROLLBACK TO SAVEPOINT s');
      await assert.rejects(sql.query(third, thirdValues as unknown[]), { constraint: 'oauth_login_flow_ticket_hash_key' });
    } finally {
      await sql.query('ROLLBACK');
    }
    await sql.query('DELETE FROM "user" WHERE id = ANY($1)', [[user, other]]);

    await sql.query(MIGRATION);
    assert.deepEqual(await constraints('oauth_login_flow'), [
      { conname: 'oauth_login_flow_client_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'oauth_login_flow_intent_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'oauth_login_flow_link_user_id_fkey', contype: 'f', confdeltype: 'c' },
      { conname: 'oauth_login_flow_pkey', contype: 'p', confdeltype: ' ' },
      { conname: 'oauth_login_flow_provider_chk', contype: 'c', confdeltype: ' ' },
      { conname: 'oauth_login_flow_status_chk', contype: 'c', confdeltype: ' ' },
    ], 'a second run changes nothing');
    assert.equal((await constraints('user_identity')).length, 4);
    assert.deepEqual(await rows('SELECT * FROM user_identity'), []);
    assert.deepEqual(await flows(), []);
  });

  // The apiserver: as main.ts sets it up, over this database, with Google faked.
  @Module({
    controllers: [AuthController, GoogleAuthController],
    providers: [
      AuthService,
      PatService,
      SignInProvidersService,
      GoogleLoginService,
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(google.fetch) },
      { provide: JwtService, useValue: new JwtService({ secret: `flow-${RUN}`, signOptions: { expiresIn: '7d' } }) },
      { provide: PrismaService, useValue: db },
    ],
  })
  class GoogleFlowHarness {}
  app = await NestFactory.create(GoogleFlowHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  /** Every answer in this run, for what none of them may carry. */
  const answers: Answer[] = [];
  let addresses = 0;
  const call = async (method: string, route: string, options: { body?: unknown; cookie?: string | null; address?: string } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      redirect: 'manual',
      headers: {
        'x-real-ip': options.address ?? `198.51.100.${(addresses += 1) % 250}`,
        ...(options.cookie ? { cookie: `orbit_oauth_flow=${options.cookie}` } : {}),
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
    const answer: Answer = { status: response.status, text, json, location: response.headers.get('location'), setCookie: response.headers.get('set-cookie') };
    answers.push(answer);
    return answer;
  };
  /** /start from a fresh browser, through Google's page: the cookie it was set, its verifier and where Google sends it back. */
  const startAtGoogle = async (options: { client?: 'web' | 'native'; clientState?: string; account?: FakeGoogleAccount; claims?: Row; deny?: boolean } = {}) => {
    const verifier = generateToken(32);
    const query = new URLSearchParams({ client: options.client ?? 'web', code_challenge: s256(verifier) });
    if (options.clientState !== undefined) query.set('client_state', options.clientState);
    const started = await call('GET', `/api/auth/google/start?${query}`);
    assert.equal(started.status, 302, started.text);
    const cookie = /^orbit_oauth_flow=([A-Za-z0-9_-]{43});/.exec(started.setCookie ?? '')![1];
    const callback = options.deny ? google.deny(started.location!) : google.authorize(started.location!, options.account ?? ADA, options.claims);
    return { cookie, verifier, callback, state: new URL(started.location!).searchParams.get('state')! };
  };
  const ticketOf = (answer: Answer) => /[?&](?:google_ticket|ticket)=([A-Za-z0-9_-]{43})/.exec(answer.location ?? '')?.[1];
  const exchange = (ticket: string, codeVerifier: string) =>
    call('POST', '/api/auth/google/exchange', { body: { ticket, codeVerifier } });

  const ADA: FakeGoogleAccount = { sub: `1101${RUN}`, email: `ada-${RUN}@gmail.com`, name: 'Ada Lovelace' };
  const admin = { id: '', email: `admin-${RUN}@flow.invalid`, name: 'First Admin', password: `pw-${RUN}-admin` };

  await t.test('(2) a Web and a native sign-in end to end: hashes at rest, the ticket exchanged for the answer bootstrap and login give, a refresh that works, the identity brought up to date', async () => {
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM "user"'), [{ n: 0 }], 'the bootstrap is only open on the fresh database run-pg-spec.sh makes');
    const bootstrap = await call('POST', '/api/auth/bootstrap', { body: { email: admin.email, name: admin.name, password: admin.password } });
    assert.equal(bootstrap.status, 201, bootstrap.text);
    admin.id = toUuid(bootstrap.json.user.id);
    await new SignInProvidersService(db as unknown as PrismaService).updateGoogle(admin.id, {
      enabled: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signupPolicy: 'EXISTING_ACCOUNTS',
    });
    // Linking a Google account is the profile page's (§5.3), not this task's: the row is written here.
    await sql.query(
      `INSERT INTO user_identity (id, user_id, provider, subject, email, hosted_domain) VALUES (gen_random_uuid(), $1, 'google', $2, 'old@gmail.com', 'old.example.com')`,
      [admin.id, ADA.sub],
    );

    const web = await startAtGoogle({ account: { ...ADA, hd: 'example.com' } });
    const [pending] = await flows();
    assert.equal(pending.status, 'PENDING');
    assert.equal(pending.client, 'WEB');
    assert.equal(pending.intent, 'LOGIN');
    assert.equal(pending.state_hash, sha256(web.state));
    assert.equal(pending.binding_hash, sha256(web.cookie));
    assert.equal(pending.client_challenge, s256(web.verifier));
    assert.equal(pending.link_user_id, null);
    assert.equal(pending.claims, null);
    assert.ok(!JSON.stringify(pending).includes(web.state) && !JSON.stringify(pending).includes(web.cookie), 'hashes only');
    const ttl = await rows(`SELECT round(extract(epoch FROM expires_at - created_at))::int AS s FROM oauth_login_flow WHERE id = $1`, [pending.id]);
    assert.deepEqual(ttl, [{ s: 600 }], 'ten minutes');

    const back = await call('GET', web.callback, { cookie: web.cookie });
    assert.equal(back.status, 302, back.text);
    assert.equal(back.setCookie, BINDING_CLEARED);
    assert.match(back.location ?? '', /^\/login\?google_ticket=[A-Za-z0-9_-]{43}$/);
    const ticket = ticketOf(back)!;
    const [authenticated] = await flows();
    assert.equal(authenticated.id, pending.id);
    assert.equal(authenticated.status, 'AUTHENTICATED');
    assert.deepEqual(authenticated.claims, { sub: ADA.sub, email: ADA.email, emailVerified: true, hd: 'example.com', name: 'Ada Lovelace' });
    assert.equal(authenticated.ticket_hash, sha256(ticket));
    const ticketTtl = await rows(
      `SELECT round(extract(epoch FROM ticket_expires_at - now()))::int AS s, expires_at = ticket_expires_at AS ends_with_ticket FROM oauth_login_flow WHERE id = $1`,
      [pending.id],
    );
    assert.ok(ticketTtl[0].s >= 115 && ticketTtl[0].s <= 120, `two minutes, not ${ticketTtl[0].s} s`);
    assert.equal(ticketTtl[0].ends_with_ticket, true);

    const session = await exchange(ticket, web.verifier);
    assert.equal(session.status, 201, session.text);
    assert.deepEqual(await flows(), [], 'the exchange took the flow out');
    const login = await call('POST', '/api/auth/login', { body: { email: admin.email, password: admin.password } });
    assert.equal(login.status, 201, login.text);
    const shapeOf = (json: Row) => ({
      keys: Object.keys(json).sort(),
      user: json.user,
      claims: Object.keys(claimsOf(json.accessToken)).sort(),
      sub: claimsOf(json.accessToken).sub,
      email: claimsOf(json.accessToken).email,
      refresh: /^[A-Za-z0-9_-]{43}$/.test(json.refreshToken),
    });
    assert.deepEqual(shapeOf(session.json), shapeOf(login.json), 'the exchange answers what POST /auth/login answers');
    assert.deepEqual(shapeOf(session.json), shapeOf(bootstrap.json), 'and what POST /auth/bootstrap answered');
    assert.deepEqual(Object.keys(session.json.user).sort(), ['email', 'id', 'name', 'publicId']);
    assert.equal(session.json.user.publicId, uuidToBase62(admin.id));
    assert.equal(claimsOf(session.json.accessToken).sub, admin.id);
    const refreshed = await call('POST', '/api/auth/refresh', { body: { refreshToken: session.json.refreshToken } });
    assert.equal(refreshed.status, 201, refreshed.text);
    assert.deepEqual(shapeOf(refreshed.json), shapeOf(login.json), 'its refresh token is a refresh token like any other');

    const [identity] = await rows(`SELECT email, hosted_domain, last_sign_in_at FROM user_identity WHERE subject = $1`, [ADA.sub]);
    assert.equal(identity.email, ADA.email);
    assert.equal(identity.hosted_domain, 'example.com');
    assert.ok(identity.last_sign_in_at instanceof Date);
    assert.deepEqual(await rows('SELECT email FROM "user" WHERE id = $1', [admin.id]), [{ email: admin.email }], "the account's email is not Google's to change");

    // Native: the app's fixed address, with its state.
    const native = await startAtGoogle({ client: 'native', clientState: `app-${RUN}` });
    const opened = await call('GET', native.callback, { cookie: native.cookie });
    assert.match(opened.location ?? '', new RegExp(`^orbit://auth/google\\?ticket=[A-Za-z0-9_-]{43}&state=app-${RUN}$`));
    assert.equal((await exchange(ticketOf(opened)!, native.verifier)).status, 201);

    // No Google token is in any table, nor in any answer.
    assert.ok(google.accessTokens.length >= 2);
    const dump = JSON.stringify(await rows(`SELECT
      (SELECT coalesce(json_agg(f), '[]') FROM oauth_login_flow f) AS flows,
      (SELECT coalesce(json_agg(i), '[]') FROM user_identity i) AS identities,
      (SELECT coalesce(json_agg(r), '[]') FROM refresh_token r) AS refresh`));
    for (const token of google.accessTokens) {
      assert.ok(!dump.includes(token), 'a Google access token was stored');
      assert.ok(!answers.some((answer) => answer.text.includes(token) || (answer.location ?? '').includes(token)), 'a Google access token was answered');
    }
  });

  await t.test('(3) the exchange is one DELETE … RETURNING: of concurrent exchanges one session; another verifier, an expired ticket or a LINK ticket is spent and refused', async () => {
    const back = async () => {
      const flow = await startAtGoogle();
      return { ticket: ticketOf(await call('GET', flow.callback, { cookie: flow.cookie }))!, verifier: flow.verifier };
    };

    const one = await back();
    statements.reset();
    assert.equal((await exchange(one.ticket, one.verifier)).status, 201);
    const touching = statements.sql.filter((statement) => /oauth_login_flow/.test(statement));
    assert.equal(touching.length, 1, `one statement takes the flow:\n${touching.join('\n')}`);
    assert.match(
      touching[0].replace(/\s+/g, ' ').trim(),
      /^DELETE FROM "oauth_login_flow" WHERE "ticket_hash" = \$1 AND "status" = 'AUTHENTICATED' RETURNING /,
    );

    const raced = await back();
    const answersRaced = await Promise.all(Array.from({ length: 12 }, () => exchange(raced.ticket, raced.verifier)));
    assert.deepEqual(answersRaced.map((answer) => answer.status).sort(), [201, ...Array.from({ length: 11 }, () => 400)]);
    for (const answer of answersRaced.filter((a) => a.status === 400)) assert.equal(answer.json?.code, 'GOOGLE_FLOW_MISMATCH');

    const wrong = await back();
    assert.equal((await exchange(wrong.ticket, generateToken(32))).json?.code, 'GOOGLE_FLOW_MISMATCH');
    assert.equal((await exchange(wrong.ticket, wrong.verifier)).json?.code, 'GOOGLE_FLOW_MISMATCH', 'spent by the wrong verifier');

    const late = await back();
    await sql.query(`UPDATE oauth_login_flow SET ticket_expires_at = now() - interval '1 second' WHERE ticket_hash = $1`, [sha256(late.ticket)]);
    assert.equal((await exchange(late.ticket, late.verifier)).json?.code, 'GOOGLE_FLOW_MISMATCH', 'past its two minutes');

    const link = await back();
    await sql.query(`UPDATE oauth_login_flow SET intent = 'LINK', link_user_id = $2 WHERE ticket_hash = $1`, [sha256(link.ticket), admin.id]);
    assert.equal((await exchange(link.ticket, link.verifier)).json?.code, 'GOOGLE_FLOW_MISMATCH', 'a LINK ticket is not a sign-in');
    assert.deepEqual(await flows(), [], 'every presented ticket was spent');

    // A Google account no Orbit account is linked to, for now (S3 completes §5.2).
    const stranger = await startAtGoogle({ account: { sub: `stranger-${RUN}`, email: `stranger-${RUN}@gmail.com` } });
    const strangerTicket = ticketOf(await call('GET', stranger.callback, { cookie: stranger.cookie }))!;
    const refused = await exchange(strangerTicket, stranger.verifier);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json?.code, 'GOOGLE_ACCOUNT_NOT_FOUND');
    assert.deepEqual(await flows(), []);
  });

  await t.test('(4) the callback ends every flow it refuses, as §4.2 says, and a state is used once', async () => {
    const refusedWith = async (what: string, flow: { state: string }, answer: Answer, code: string) => {
      assert.equal(answer.location, `/login?google_error=${code}`, `${what}: ${answer.text}`);
      assert.equal(answer.setCookie, BINDING_CLEARED, what);
      assert.deepEqual(await rows('SELECT id FROM oauth_login_flow WHERE state_hash = $1', [sha256(flow.state)]), [], `${what}: the flow was ended`);
    };
    const noCookie = await startAtGoogle();
    await refusedWith('no binding cookie', noCookie, await call('GET', noCookie.callback), 'GOOGLE_FLOW_EXPIRED');
    assert.equal((await call('GET', noCookie.callback, { cookie: noCookie.cookie })).location, '/login?google_error=GOOGLE_FLOW_EXPIRED', 'the right cookie, after');
    const foreign = await startAtGoogle();
    const owner = await startAtGoogle();
    await refusedWith("another flow's cookie", foreign, await call('GET', foreign.callback, { cookie: owner.cookie }), 'GOOGLE_FLOW_EXPIRED');
    const denied = await startAtGoogle({ deny: true });
    await refusedWith('access_denied', denied, await call('GET', denied.callback, { cookie: denied.cookie }), 'GOOGLE_CANCELLED');
    const failed = await startAtGoogle();
    google.tokenAnswer = 'refused';
    try {
      await refusedWith('the code exchange refused', failed, await call('GET', failed.callback, { cookie: failed.cookie }), 'GOOGLE_EXCHANGE_FAILED');
    } finally {
      google.tokenAnswer = 'ok';
    }
    for (const [what, claims, code] of [
      ['another nonce', { nonce: 'other' }, 'GOOGLE_EXCHANGE_FAILED'],
      ['another audience', { aud: 'other.apps.googleusercontent.com' }, 'GOOGLE_EXCHANGE_FAILED'],
      ['another azp', { azp: 'other.apps.googleusercontent.com' }, 'GOOGLE_EXCHANGE_FAILED'],
      ['another issuer', { iss: 'https://login.example.com' }, 'GOOGLE_EXCHANGE_FAILED'],
      ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }, 'GOOGLE_EXCHANGE_FAILED'],
      ['email not verified', { email_verified: false }, 'GOOGLE_EMAIL_UNVERIFIED'],
    ] as const) {
      const flow = await startAtGoogle({ claims });
      await refusedWith(what, flow, await call('GET', flow.callback, { cookie: flow.cookie }), code);
    }
    const expired = await startAtGoogle();
    await sql.query(`UPDATE oauth_login_flow SET expires_at = now() - interval '1 second' WHERE state_hash = $1`, [sha256(expired.state)]);
    await refusedWith('past its ten minutes', expired, await call('GET', expired.callback, { cookie: expired.cookie }), 'GOOGLE_FLOW_EXPIRED');

    // A state is used once: replayed after its ticket, it is refused and the ticket stays the client's.
    const once = await startAtGoogle({ client: 'native', clientState: 'once' });
    const done = await call('GET', once.callback, { cookie: once.cookie });
    const replay = await call('GET', once.callback, { cookie: once.cookie });
    assert.equal(replay.location, 'orbit://auth/google?error=GOOGLE_FLOW_EXPIRED&state=once');
    assert.equal((await exchange(ticketOf(done)!, once.verifier)).status, 201);
    assert.deepEqual(await rows("SELECT state_hash FROM oauth_login_flow WHERE status = 'AUTHENTICATED'"), []);

    // Two callbacks with one state at once — even from a Google that traded the code twice — get one
    // ticket between them: the flow becomes AUTHENTICATED once.
    google.codesTradeOnce = false;
    try {
      const raced = await startAtGoogle();
      google.holdTokenRequests(2);
      const both = await Promise.all([0, 1].map(() => call('GET', raced.callback, { cookie: raced.cookie })));
      assert.equal(google.tokenRequests.filter((form) => form.get('code') === new URLSearchParams(raced.callback.split('?')[1]).get('code')).length, 2, 'both callbacks reached Google');
      const tickets = both.map(ticketOf).filter((ticket): ticket is string => ticket !== undefined);
      assert.equal(tickets.length, 1, both.map((answer) => answer.location).join('\n'));
      assert.deepEqual(await rows('SELECT ticket_hash FROM oauth_login_flow WHERE state_hash = $1', [sha256(raced.state)]), [{ ticket_hash: sha256(tickets[0]) }]);
      assert.equal((await exchange(tickets[0], raced.verifier)).status, 201);
    } finally {
      google.codesTradeOnce = true;
    }
    // Every flow this case started has ended, the two whose cookie was borrowed or never used aside.
    assert.deepEqual((await flows()).map((flow) => flow.state_hash), [sha256(owner.state)]);
    await sql.query('DELETE FROM oauth_login_flow');
  });

  await t.test('(5) /start sweeps the rows past their end, and past the cap of flows in flight is refused 503 and writes nothing', async () => {
    const challenge = s256(generateToken(32));
    const insert = (status: string, expiresIn: string, count = 1) => sql.query(
      `INSERT INTO oauth_login_flow (id, provider, intent, client, state_hash, binding_hash, nonce, provider_code_verifier,
         client_challenge, status, claims, ticket_hash, ticket_expires_at, expires_at)
       SELECT gen_random_uuid(), 'google', 'LOGIN', 'WEB', $1 || g, 'b', 'n', 'v', 'c', $2,
         CASE WHEN $2 = 'AUTHENTICATED' THEN '{"sub":"s"}'::jsonb END,
         CASE WHEN $2 = 'AUTHENTICATED' THEN $1 || 't' || g END,
         CASE WHEN $2 = 'AUTHENTICATED' THEN now() + $3::interval END,
         now() + $3::interval
       FROM generate_series(1, $4::int) g`,
      [`${randomUUID()}-`, status, expiresIn, count],
    );
    await insert('PENDING', '-1 second');
    await insert('AUTHENTICATED', '-1 second');
    await insert('AUTHENTICATED', '1 minute');
    await insert('PENDING', '5 minutes');
    const started = await call('GET', `/api/auth/google/start?client=web&code_challenge=${challenge}`);
    assert.equal(started.status, 302, started.text);
    assert.deepEqual(
      await rows(`SELECT status, expires_at > now() AS live, count(*)::int AS n FROM oauth_login_flow GROUP BY 1, 2 ORDER BY 1, 2`),
      [{ status: 'AUTHENTICATED', live: true, n: 1 }, { status: 'PENDING', live: true, n: 2 }],
      'the two rows past their end were swept; the live ones and the new one remain',
    );

    await insert('PENDING', '5 minutes', GOOGLE_PENDING_FLOW_CAP - 2);
    const before = await rows(`SELECT count(*)::int AS n FROM oauth_login_flow WHERE status = 'PENDING'`);
    assert.deepEqual(before, [{ n: GOOGLE_PENDING_FLOW_CAP }]);
    const busy = await call('GET', `/api/auth/google/start?client=native&code_challenge=${challenge}`);
    assert.equal(busy.status, 503, busy.text);
    assert.equal(busy.json?.code, 'GOOGLE_SIGN_IN_BUSY');
    assert.equal(busy.setCookie, null);
    assert.deepEqual(await rows(`SELECT count(*)::int AS n FROM oauth_login_flow WHERE status = 'PENDING'`), before, 'nothing was written');
    // A flow that ends makes room for the next start.
    await sql.query(`UPDATE oauth_login_flow SET expires_at = now() - interval '1 second' WHERE id = (SELECT id FROM oauth_login_flow WHERE status = 'PENDING' LIMIT 1)`);
    assert.equal((await call('GET', `/api/auth/google/start?client=web&code_challenge=${challenge}`)).status, 302);
    await sql.query('DELETE FROM oauth_login_flow');
  });

  await t.test('(6) deleting a user deletes their Google identity and the LINK flows naming them, and nothing else', async () => {
    const leaving = randomUUID();
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'Leaving', 'x')`, [leaving, `leaving-${RUN}@flow.invalid`]);
    await sql.query(`INSERT INTO user_identity (id, user_id, provider, subject, email) VALUES (gen_random_uuid(), $1, 'google', $2, 'l@gmail.com')`, [leaving, `leaving-${RUN}`]);
    const flow = (intent: string, user: string | null) => sql.query(
      `INSERT INTO oauth_login_flow (id, provider, intent, client, state_hash, binding_hash, nonce, provider_code_verifier, client_challenge, link_user_id, expires_at)
       VALUES (gen_random_uuid(), 'google', $1, 'WEB', gen_random_uuid()::text, 'b', 'n', 'v', 'c', $2, now() + interval '5 minutes')`,
      [intent, user],
    );
    await flow('LINK', leaving);
    await flow('LINK', admin.id);
    await flow('LOGIN', null);
    await sql.query('DELETE FROM "user" WHERE id = $1', [leaving]);
    assert.deepEqual(await rows('SELECT user_id FROM user_identity ORDER BY user_id'), [{ user_id: admin.id }]);
    assert.deepEqual(
      await rows('SELECT intent, link_user_id FROM oauth_login_flow ORDER BY intent'),
      [{ intent: 'LINK', link_user_id: admin.id }, { intent: 'LOGIN', link_user_id: null }],
    );
  });
});
