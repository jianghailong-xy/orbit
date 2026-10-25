/**
 * The runner link's connection tokens through the production apiserver — `build/main.js`, the whole
 * AppModule — against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty
 * (migration 0443, docs/runner-link-design.md §5.4 and §6.2). What it is held to:
 *
 *   (1) 0443 made what it describes: `tenant_cell` and `runner_link_revocation` with their columns,
 *       nullability, CHECKs and indexes, the cascade from `user`, and the trigger on `runner`;
 *   (2) POST /api/runner/link-token issues a token a verifier holding only the public key accepts,
 *       naming the runner, its tenant, cell-1 and its address, the asking process and the credential
 *       that asked; the tenant is placed in the directory once, even when its first requests race;
 *       a request without a process identity, or without a valid runner token, is refused;
 *   (3) the token expires an hour after it was issued;
 *   (4) revocation: rotating a runner's token on the Runners page, registering it again under its
 *       name, `orbit unregister` and deleting it on the Runners page each revoke the credential it
 *       had — the fingerprint the trigger records is the `credential` the tokens minted with it carry,
 *       so the gateway refuses them — while a token minted with the new credential stays good; a write
 *       of the row that leaves the credential alone records nothing; a credential that becomes the
 *       runner's again comes off the list; and only the gateway's secret reads the list;
 *   (5) the list reaches back a token's lifetime and ten minutes, and the reaper's purge deletes what
 *       is older and nothing newer;
 *   (6) with a setting missing the link is off: both routes answer 404 RUNNER_LINK_NOT_CONFIGURED,
 *       and the log says which setting.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-token.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ReaperService } from '../realtime/reaper.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  RUNNER_LINK_NOT_CONFIGURED,
  RUNNER_LINK_REVOCATION_WINDOW_MS,
  RunnerLinkTokenRefused,
  runnerLinkCredential,
  verifyRunnerLinkToken,
  type RunnerLinkClaims,
} from './runner-link-token';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const LINK_URL = 'wss://link.runner-link-spec.invalid/v1';
const GATEWAY_TOKEN = randomBytes(32).toString('base64');

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const runnerToken = () => randomBytes(32).toString('base64url');

interface Revocation {
  credential: string;
  revokedAt: string;
}

test('runner link tokens: issued for an hour, revoked with the credential that minted them, refused once revoked', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-link-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(privateKey);
  const signingKey = Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs8' }) as string).toString('base64');
  let server: Apiserver | null = null;
  let off: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await off?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  async function user(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@runner-link-token.invalid`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, email, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runnerOf(owner: { id: string }, name: string) {
    const id = randomUUID();
    const token = runnerToken();
    await db.runner.create({ data: { id, ownerId: owner.id, name: `${name}-${RUN}`, tokenHash: sha256(token) } });
    return { id, name: `${name}-${RUN}`, token };
  }
  const issue = (token: string | undefined, body: unknown = { leaseOwner: randomUUID() }) =>
    call(server!, 'POST', '/api/runner/link-token', token, body);
  async function issued(token: string, leaseOwner = randomUUID()): Promise<{ token: string; claims: RunnerLinkClaims }> {
    const reply = await issue(token, { leaseOwner });
    assert.equal(reply.status, 200, reply.text);
    return { token: reply.json.token, claims: verifyRunnerLinkToken(reply.json.token, publicKey, new Date()) };
  }
  async function revocations(): Promise<Revocation[]> {
    const reply = await call(server!, 'GET', '/api/runner/link-token/revocations', GATEWAY_TOKEN);
    assert.equal(reply.status, 200, reply.text);
    return reply.json.revocations;
  }
  /** What the gateway decides: the signature, audience and hour, then the credential against the list. */
  async function gatewayAccepts(token: string): Promise<boolean> {
    const claims = verifyRunnerLinkToken(token, publicKey, new Date());
    return !(await revocations()).some((revocation) => revocation.credential === claims.credential);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const revokedRows = async (runnerId: string): Promise<any[]> =>
    (await sql.query(
      'SELECT credential, runner_id, owner_id, reason FROM runner_link_revocation WHERE runner_id = $1 ORDER BY id',
      [runnerId],
    )).rows;

  server = await startApiserver(url, jwtSecret, {
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: LINK_URL,
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
  });

  await t.test('(1) 0443 made the two tables and the trigger it describes', async () => {
    const applied = await sql.query(
      `SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0443_runner_link_token'`,
    );
    assert.deepEqual(applied.rows, [{ done: true }]);
    const columns = async (table: string) => (await sql.query(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )).rows.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    assert.deepEqual(await columns('tenant_cell'), [
      'owner_id uuid NOT NULL',
      'cell_id text NOT NULL',
      'assigned_at timestamptz NOT NULL',
    ]);
    assert.deepEqual(await columns('runner_link_revocation'), [
      'id int8 NOT NULL',
      'credential text NOT NULL',
      'runner_id uuid NOT NULL',
      'owner_id uuid NOT NULL',
      'reason text NOT NULL',
      'revoked_at timestamptz NOT NULL',
    ]);
    const constraints = await sql.query(
      `SELECT conname, contype, confdeltype FROM pg_constraint
        WHERE conrelid IN ('tenant_cell'::regclass, 'runner_link_revocation'::regclass) AND contype IN ('p', 'c', 'f', 'u')
        ORDER BY conname`,
    );
    assert.deepEqual(constraints.rows.map((c) => `${c.conname} ${c.contype}${c.contype === 'f' ? ` ${c.confdeltype}` : ''}`), [
      'runner_link_revocation_pkey p',
      'runner_link_revocation_reason_chk c',
      'tenant_cell_cell_id_chk c',
      'tenant_cell_owner_id_fkey f c',
      'tenant_cell_pkey p',
    ], 'no foreign key on runner_link_revocation: a revocation outlives its runner');
    const indexes = await sql.query(
      `SELECT indexname FROM pg_indexes WHERE tablename IN ('tenant_cell', 'runner_link_revocation') ORDER BY indexname`,
    );
    assert.deepEqual(indexes.rows.map((i) => i.indexname), [
      'runner_link_revocation_credential_idx',
      'runner_link_revocation_pkey',
      'runner_link_revocation_revoked_at_idx',
      'tenant_cell_pkey',
    ]);
    const triggers = await sql.query(
      `SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid = 'runner'::regclass AND NOT tgisinternal`,
    );
    assert.deepEqual(triggers.rows.map((r) => r.def), [
      'CREATE TRIGGER runner_link_credential_revoke AFTER DELETE OR UPDATE OF token_hash ON public.runner '
        + 'FOR EACH ROW EXECUTE FUNCTION runner_link_credential_revoke()',
    ]);
    // The CHECKs refuse what they exist to refuse.
    const owner = await user('checks');
    await assert.rejects(sql.query(`INSERT INTO tenant_cell (owner_id, cell_id) VALUES ($1, 'cell-2')`, [owner.id]), /tenant_cell_cell_id_chk/);
    await assert.rejects(
      sql.query(`INSERT INTO runner_link_revocation (credential, runner_id, owner_id, reason) VALUES ('x', $1, $1, 'EXPIRED')`, [owner.id]),
      /runner_link_revocation_reason_chk/,
    );
  });

  await t.test('(2) a token names the runner, its tenant, cell-1 and its address, the process and the credential', async () => {
    const owner = await user('issue');
    const machine = await runnerOf(owner, 'issue');
    const leaseOwner = randomUUID();
    const before = Math.floor(Date.now() / 1000);
    const reply = await issue(machine.token, { leaseOwner });
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(Object.keys(reply.json).sort(), ['cellId', 'expiresAt', 'linkUrl', 'token']);
    assert.equal(reply.json.cellId, 'cell-1');
    assert.equal(reply.json.linkUrl, LINK_URL);
    const claims = verifyRunnerLinkToken(reply.json.token, publicKey, new Date());
    assert.equal(claims.runnerId, machine.id);
    assert.equal(claims.ownerId, owner.id);
    assert.equal(claims.cellId, 'cell-1');
    assert.equal(claims.linkUrl, LINK_URL);
    assert.equal(claims.leaseOwner, leaseOwner);
    assert.equal(claims.credential, runnerLinkCredential(sha256(machine.token)));
    assert.ok(claims.iat >= before - 5 && claims.iat <= Math.ceil(Date.now() / 1000) + 5, `iat ${claims.iat}`);
    assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(reply.json.expiresAt, new Date(claims.exp * 1000).toISOString());

    // The tenant is in the directory once, in cell-1, and a second request only reads it.
    await issued(machine.token);
    const placed = await sql.query('SELECT cell_id FROM tenant_cell WHERE owner_id = $1', [owner.id]);
    assert.deepEqual(placed.rows, [{ cell_id: 'cell-1' }]);

    // A tenant whose first requests race is placed once, and every request is answered.
    const racing = await user('race');
    const machines = await Promise.all([1, 2, 3, 4].map((n) => runnerOf(racing, `race-${n}`)));
    const replies = await Promise.all(machines.map((m) => issue(m.token)));
    assert.deepEqual(replies.map((r) => r.status), [200, 200, 200, 200], replies.map((r) => r.text).join('\n'));
    assert.deepEqual((await sql.query('SELECT cell_id FROM tenant_cell WHERE owner_id = $1', [racing.id])).rows, [{ cell_id: 'cell-1' }]);

    // No process identity, or no valid runner credential, and nothing is issued.
    const stranger = await user('stranger');
    const strangerRunner = await runnerOf(stranger, 'stranger');
    assert.equal((await issue(strangerRunner.token, {})).status, 400);
    assert.equal((await issue(strangerRunner.token, { leaseOwner: 'process-1' })).status, 400);
    assert.equal((await issue(runnerToken())).status, 401);
    assert.equal((await issue(undefined)).status, 401);
    assert.equal((await issue(await owner.login())).status, 401, "a person's login is not a runner credential");
    assert.deepEqual((await sql.query('SELECT 1 FROM tenant_cell WHERE owner_id = $1', [stranger.id])).rows, []);
  });

  await t.test('(3) the token expires an hour after it was issued', async () => {
    const machine = await runnerOf(await user('expiry'), 'expiry');
    const { token, claims } = await issued(machine.token);
    assert.equal(verifyRunnerLinkToken(token, publicKey, new Date(claims.exp * 1000 - 1)).jti, claims.jti);
    assert.throws(
      () => verifyRunnerLinkToken(token, publicKey, new Date(claims.exp * 1000)),
      (error: unknown) => error instanceof RunnerLinkTokenRefused && error.reason === 'EXPIRED',
    );
    assert.throws(
      () => verifyRunnerLinkToken(token, publicKey, new Date((claims.iat + 3601) * 1000)),
      (error: unknown) => error instanceof RunnerLinkTokenRefused && error.reason === 'EXPIRED',
    );
  });

  await t.test('(4) deleting a runner or replacing its credential revokes the tokens minted with it, and nothing else does', async () => {
    const owner = await user('revoke');
    const login = await owner.login();
    const machine = await runnerOf(owner, 'revoke');
    const fp = (token: string) => runnerLinkCredential(sha256(token));

    // Only the gateway's secret reads the list.
    for (const bearer of [undefined, 'wrong-secret', machine.token, login]) {
      const refused = await call(server!, 'GET', '/api/runner/link-token/revocations', bearer);
      assert.equal(refused.status, 401, `${bearer === undefined ? 'no bearer' : 'a bearer that is not the secret'}: ${refused.text}`);
      assert.equal(refused.json?.code, 'RUNNER_LINK_GATEWAY_UNAUTHORIZED');
    }
    const first = await issued(machine.token);
    assert.equal(await gatewayAccepts(first.token), true);

    // A write of the row that leaves the credential alone — a heartbeat's, or one naming the column
    // with its own value — records nothing.
    await db.runner.update({ where: { id: machine.id }, data: { lastHeartbeatAt: new Date(), version: '0.1.236', status: 'ONLINE' } });
    await sql.query('UPDATE runner SET token_hash = token_hash WHERE id = $1', [machine.id]);
    assert.deepEqual(await revokedRows(machine.id), []);

    // The Runners page rotates the token: the old credential is revoked, with the fingerprint the
    // tokens minted with it carry, and a token minted with the new one is good.
    const rotated = await call(server!, 'POST', `/api/runners/${machine.id}/rotate-token`, login);
    assert.equal(rotated.status, 201, rotated.text);
    const second = rotated.json.token as string;
    assert.deepEqual(await revokedRows(machine.id), [
      { credential: fp(machine.token), runner_id: machine.id, owner_id: owner.id, reason: 'CREDENTIAL_REPLACED' },
    ]);
    assert.equal(first.claims.credential, fp(machine.token), 'the trigger and the signer compute one fingerprint');
    assert.equal(await gatewayAccepts(first.token), false, 'the gateway refuses the token minted before the rotation');
    assert.equal((await issue(machine.token)).status, 401, 'the old runner token itself stopped working, as before');
    const afterRotation = await issued(second);
    assert.equal(await gatewayAccepts(afterRotation.token), true);

    // Registering it again under its name (`orbit register`) replaces the credential too.
    const enrollment = runnerToken();
    await db.enrollmentToken.create({ data: { ownerId: owner.id, tokenHash: sha256(enrollment) } });
    const registered = await call(server!, 'POST', '/api/runner/register', undefined, {
      enrollmentToken: enrollment, name: machine.name, hostname: 'host', labels: [], maxConcurrent: 2, version: '0.1.236',
    });
    assert.equal(registered.status, 201, registered.text);
    assert.equal(registered.json.runnerId, machine.id, 'the same runner, with a new credential');
    const third = registered.json.runnerToken as string;
    assert.deepEqual((await revokedRows(machine.id)).map((row) => [row.credential, row.reason]), [
      [fp(machine.token), 'CREDENTIAL_REPLACED'],
      [fp(second), 'CREDENTIAL_REPLACED'],
    ]);
    assert.equal(await gatewayAccepts(afterRotation.token), false);
    const afterRegistration = await issued(third);
    assert.equal(await gatewayAccepts(afterRegistration.token), true);

    // `orbit unregister`: the runner deletes itself, and its last credential is revoked.
    const unregistered = await call(server!, 'POST', '/api/runner/deregister', third, {});
    assert.equal(unregistered.status, 200, unregistered.text);
    assert.deepEqual((await revokedRows(machine.id)).map((row) => [row.credential, row.reason]), [
      [fp(machine.token), 'CREDENTIAL_REPLACED'],
      [fp(second), 'CREDENTIAL_REPLACED'],
      [fp(third), 'RUNNER_DELETED'],
    ]);
    assert.equal(await gatewayAccepts(afterRegistration.token), false);

    // Deleting a runner on the Runners page.
    const other = await runnerOf(owner, 'deleted');
    const otherToken = await issued(other.token);
    const deleted = await call(server!, 'DELETE', `/api/runners/${other.id}`, login);
    assert.equal(deleted.status, 200, deleted.text);
    assert.deepEqual(await revokedRows(other.id), [
      { credential: fp(other.token), runner_id: other.id, owner_id: owner.id, reason: 'RUNNER_DELETED' },
    ]);
    assert.equal(await gatewayAccepts(otherToken.token), false);

    // A credential that becomes the runner's again — a managed runner adopting the credential it
    // already had — vouches again, and only the one that was swapped in for it stays revoked.
    const managed = await runnerOf(owner, 'adopting');
    const adopted = await issued(managed.token);
    const interim = runnerToken();
    await db.runner.update({ where: { id: managed.id }, data: { tokenHash: sha256(interim) } });
    assert.equal(await gatewayAccepts(adopted.token), false);
    await db.runner.update({ where: { id: managed.id }, data: { tokenHash: sha256(managed.token) } });
    assert.deepEqual(await revokedRows(managed.id), [
      { credential: fp(interim), runner_id: managed.id, owner_id: owner.id, reason: 'CREDENTIAL_REPLACED' },
    ]);
    assert.equal(await gatewayAccepts(adopted.token), true);

    // The list names fingerprints only, and every one it names was revoked within the window.
    const listed = await call(server!, 'GET', '/api/runner/link-token/revocations', GATEWAY_TOKEN);
    assert.deepEqual(Object.keys(listed.json).sort(), ['revocations', 'since']);
    for (const revocation of listed.json.revocations as Revocation[]) {
      assert.deepEqual(Object.keys(revocation).sort(), ['credential', 'revokedAt']);
      assert.match(revocation.credential, /^[0-9a-f]{32}$/);
      assert.ok(Date.parse(revocation.revokedAt) >= Date.parse(listed.json.since));
    }
  });

  await t.test("(5) the list reaches back a token's lifetime and ten minutes, and the reaper purges what is older", async () => {
    const owner = await user('window');
    const lapsed = 'e'.repeat(32);
    const recent = 'd'.repeat(32);
    await sql.query(
      `INSERT INTO runner_link_revocation (credential, runner_id, owner_id, reason, revoked_at) VALUES
         ($1, $3, $3, 'RUNNER_DELETED', now() - interval '71 minutes'),
         ($2, $3, $3, 'RUNNER_DELETED', now() - interval '65 minutes')`,
      [lapsed, recent, owner.id],
    );
    assert.equal(RUNNER_LINK_REVOCATION_WINDOW_MS, 70 * 60_000);
    const listed = (await revocations()).map((revocation) => revocation.credential);
    assert.ok(listed.includes(recent), 'revoked 65 minutes ago: a token minted just before can still be live');
    assert.ok(!listed.includes(lapsed), 'revoked 71 minutes ago: every token it could refuse has expired');

    const before = Number((await sql.query('SELECT count(*) FROM runner_link_revocation')).rows[0].count);
    const reaper = new ReaperService(db as unknown as PrismaService, {} as RealtimeService);
    await (reaper as unknown as { purgeLapsedLinkRevocations(): Promise<void> }).purgeLapsedLinkRevocations();
    const left = await sql.query('SELECT credential FROM runner_link_revocation WHERE credential IN ($1, $2)', [lapsed, recent]);
    assert.deepEqual(left.rows, [{ credential: recent }]);
    assert.equal(Number((await sql.query('SELECT count(*) FROM runner_link_revocation')).rows[0].count), before - 1);
  });

  await t.test('(6) with a setting missing the link is off: both routes answer 404, and the log says which', async () => {
    off = await startApiserver(url, jwtSecret, {
      RUNNER_LINK_SIGNING_KEY: '',
      RUNNER_LINK_URL: LINK_URL,
      RUNNER_LINK_GATEWAY_TOKEN: '',
    });
    const machine = await runnerOf(await user('off'), 'off');
    const refusedIssue = await call(off, 'POST', '/api/runner/link-token', machine.token, { leaseOwner: randomUUID() });
    assert.equal(refusedIssue.status, 404, refusedIssue.text);
    assert.equal(refusedIssue.json.code, RUNNER_LINK_NOT_CONFIGURED);
    const refusedList = await call(off, 'GET', '/api/runner/link-token/revocations', GATEWAY_TOKEN);
    assert.equal(refusedList.status, 404, refusedList.text);
    assert.equal(refusedList.json.code, RUNNER_LINK_NOT_CONFIGURED);
    assert.match(off.output(), /RUNNER_LINK_SIGNING_KEY is not set: the runner link is off/);
    assert.match(off.output(), /RUNNER_LINK_GATEWAY_TOKEN is not set: the runner link is off/);
    // The runner's own HTTP door is answered as before.
    assert.equal((await call(off, 'GET', '/api/runner/me', machine.token)).status, 200);
  });
});
