/**
 * A push registration ends with the login session that made it (docs/push-login-session-design.md),
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/push/push-login-session.pg.spec.ts
 *
 * It signs in through AuthService, registers through JwtAuthGuard and PushController, and pushes
 * through PushService with only its APNs and FCM transports replaced:
 *
 *   (1) 0425 gave refresh_token and device_token a nullable uuid login_session_id, indexed on
 *       refresh_token;
 *   (2) a sign-in starts a session that its refresh token, its access token (`sid`) and the
 *       registrations made with it name, and their devices are pushed to, also after a rotation;
 *   (3) signing out stops the pushes to the devices registered in that session, and only those;
 *   (4) so does the session expiring;
 *   (5) and a sign-out that lands while an FCM send is in flight stops that send;
 *   (6) reuse detection ends the replayed token's session and stops its devices, and only those: the
 *       account's other sessions stand, a token from before sessions ends none, and a row registered
 *       with an access token from before sessions is pushed to throughout;
 *   (7) registering again under a new sign-in brings a device back.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Client } from 'pg';
import { AuthService } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { hashPassword, sha256 } from '../common/crypto.util';
import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import type { RegisterDeviceTokenDto } from './dto';

const url = process.env.COORDINATOR_PG_URL;
const PASSWORD = 'push-login-session-test-only';

type Issued = Awaited<ReturnType<AuthService['login']>>;

test('a push registration ends with the login session that made it', { skip: !url, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url!);
  t.after(async () => { await db.$disconnect(); await sql.end(); });
  const user = await db.user.create({ data: {
    email: `push-session-${randomUUID()}@example.invalid`, name: 'Push session', passwordHash: hashPassword(PASSWORD),
  } });
  t.after(async () => { await db.user.deleteMany({ where: { id: user.id } }); });

  const jwt = new JwtService({ secret: `push-login-session-${randomUUID()}`, signOptions: { expiresIn: '7d' } });
  const auth = new AuthService(db as never, jwt, {} as never);
  const guard = new JwtAuthGuard(jwt, {} as never);
  const ctrl = new PushController(db as never);
  const signIn = () => auth.login(user.email, PASSWORD);
  /** The request's user, as JwtAuthGuard makes it from this bearer. */
  const caller = async (accessToken: string): Promise<AuthUser> => {
    const req: Record<string, unknown> = { headers: { authorization: `Bearer ${accessToken}` }, query: {} };
    await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
    return req.user as AuthUser;
  };
  const register = async (accessToken: string, dto: RegisterDeviceTokenDto) => ctrl.register(await caller(accessToken), dto);
  const ios = (token: string) => ({ token, bundleId: 'io.orbitd.app' });
  const android = { platform: 'android', token: 'fcm-c', bundleId: 'io.orbitd.android', installationId: randomUUID() };
  const sessionOf = async (refreshToken: string) =>
    (await db.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(refreshToken) } })).loginSessionId;
  const sid = (accessToken: string) => (jwt.decode(accessToken) as { sid?: string }).sid;

  const values: Record<string, string> = {
    APNS_KEY_ID: 'test', APNS_TEAM_ID: 'test', APNS_KEY: Buffer.from('test-only').toString('base64'),
    FCM_PROJECT_ID: 'isolated', FCM_CLIENT_EMAIL: 'test@example.invalid',
    FCM_PRIVATE_KEY: Buffer.from('test-only').toString('base64'),
  };
  const push = new PushService(db as never, { get: (k: string) => values[k] } as never);
  const sent: string[] = [];
  let inFlight: (() => Promise<unknown>) | undefined;
  (push as any).authToken = () => 'test';
  (push as any).send = async (_host: string, token: string) => { sent.push(token); return { status: 200 }; };
  // As FcmTransport does: the registration is checked again right before the request goes out.
  (push as any).fcm.send = async (token: string, _data: unknown, isCurrent: () => Promise<boolean>) => {
    await inFlight?.();
    if (!await isCurrent()) return { accepted: false, invalidToken: false, reason: 'REGISTRATION_CHANGED' };
    sent.push(token);
    return { accepted: true, invalidToken: false };
  };
  /** The devices one push to the account reaches: an agent's message, sent to every device it has. */
  const pushedTo = async () => {
    sent.length = 0;
    // Its one-a-minute limit is not under test: the account's turn, which a notify naming no session takes, given back.
    await sql.query(`UPDATE "user" SET "agent_notified_at" = NULL WHERE "id" = $1::uuid`, [user.id]);
    await push.notifyAgentMessage({ ownerId: user.id, fallbackTitle: 'Orbit', message: 'Check in' });
    return [...sent].sort();
  };

  await t.test('(1) 0425 gave refresh_token and device_token a nullable uuid login_session_id, indexed on refresh_token', async () => {
    const columns = await sql.query(`SELECT table_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'login_session_id'
      ORDER BY table_name`);
    assert.deepEqual(columns.rows, [
      { table_name: 'device_token', data_type: 'uuid', is_nullable: 'YES', column_default: null },
      { table_name: 'refresh_token', data_type: 'uuid', is_nullable: 'YES', column_default: null },
    ]);
    const index = await sql.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'refresh_token_login_session_id_idx'`);
    assert.equal(index.rows.length, 1);
    assert.match(index.rows[0].indexdef, /ON \S*refresh_token USING btree \(login_session_id\)$/);
  });

  let a: Issued;
  let b: Issued;
  let c: Issued;
  await t.test('(2) a sign-in starts a session its tokens and registrations name; its devices are pushed to, also after a rotation', async () => {
    a = await signIn();
    const session = await sessionOf(a.refreshToken);
    assert.ok(session);
    assert.equal(sid(a.accessToken), session);
    assert.deepEqual((await caller(a.accessToken)).credential, { kind: 'LOGIN', loginSessionId: session });
    await register(a.accessToken, ios('apns-a'));
    assert.equal((await db.deviceToken.findUniqueOrThrow({ where: { token: 'apns-a' } })).loginSessionId, session);

    b = await signIn();
    assert.notEqual(await sessionOf(b.refreshToken), session);
    await register(b.accessToken, ios('apns-b'));
    c = await signIn();
    await register(c.accessToken, android);
    assert.equal((await db.deviceToken.findUniqueOrThrow({ where: { token: 'fcm-c' } })).loginSessionId, sid(c.accessToken));
    // An access token signed before sessions, as {sub, email}: it authenticates, and names none.
    const before = await jwt.signAsync({ sub: user.id, email: user.email });
    assert.deepEqual((await caller(before)).credential, { kind: 'LOGIN' });
    await register(before, ios('apns-legacy'));
    assert.equal((await db.deviceToken.findUniqueOrThrow({ where: { token: 'apns-legacy' } })).loginSessionId, null);
    assert.deepEqual(await pushedTo(), ['apns-a', 'apns-b', 'apns-legacy', 'fcm-c']);

    const rotated = await auth.refresh(a.refreshToken);
    assert.equal(await sessionOf(rotated.refreshToken), session);
    assert.equal(sid(rotated.accessToken), session);
    a = rotated;
    assert.deepEqual(await pushedTo(), ['apns-a', 'apns-b', 'apns-legacy', 'fcm-c']);
  });

  await t.test('(3) signing out stops the pushes to the devices registered in that session, and only those', async () => {
    await auth.logout(a.refreshToken);
    assert.deepEqual(await pushedTo(), ['apns-b', 'apns-legacy', 'fcm-c']);
    // Left out, not deleted: the row waits for the device to register again.
    assert.equal(await db.deviceToken.count({ where: { token: 'apns-a' } }), 1);
    // The ended session's access token still authenticates; a registration made with it names that
    // session, so it receives nothing either.
    await register(a.accessToken, ios('apns-a'));
    assert.deepEqual(await pushedTo(), ['apns-b', 'apns-legacy', 'fcm-c']);
  });

  await t.test('(4) so does the session expiring, as 30 days without a refresh leave it', async () => {
    await sql.query(`UPDATE refresh_token SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
      [sha256(b.refreshToken)]);
    await assert.rejects(auth.refresh(b.refreshToken), /refresh token expired/);
    assert.deepEqual(await pushedTo(), ['apns-legacy', 'fcm-c']);
  });

  await t.test('(5) a sign-out that lands while an FCM send is in flight stops that send', async () => {
    inFlight = () => auth.logout(c.refreshToken);
    try {
      assert.deepEqual(await pushedTo(), ['apns-legacy']);
    } finally {
      inFlight = undefined;
    }
    assert.deepEqual(await pushedTo(), ['apns-legacy']);
  });

  await t.test('(6) reuse detection ends the replayed token\'s session, and only that one; a row registered before sessions is pushed to throughout', async () => {
    const d = await signIn();
    const e = await signIn();
    await register(d.accessToken, ios('apns-d'));
    await register(e.accessToken, ios('apns-e'));
    const rotated = await auth.refresh(d.refreshToken);
    assert.deepEqual(await pushedTo(), ['apns-d', 'apns-e', 'apns-legacy']);
    await assert.rejects(auth.refresh(d.refreshToken), /refresh token reuse detected/);
    // The token it rotated into is revoked with it, and presented in turn ends nothing more.
    await assert.rejects(auth.refresh(rotated.refreshToken), /refresh token reuse detected/);
    assert.deepEqual(await pushedTo(), ['apns-e', 'apns-legacy']);
    // The other sign-in stands: its next refresh works, in its session.
    const next = await auth.refresh(e.refreshToken);
    assert.equal(sid(next.accessToken), sid(e.accessToken));
    // A token from before sessions names none to end: refused, and nothing revoked.
    const legacy = `legacy-${randomUUID()}`;
    await db.refreshToken.create({ data: {
      userId: user.id, tokenHash: sha256(legacy), expiresAt: new Date(Date.now() + 86_400_000), revokedAt: new Date(),
    } });
    await assert.rejects(auth.refresh(legacy), /refresh token reuse detected/);
    assert.equal((await db.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(next.refreshToken) } })).revokedAt, null);
    assert.deepEqual(await pushedTo(), ['apns-e', 'apns-legacy']);
  });

  await t.test('(7) registering again under a new sign-in brings a device back', async () => {
    const f = await signIn();
    const row = await db.deviceToken.findUniqueOrThrow({ where: { token: 'apns-a' } });
    await register(f.accessToken, ios('apns-a'));
    const rebound = await db.deviceToken.findUniqueOrThrow({ where: { token: 'apns-a' } });
    assert.equal(rebound.id, row.id);
    assert.equal(rebound.loginSessionId, await sessionOf(f.refreshToken));
    // Android's next registration for the installation replaces the signed-out binding.
    const { registrationKey } = await register(f.accessToken, { ...android, token: 'fcm-f' });
    assert.equal((await db.deviceToken.findMany({ where: { installationId: android.installationId } }))
      .map((r) => r.id).join(), registrationKey);
    assert.deepEqual(await pushedTo(), ['apns-a', 'apns-e', 'apns-legacy', 'fcm-f']);
  });
});
