/**
 * The welcome email (docs/welcome-email-design.md) against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty: the real AuthService, GoogleLoginService, AdminController,
 * AdminEmailController, EmailSettingsService and EmailOutboxWorker over that database, behind the global
 * pipe, interceptors and filters main.ts installs. Google is the in-process fake
 * (test-support/fake-google.ts), and Resend is a fake HTTP server this spec runs, reached through
 * ORBIT_RESEND_API_URL. Nothing reaches the network. What it is held to:
 *
 *   (1) 0516 and 0517: the columns and constraints, and both run again without changing anything;
 *   (2) the first administrator /setup creates gets no welcome email (D3);
 *   (3) an unconfigured channel: a Google sign-up writes one SKIPPED row, and nothing is sent;
 *   (4) Admin → Email: PUT saves, GET never answers the key; then a Google sign-up is ONE request to the
 *       fake Resend, whose HTML and plain-text bodies say what §3.4 says; the row is SENT with Resend's
 *       id and an EMAIL_SENT Activity row; another pass sends nothing;
 *   (5) first sign-ins of one Google account at once, made to meet at their INSERT: one outbox row;
 *   (6) accounts an administrator creates: "{admin} added you", password and passwordless; a password
 *       reset writes nothing;
 *   (7) retries: 1 min, 10 min, 1 h, then FAILED with EMAIL_FAILED; an answered failure moves the
 *       Idempotency-Key on, an unanswered one keeps it; 422 is FAILED at once; GET /admin/users answers
 *       `welcomeEmail`; Send welcome email resends under a new generation, and is refused while email is off;
 *   (8) two workers draining at once never send one email twice;
 *   (9) a key PROVIDER_SECRET_KEY can no longer decrypt: the page says so, and rows wait, spending no attempt.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/email/welcome-email.pg.spec.ts
 */
process.env.PROVIDER_SECRET_KEY = `welcome-email-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { GoogleAuthController } from '../auth/google-auth.controller';
import { GoogleLoginService } from '../auth/google-login.service';
import { GoogleOAuthClient, s256 } from '../auth/google-oauth.client';
import { PatService } from '../auth/pat.service';
import { SignInProvidersService } from '../auth/sign-in-providers.service';
import { generateToken } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { MANAGED_RUNNERS_OFF } from '../managed-runners/managed-runner-gate';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { FakeGoogle, type FakeGoogleAccount } from '../test-support/fake-google';
import { AdminController } from '../users/admin.controller';
import { AdminEmailController, EMAIL_NOT_CONFIGURED } from './admin-email.controller';
import { EMAIL_FAILED_ACTIVITY, EMAIL_SENT_ACTIVITY, EmailOutboxWorker } from './email-outbox';
import { EmailSettingsService } from './email-settings.service';
import { RESEND_API_URL_ENV } from './resend.client';
import { renderWelcomeEmail } from './welcome-email.template';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CLIENT_ID = `1234-${RUN}.apps.googleusercontent.com`;
const CLIENT_SECRET = `GOCSPX-${RUN}-welcome`;
const RESEND_KEY = `re_${RUN}_secret_key`;
const FROM = 'Orbit <orbit@example.test>';
const migration = (name: string) => readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  location: string | null;
  setCookie: string | null;
}

/** One request the fake Resend received. */
interface ResendRequest {
  headers: IncomingHttpHeaders;
  body: { from: string; to: string[]; reply_to?: string; subject: string; html: string; text: string };
}

/** How the fake answers the next requests: an HTTP status, `drop` (the socket closed, no answer) or `slow` (200 after 300 ms). */
type ResendMode = number | 'drop' | 'slow';

test('welcome email on PostgreSQL: 0516/0517, sign-up and admin-created accounts, retries, resend, two workers', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db = prismaClientFor(url);
  const db2 = prismaClientFor(url);
  const google = new FakeGoogle(CLIENT_ID, CLIENT_SECRET);

  // The fake Resend.
  const received: ResendRequest[] = [];
  let mode: ResendMode = 200;
  /** The id the fake answered last: a UUID, as Resend's are. */
  let lastId = '';
  const resend = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      if (mode === 'drop') return void req.socket.destroy();
      const answer = (status: number) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 200 ? JSON.stringify({ id: (lastId = randomUUID()) }) : JSON.stringify({ statusCode: status, name: 'error', message: `fake says ${status}` }));
      };
      if (mode === 'slow') setTimeout(() => answer(200), 300);
      else answer(mode);
    });
  });
  await new Promise<void>((resolve) => resend.listen(0, '127.0.0.1', resolve));
  process.env[RESEND_API_URL_ENV] = `http://127.0.0.1:${(resend.address() as AddressInfo).port}/emails`;

  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close();
    resend.closeAllConnections();
    resend.close();
    await db.$disconnect().catch(() => undefined);
    await db2.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  await t.test('(1) 0516 and 0517: the columns and constraints, and both run again unchanged', async () => {
    const shape = async (table: string) => (await rows(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table],
    )).map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    const constraints = async (table: string) => (await rows(
      `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`, [`"${table}"`],
    )).map((c) => c.conname);
    const settings = [
      'id int2 NOT NULL', 'enabled bool NOT NULL', 'resend_api_key_enc text NOT NULL', 'from_address text NOT NULL',
      'reply_to text NOT NULL', 'welcome_enabled bool NOT NULL', 'updated_by_id uuid NULL', 'updated_at timestamptz NOT NULL',
    ];
    const outbox = [
      'id uuid NOT NULL', 'kind text NOT NULL', 'user_id uuid NOT NULL', 'to_address text NOT NULL', 'created_by_id uuid NULL',
      'status text NOT NULL', 'attempts int4 NOT NULL', 'generation int4 NOT NULL', 'key_attempt int4 NOT NULL',
      'next_attempt_at timestamptz NOT NULL', 'last_error text NULL', 'last_attempt_at timestamptz NULL',
      'provider_message_id text NULL', 'sent_at timestamptz NULL', 'created_at timestamptz NOT NULL', 'updated_at timestamptz NOT NULL',
    ];
    assert.deepEqual(await shape('email_settings'), settings);
    assert.deepEqual(await shape('email_outbox'), outbox);
    assert.deepEqual(await constraints('email_settings'), ['email_settings_one_row_chk', 'email_settings_pkey']);
    assert.deepEqual(await constraints('email_outbox'), ['email_outbox_kind_chk', 'email_outbox_pkey', 'email_outbox_status_chk', 'email_outbox_user_id_fkey']);
    const unique = await rows(`SELECT indexdef FROM pg_indexes WHERE indexname = 'email_outbox_kind_user_id_key'`);
    assert.match(unique[0].indexdef, /UNIQUE INDEX .* \(kind, user_id\)/);
    await sql.query(migration('0516_email_settings'));
    await sql.query(migration('0517_email_outbox'));
    assert.deepEqual(await shape('email_settings'), settings, 'a second run changes nothing');
    assert.deepEqual(await shape('email_outbox'), outbox);
    await assert.rejects(sql.query(`INSERT INTO email_settings (id) VALUES (2)`), { constraint: 'email_settings_one_row_chk' });
  });

  @Module({
    controllers: [AuthController, GoogleAuthController, AdminController, AdminEmailController],
    providers: [
      AuthService,
      PatService,
      SignInProvidersService,
      GoogleLoginService,
      EmailSettingsService,
      { provide: GoogleOAuthClient, useValue: new GoogleOAuthClient(google.fetch) },
      { provide: JwtService, useValue: new JwtService({ secret: `welcome-${RUN}`, signOptions: { expiresIn: '7d' } }) },
      { provide: PrismaService, useValue: db },
    ],
  })
  class WelcomeEmailHarness {}
  app = await NestFactory.create(WelcomeEmailHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const signInProviders = new SignInProvidersService(db as unknown as PrismaService);
  const settingsOf = (client: unknown) => new EmailSettingsService(client as PrismaService);
  const worker = new EmailOutboxWorker(db as unknown as PrismaService, settingsOf(db), { loop: false }, MANAGED_RUNNERS_OFF);
  const worker2 = new EmailOutboxWorker(db2 as unknown as PrismaService, settingsOf(db2), { loop: false }, MANAGED_RUNNERS_OFF);

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
  const signUp = async (account: FakeGoogleAccount) => {
    const answer = await exchange(await ticketFor(account));
    assert.equal(answer.status, 201, answer.text);
    return toUuid(answer.json.user.id);
  };
  const outboxOf = async (userId: string) => rows(
    `SELECT status, to_address, created_by_id, attempts, generation, key_attempt, last_error, provider_message_id,
            sent_at IS NOT NULL AS sent FROM email_outbox WHERE user_id = $1`, [userId],
  );
  const activityOf = async (type: string, userId: string) => rows(
    `SELECT actor_id, payload FROM activity WHERE type = $1 AND payload->>'userId' = $2 ORDER BY id`, [type, userId],
  );
  const admin = { id: '', token: '', email: `admin-${RUN}@welcome.example.test` };
  let n = 0;
  const person = (name = 'Maya Chen'): FakeGoogleAccount => ({ sub: `sub-${RUN}-${(n += 1)}`, email: `p${n}-${RUN}@example.test`, name });

  await t.test('(2) the first administrator /setup creates gets no welcome email', async () => {
    const bootstrap = await call('POST', '/api/auth/bootstrap', { body: { email: admin.email, name: 'Alex Rivera', password: `pw-${RUN}` } });
    assert.equal(bootstrap.status, 201, bootstrap.text);
    admin.id = toUuid(bootstrap.json.user.id);
    admin.token = bootstrap.json.accessToken;
    assert.deepEqual(await outboxOf(admin.id), []);
    await signInProviders.updateGoogle(admin.id, { enabled: true, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signupPolicy: 'OPEN' });
  });

  await t.test('(3) unconfigured: a Google sign-up writes one SKIPPED row, and nothing is sent', async () => {
    const id = await signUp(person());
    assert.deepEqual((await outboxOf(id)).map((r) => r.status), ['SKIPPED']);
    assert.equal(await worker.drain(), 0);
    assert.equal(received.length, 0);
    const view = await call('GET', '/api/admin/email', { bearer: admin.token });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json.on, false);
    assert.deepEqual(view.json.missing, ['SWITCH', 'API_KEY', 'FROM']);
    assert.equal(view.json.welcomeEnabled, true, 'the welcome toggle defaults to on');
    assert.equal(view.json.replyToDefault, admin.email, 'Reply-To defaults to the earliest administrator');
    // Send welcome email is refused while email is off.
    const refused = await call('POST', `/api/admin/users/${id}/welcome-email`, { bearer: admin.token });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.message, EMAIL_NOT_CONFIGURED);
  });

  let googleUser = '';
  await t.test('(4) configured: a Google sign-up is ONE request to the fake Resend, with the §3.4 content', async () => {
    const put = await call('PUT', '/api/admin/email', {
      bearer: admin.token,
      body: { enabled: true, apiKey: ` ${RESEND_KEY} `, fromAddress: FROM, replyTo: '', welcomeEnabled: true },
    });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.on, true);
    assert.equal(put.json.hasApiKey, true);
    assert.ok(!put.text.includes(RESEND_KEY), 'the key never comes back');
    const stored = await rows('SELECT resend_api_key_enc FROM email_settings');
    assert.ok(!stored[0].resend_api_key_enc.includes(RESEND_KEY), 'the key is stored encrypted');
    // Send test email answers what Resend said, its UUID id verbatim (not rewritten as a public id); nothing is written.
    const outboxBefore = await rows('SELECT count(*)::int AS n FROM email_outbox');
    const sent = await call('POST', '/api/admin/email/test', { bearer: admin.token });
    assert.equal(sent.status, 200, sent.text);
    assert.deepEqual(sent.json, { ok: true, to: admin.email, resendId: lastId });
    assert.equal(received.at(-1)!.body.subject, 'Orbit test email');
    assert.deepEqual(await rows('SELECT count(*)::int AS n FROM email_outbox'), outboxBefore);
    mode = 403;
    const refused = await call('POST', '/api/admin/email/test', { bearer: admin.token });
    assert.deepEqual(refused.json, { ok: false, to: admin.email, status: 403, error: 'fake says 403' });
    mode = 200;
    // A save without a key keeps the saved one.
    const again = await call('PUT', '/api/admin/email', { bearer: admin.token, body: { enabled: true, fromAddress: FROM, replyTo: '', welcomeEnabled: true } });
    assert.equal(again.json.hasApiKey, true);

    received.length = 0;
    const maya: FakeGoogleAccount = { sub: `maya-${RUN}`, email: `maya-${RUN}@example.test`, name: 'Maya Chen' };
    googleUser = await signUp(maya);
    assert.deepEqual((await outboxOf(googleUser)).map((r) => r.status), ['PENDING']);
    assert.equal(await worker.drain(), 1);
    assert.equal(received.length, 1, 'exactly one request to Resend');
    const [request] = received;
    assert.equal(request.headers.authorization, `Bearer ${RESEND_KEY}`);
    assert.equal(request.headers['idempotency-key'], `welcome/${googleUser}/0/0`);
    assert.equal(request.body.from, FROM);
    assert.deepEqual(request.body.to, [maya.email]);
    assert.equal(request.body.reply_to, admin.email);
    const expected = renderWelcomeEmail({
      firstName: 'Maya', email: maya.email, origin: 'https://orbit.example.test', signIn: { kind: 'GOOGLE_SIGNUP' }, managedRunner: false,
    });
    assert.equal(request.body.subject, 'Welcome to Orbit, Maya');
    assert.equal(request.body.html, expected.html);
    assert.equal(request.body.text, expected.text);
    // §3.4, item by item, in the plain text.
    for (const line of [
      `Hi Maya, an account for ${maya.email} is open on orbit.example.test. Sign in with Google, using that same address.`,
      'Open Orbit: https://orbit.example.test',
      '1. Connect a computer',
      '2. Start your first session',
      '3. Keep an eye on it from anywhere',
      `You are receiving this one-time email because an account was created for ${maya.email} on orbit.example.test.`,
    ]) assert.ok(request.body.text.includes(line), `the text says: ${line}`);
    assert.match(request.body.html, /href="https:\/\/orbit\.example\.test"[^>]*>Open Orbit<\/a>/);
    assert.doesNotMatch(request.body.text + request.body.html, /Get the apps|\/dl/);

    const [row] = await outboxOf(googleUser);
    assert.equal(row.status, 'SENT');
    assert.equal(row.provider_message_id, lastId);
    assert.equal(row.sent, true);
    assert.equal((await activityOf(EMAIL_SENT_ACTIVITY, googleUser)).length, 1);
    assert.equal(await worker.drain(), 0, 'nothing left to send');
    assert.equal(received.length, 1);
    // A SENT row is never sent again by hand either: it is answered as it is.
    const resent = await call('POST', `/api/admin/users/${googleUser}/welcome-email`, { bearer: admin.token });
    assert.equal(resent.json.status, 'SENT');
  });

  await t.test('(5) first sign-ins of one Google account at once: one account, one outbox row', async () => {
    const racer = person('Race Runner');
    const tickets = [];
    for (let i = 0; i < 5; i += 1) tickets.push(await ticketFor(racer));
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "user" IN SHARE MODE');
      const answers = Promise.all(tickets.map(exchange));
      const waiting = async () => (await rows(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'relation' AND relation = '"user"'::regclass AND NOT granted`,
      ))[0].n;
      for (let i = 0; i < 200 && (await waiting()) < tickets.length; i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.equal(await waiting(), tickets.length, 'every exchange waits at its INSERT');
      await holder.query('COMMIT');
      const done = await answers;
      const ids = new Set(done.map((a) => (a.status === 201 ? toUuid(a.json.user.id) : `refused ${a.status} ${a.text}`)));
      assert.equal(ids.size, 1, [...ids].join(', '));
      const [id] = [...ids];
      assert.deepEqual((await rows(`SELECT count(*)::int AS n FROM email_outbox WHERE to_address = $1`, [racer.email]))[0].n, 1);
      assert.deepEqual((await outboxOf(id)).map((r) => r.status), ['PENDING']);
    } finally {
      await holder.end().catch(() => undefined);
    }
    await worker.drain();
  });

  await t.test('(6) accounts an administrator creates: "{admin} added you", with and without a password; a reset writes nothing', async () => {
    const create = (body: object) => call('POST', '/api/admin/users', { bearer: admin.token, body });
    const withPassword = await create({ email: `pw-${RUN}@example.test`, name: 'Jordan Lee' });
    assert.equal(withPassword.status, 201, withPassword.text);
    const passwordless = await create({ email: `pl-${RUN}@example.test`, name: 'Sam Park', passwordless: true });
    assert.equal(passwordless.status, 201, passwordless.text);
    const pwId = toUuid(withPassword.json.id);
    const plId = toUuid(passwordless.json.id);
    assert.equal((await outboxOf(pwId))[0].created_by_id, admin.id);
    received.length = 0;
    assert.equal(await worker.drain(), 2);
    const byTo = new Map(received.map((r) => [r.body.to[0], r.body]));
    assert.match(byTo.get(`pw-${RUN}@example.test`)!.text, /Alex Rivera added you to Orbit\. Sign in with this email address and the password Alex Rivera gave you\./);
    assert.match(byTo.get(`pl-${RUN}@example.test`)!.text, /Alex Rivera added you to Orbit\. Sign in with Google, using this address\./);
    assert.equal(byTo.get(`pw-${RUN}@example.test`)!.subject, 'Welcome to Orbit, Jordan');
    for (const body of byTo.values()) assert.ok(!body.text.includes(withPassword.json.generatedPassword), 'never the password');
    const reset = await create({ email: `pw-${RUN}@example.test`, force: true });
    assert.equal(reset.status, 201, reset.text);
    assert.equal((await rows(`SELECT count(*)::int AS n FROM email_outbox WHERE user_id = $1`, [pwId]))[0].n, 1);
    assert.deepEqual((await outboxOf(plId)).map((r) => r.status), ['SENT']);
  });

  await t.test('(7) retries 1 min / 10 min / 1 h, then FAILED; keys; 422 at once; welcomeEmail on the list; Send welcome email', async () => {
    const id = await signUp(person('Rita Retry'));
    const t0 = new Date(Date.now() + 1_000);
    const at = (ms: number) => () => new Date(t0.getTime() + ms);
    received.length = 0;
    mode = 503;
    assert.equal(await worker.drain(at(0)), 1);
    let [row] = await outboxOf(id);
    assert.deepEqual([row.status, row.attempts, row.key_attempt, row.last_error], ['PENDING', 1, 1, '503 fake says 503']);
    assert.equal(await worker.drain(at(59_000)), 0, 'not due before a minute');
    // An unanswered attempt (the socket closed) keeps its key: it may have been sent.
    mode = 'drop';
    assert.equal(await worker.drain(at(60_000)), 1);
    [row] = await outboxOf(id);
    assert.deepEqual([row.attempts, row.key_attempt], [2, 1]);
    assert.equal(await worker.drain(at(60_000 + 599_000)), 0, 'not due before ten minutes');
    mode = 503;
    assert.equal(await worker.drain(at(60_000 + 600_000)), 1);
    [row] = await outboxOf(id);
    assert.deepEqual([row.status, row.attempts], ['PENDING', 3]);
    assert.equal(await worker.drain(at(660_000 + 3_599_000)), 0, 'not due before an hour');
    assert.equal(await worker.drain(at(660_000 + 3_600_000)), 1);
    [row] = await outboxOf(id);
    assert.deepEqual([row.status, row.attempts, row.last_error], ['FAILED', 4, '503 fake says 503']);
    assert.deepEqual(received.map((r) => r.headers['idempotency-key']), [
      `welcome/${id}/0/0`, `welcome/${id}/0/1`, `welcome/${id}/0/1`, `welcome/${id}/0/2`,
    ]);
    const failed = await activityOf(EMAIL_FAILED_ACTIVITY, id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].payload.error, '503 fake says 503');
    assert.equal(await worker.drain(at(10 * 3_600_000)), 0, 'a FAILED row is not tried again');

    // 422: FAILED at once.
    const bad = await signUp(person('Ivy Invalid'));
    mode = 422;
    await worker.drain(at(10 * 3_600_000));
    assert.deepEqual((await outboxOf(bad)).map((r) => [r.status, r.attempts]), [['FAILED', 1]]);

    // The list answers welcomeEmail; an account from before the outbox answers null.
    const list = await call('GET', '/api/admin/users', { bearer: admin.token });
    const of = (uid: string) => list.json.find((u: { id: string }) => toUuid(u.id) === uid);
    assert.equal(of(id).welcomeEmail.status, 'FAILED');
    assert.equal(of(id).welcomeEmail.lastError, '503 fake says 503');
    assert.ok(of(id).welcomeEmail.lastAttemptAt);
    assert.equal(of(admin.id).welcomeEmail, null);

    // Send welcome email: back to PENDING under a new generation, and it goes out.
    mode = 200;
    received.length = 0;
    const resent = await call('POST', `/api/admin/users/${id}/welcome-email`, { bearer: admin.token });
    assert.equal(resent.status, 200, resent.text);
    assert.deepEqual(resent.json, { status: 'PENDING' });
    [row] = await outboxOf(id);
    assert.deepEqual([row.status, row.attempts, row.generation, row.key_attempt], ['PENDING', 0, 1, 0]);
    assert.equal(await worker.drain(), 1, 'the resent row; the 422 one stays FAILED');
    assert.equal(received.length, 1);
    assert.equal(received[0].headers['idempotency-key'], `welcome/${id}/1/0`);
    assert.equal((await outboxOf(id))[0].status, 'SENT');
  });

  await t.test('(8) two workers draining at once never send one email twice', async () => {
    const people = [];
    for (let i = 0; i < 6; i += 1) people.push(await signUp(person(`Twin ${i}`)));
    received.length = 0;
    mode = 'slow';
    const [a, b] = await Promise.all([worker.drain(), worker2.drain()]);
    mode = 200;
    assert.equal(a + b, 6);
    assert.ok(a > 0 && b > 0, `both workers sent: ${a} and ${b}`);
    assert.equal(received.length, 6, 'six requests for six accounts');
    assert.equal(new Set(received.map((r) => r.body.to[0])).size, 6, 'each account once');
    for (const id of people) {
      assert.deepEqual((await outboxOf(id)).map((r) => r.status), ['SENT']);
      assert.equal((await activityOf(EMAIL_SENT_ACTIVITY, id)).length, 1);
    }
  });

  await t.test('(9) a key PROVIDER_SECRET_KEY can no longer decrypt: the page says so, and rows wait spending no attempt', async () => {
    const id = await signUp(person('Una Readable'));
    const key = process.env.PROVIDER_SECRET_KEY;
    process.env.PROVIDER_SECRET_KEY = `rotated-${RUN}`;
    try {
      const view = await call('GET', '/api/admin/email', { bearer: admin.token });
      assert.equal(view.json.apiKeyUnreadable, true);
      assert.equal(view.json.on, false);
      received.length = 0;
      assert.equal(await worker.drain(), 0);
      assert.equal(received.length, 0);
      assert.deepEqual((await outboxOf(id)).map((r) => [r.status, r.attempts]), [['PENDING', 0]]);
    } finally {
      process.env.PROVIDER_SECRET_KEY = key;
    }
    assert.equal(await worker.drain(), 1);
  });

  await t.test('the welcome toggle off: a new account is SKIPPED, and Send welcome email sends it', async () => {
    await call('PUT', '/api/admin/email', { bearer: admin.token, body: { enabled: true, fromAddress: FROM, replyTo: 'help@example.test', welcomeEnabled: false } });
    const id = await signUp(person('Tom Toggle'));
    assert.deepEqual((await outboxOf(id)).map((r) => r.status), ['SKIPPED']);
    received.length = 0;
    assert.equal(await worker.drain(), 0);
    const resent = await call('POST', `/api/admin/users/${id}/welcome-email`, { bearer: admin.token });
    assert.deepEqual(resent.json, { status: 'PENDING' });
    assert.equal(await worker.drain(), 1);
    assert.equal(received[0].body.reply_to, 'help@example.test');
  });
});
