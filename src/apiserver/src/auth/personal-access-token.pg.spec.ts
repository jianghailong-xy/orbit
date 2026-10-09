/**
 * Personal access tokens, the foundation (docs/personal-access-token-design.md §3 and §6.1,
 * migration 0383): the table, PatService, and JwtAuthGuard telling a token from a login. Against a
 * real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, what it is held to:
 *
 *   (1) 0383 made the table it describes — its columns, CHECKs, the cascade from `user`, the unique
 *       token hash and the partial unique name — and runs again unchanged;
 *   (2) `issue` answers `orbit_pat_` and 43 base64url characters, once: the row keeps the token's
 *       sha256 and its last four characters, and no table in the database holds the token;
 *   (3) through JwtAuthGuard a token is its user — credential PAT, with the token's id, scopes and
 *       workspaces — and a login JWT is credential LOGIN;
 *   (4) a revoked token is 401 with the body of a token that never existed, and revoking twice
 *       changes nothing;
 *   (5) an expired token is 401; one whose `expires_at` is NULL does not expire; a deleted user's
 *       tokens go with them;
 *   (6) the `?access_token=` door never takes a token, even on the stream that allows it;
 *   (7) a route that declares neither @PatScope nor @PatForbidden refuses every token 403
 *       PAT_ROUTE_UNDECLARED, one granted every scope included;
 *   (8) a name is unique among a user's live tokens, 50 live tokens is the cap, and a token's expiry
 *       frees both; input `issue` cannot honour is refused before anything is written;
 *   (9) `last_used_*` is written at most once a minute, and no request waits for the write;
 *  (10) the production apiserver — `build/main.js`, the whole AppModule — opens a route to a token
 *       holding the scope the route declares and to no other: a write without its scope is 403
 *       PAT_SCOPE_MISSING and writes nothing, and with it the write is made; routes no scope opens
 *       (the account, the password, an owner's decision) refuse a token holding every scope, while a
 *       login JWT reaches each of them as before; revoked, expired and unknown tokens are one 401;
 *       and the event stream takes a login's `?access_token=` but never a token's;
 *  (11) through that same apiserver, a task a token creates is its user's — creator USER and the
 *       user's id, as from the Web — and the `activity` row it gets (0384, §6.4) names the door: PAT
 *       and the token's id, or LOGIN and no id. Every user door that creates tasks — the single
 *       create, the batch, the paired create — records each task it inserts once; a dry run and a
 *       write the token was not granted record no task. (The `pat.request` row each of the token's
 *       requests also leaves is `pat-request-audit.pg.spec.ts`'s.)
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/personal-access-token.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  BadRequestException,
  ConflictException,
  type ExecutionContext,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { AllowQueryToken } from './allow-query-token.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PAT_MAX_ACTIVE_PER_USER, PAT_PREFIX, PAT_SCOPES, PatService } from './pat.service';
import { call, startApiserver, type Apiserver } from './pat-test-apiserver';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0383_personal_access_token/migration.sql'),
  'utf8',
);
const ACTIVITY_MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0384_activity_credential/migration.sql'),
  'utf8',
);
const INVALID_TOKEN = { message: 'invalid token', error: 'Unauthorized', statusCode: 401 };

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const unknownToken = () => PAT_PREFIX + randomBytes(32).toString('base64url');

/** Two handlers as the guard sees them: an ordinary route, and a stream that allows `?access_token=`. */
class Routes {
  plain(): void {}
  @AllowQueryToken()
  stream(): void {}
}

interface Presented {
  /** 200 when the guard let the request through. */
  status: number;
  user?: AuthUser;
  body?: unknown;
}

/** One request through the guard, as Nest hands it one. */
async function present(
  guard: JwtAuthGuard,
  credential: string,
  options: { via?: 'header' | 'query'; route?: 'plain' | 'stream'; ip?: string; userAgent?: string } = {},
): Promise<Presented> {
  const headers: Record<string, string> = { 'user-agent': options.userAgent ?? 'pat-spec' };
  if (options.ip) headers['x-real-ip'] = options.ip;
  if (options.via !== 'query') headers.authorization = `Bearer ${credential}`;
  const request: Record<string, unknown> = {
    headers,
    query: options.via === 'query' ? { access_token: credential } : {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => Routes.prototype[options.route ?? 'plain'],
    getClass: () => Routes,
  } as unknown as ExecutionContext;
  try {
    assert.equal(await guard.canActivate(context), true);
    return { status: 200, user: request.user as AuthUser };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), user: request.user as AuthUser | undefined, body: error.getResponse() };
  }
}

async function eventually<T>(what: string, check: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const refusedWith = (code: string) => (error: unknown) =>
  error instanceof ConflictException && (error.getResponse() as { code?: string }).code === code;

test('personal access tokens: issued once, stored as a hash, resolved by JwtAuthGuard, refused once revoked or expired', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  const pats = new PatService(db as unknown as PrismaService);
  const jwt = new JwtService({ secret: `pat-spec-${randomUUID()}`, signOptions: { expiresIn: '1h' } });
  const guard = new JwtAuthGuard(jwt, new Reflector(), pats);

  async function user(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@personal-access-token.invalid`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, email };
  }
  async function workspaceOf(owner: { id: string }) {
    const runnerId = randomUUID();
    const id = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: owner.id, name: 'a runner', tokenHash: `pat-spec-${runnerId}` } });
    await db.workspace.create({ data: { id, ownerId: owner.id, runnerId, name: `orbit ${RUN}`, enabled: true } });
    return id;
  }
  const owner = await user('owner');
  const other = await user('other');
  const workspaceId = await workspaceOf(owner);
  const theirWorkspaceId = await workspaceOf(other);

  const issue = (who: { id: string }, name: string, extra: Partial<Parameters<PatService['issue']>[1]> = {}) =>
    pats.issue(who.id, { name, scopes: ['tasks:read'], expiresInDays: 90, createdVia: 'WEB', ...extra });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = async (id: string): Promise<any> =>
    (await sql.query('SELECT * FROM personal_access_token WHERE id = $1', [id])).rows[0];
  const login = () => jwt.signAsync({ sub: owner.id, email: owner.email });

  await t.test('(1) 0383 made the table it describes, on the database this run migrated from empty, and runs again', async () => {
    const applied = await sql.query(
      `SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0383_personal_access_token'`,
    );
    assert.deepEqual(applied.rows, [{ done: true }]);
    const columns = await sql.query(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'personal_access_token' ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      columns.rows.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`),
      [
        'id uuid NOT NULL',
        'owner_id uuid NOT NULL',
        'name text NOT NULL',
        'token_hash text NOT NULL',
        'token_hint text NOT NULL',
        'scopes _text NOT NULL',
        'workspace_ids _uuid NOT NULL',
        'expires_at timestamptz NULL',
        'created_via text NOT NULL',
        'last_used_at timestamptz NULL',
        'last_used_ip text NULL',
        'last_used_user_agent text NULL',
        'revoked_at timestamptz NULL',
        'revoked_reason text NULL',
        'created_at timestamptz NOT NULL',
      ],
    );
    const cascade = await sql.query(
      `SELECT confrelid = '"user"'::regclass AS to_user, confdeltype FROM pg_constraint
        WHERE conname = 'personal_access_token_owner_id_fkey'`,
    );
    assert.deepEqual(cascade.rows, [{ to_user: true, confdeltype: 'c' }], 'owner_id → user ON DELETE CASCADE');
    const indexes = await sql.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'personal_access_token' ORDER BY indexname`,
    );
    const definition = new Map<string, string>(indexes.rows.map((index) => [index.indexname, index.indexdef]));
    assert.match(definition.get('personal_access_token_token_hash_key') ?? '', /^CREATE UNIQUE INDEX .* \(token_hash\)$/);
    assert.match(
      definition.get('personal_access_token_owner_id_name_active_key') ?? '',
      /^CREATE UNIQUE INDEX .* \(owner_id, name\) WHERE \(revoked_at IS NULL\)$/,
    );
    assert.ok(definition.has('personal_access_token_owner_id_idx'));

    // The CHECKs refuse what they exist to refuse.
    const refusal = async (names: string, values: string) => {
      try {
        await sql.query(
          `INSERT INTO personal_access_token (id, owner_id, name, token_hash, token_hint, ${names})
           VALUES (gen_random_uuid(), $1, 'refused', $2, 'abcd', ${values})`,
          [owner.id, randomUUID()],
        );
        return 'ACCEPTED';
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        return `${e.code} ${e.constraint}`;
      }
    };
    assert.equal(await refusal('created_via', `'EMAIL'`), '23514 personal_access_token_created_via_chk');
    assert.equal(await refusal('created_via, revoked_at', `'WEB', now()`), '23514 personal_access_token_revoked_chk');
    assert.equal(await refusal('created_via, revoked_reason', `'WEB', 'USER'`), '23514 personal_access_token_revoked_chk');
    assert.equal(
      await refusal('created_via, revoked_at, revoked_reason', `'WEB', now(), 'LOST'`),
      '23514 personal_access_token_revoked_chk',
    );

    await sql.query(MIGRATION);
    const again = await sql.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'personal_access_token' ORDER BY indexname`);
    assert.deepEqual(again.rows.map((index) => index.indexname), [...definition.keys()]);
  });

  const issued = await issue(owner, 'laptop script', {
    scopes: ['tasks:read', 'tasks:write', ' tasks:read '],
    workspaceIds: [workspaceId, workspaceId],
  });

  await t.test('(2) issue answers the token once; the database keeps its sha256 and four characters of it, never the token', async () => {
    assert.match(issued.token, /^orbit_pat_[A-Za-z0-9_-]{43}$/);
    assert.ok(!('tokenHash' in issued));
    assert.deepEqual(issued.scopes, ['tasks:read', 'tasks:write']);
    assert.deepEqual(issued.workspaceIds, [workspaceId]);
    assert.equal(issued.createdVia, 'WEB');
    assert.ok(Math.abs(issued.expiresAt!.getTime() - (Date.now() + 90 * 86_400_000)) < 60_000, 'ninety days');

    const stored = await row(issued.id);
    assert.equal(stored.owner_id, owner.id);
    assert.equal(stored.name, 'laptop script');
    assert.equal(stored.token_hash, sha256(issued.token));
    assert.equal(stored.token_hint, issued.token.slice(-4));
    assert.equal(stored.revoked_at, null);

    // Not in any column of any row of any table — the whole token, or its random part.
    const secret = issued.token.slice(PAT_PREFIX.length);
    const tables = await sql.query(
      `SELECT quote_ident(table_name) AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    assert.ok(tables.rows.length > 100, `${tables.rows.length} tables`);
    const holding: string[] = [];
    for (const { name } of tables.rows) {
      const found = await sql.query(
        `SELECT EXISTS (SELECT 1 FROM ${name} t WHERE strpos(row_to_json(t)::text, $1) > 0) AS found`,
        [secret],
      );
      if (found.rows[0].found) holding.push(name);
    }
    assert.deepEqual(holding, []);

    assert.notEqual((await issue(owner, 'another')).token, issued.token);
  });

  await t.test('(3) through JwtAuthGuard a token is its user — credential PAT — and a login JWT is credential LOGIN', async () => {
    const pat = await present(guard, issued.token);
    assert.deepEqual(pat.user, {
      userId: owner.id,
      email: owner.email,
      credential: {
        kind: 'PAT',
        tokenId: issued.id,
        scopes: ['tasks:read', 'tasks:write'],
        workspaceIds: [workspaceId],
      },
    });
    const theirs = await issue(other, 'their script', { scopes: ['projects:read'] });
    assert.deepEqual((await present(guard, theirs.token)).user, {
      userId: other.id,
      email: other.email,
      credential: { kind: 'PAT', tokenId: theirs.id, scopes: ['projects:read'], workspaceIds: [] },
    });
    const signedIn = await present(guard, await login());
    assert.equal(signedIn.status, 200);
    assert.deepEqual(signedIn.user, { userId: owner.id, email: owner.email, credential: { kind: 'LOGIN' } });
  });

  await t.test('(4) a revoked token is 401 with the body of a token that never existed; revoking twice changes nothing', async () => {
    const token = await issue(owner, 'to revoke');
    assert.equal((await present(guard, token.token)).user?.userId, owner.id);
    const revoked = await pats.revoke(owner.id, token.id);
    assert.equal(revoked.revokedReason, 'USER');
    assert.ok(revoked.revokedAt instanceof Date);

    const refused = await present(guard, token.token);
    assert.equal(refused.status, 401);
    assert.equal(refused.user, undefined);
    assert.deepEqual(refused.body, INVALID_TOKEN);
    assert.deepEqual((await present(guard, unknownToken())).body, refused.body);

    assert.deepEqual(await pats.revoke(owner.id, token.id, 'ADMIN'), revoked);
    await assert.rejects(pats.revoke(other.id, token.id), NotFoundException, "another user's token is not theirs to revoke");
    await assert.rejects(pats.revoke(owner.id, randomUUID()), NotFoundException);
  });

  await t.test("(5) an expired token is 401; one whose expires_at is NULL does not expire; a deleted user's tokens go with them", async () => {
    const expiring = await issue(owner, 'expiring', { expiresInDays: 30 });
    assert.equal((await present(guard, expiring.token)).user?.userId, owner.id);
    await sql.query(`UPDATE personal_access_token SET expires_at = now() - interval '1 second' WHERE id = $1`, [expiring.id]);
    const expired = await present(guard, expiring.token);
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.body, INVALID_TOKEN);

    const forever = await issue(owner, 'forever', { expiresInDays: null });
    assert.equal(forever.expiresAt, null);
    assert.equal((await row(forever.id)).expires_at, null);
    // Issued ten years ago and never expiring, it is still its user.
    await sql.query(`UPDATE personal_access_token SET created_at = now() - interval '10 years' WHERE id = $1`, [forever.id]);
    const still = await present(guard, forever.token);
    assert.equal(still.user?.userId, owner.id);
    assert.equal(still.user?.credential?.kind, 'PAT');

    const leaving = await user('leaving');
    const theirs = await issue(leaving, 'theirs');
    await db.user.delete({ where: { id: leaving.id } });
    assert.equal(await row(theirs.id), undefined);
    assert.equal((await present(guard, theirs.token)).status, 401);
  });

  await t.test('(6) the ?access_token= door never takes a token, even on the stream that allows it', async () => {
    const reader = await issue(owner, 'stream reader', { scopes: ['events:read'] });
    const viaQuery = await present(guard, reader.token, { via: 'query', route: 'stream' });
    assert.equal(viaQuery.status, 401);
    assert.deepEqual(viaQuery.body, INVALID_TOKEN);
    assert.equal(viaQuery.user, undefined);
    // Not looked up either: a lookup records the use.
    await sleep(300);
    assert.equal((await row(reader.id)).last_used_at, null);

    // The door is open to a login …
    const signedIn = await present(guard, await login(), { via: 'query', route: 'stream' });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.user?.credential?.kind, 'LOGIN');
    // … and the same token in the header is resolved to its user.
    assert.equal((await present(guard, reader.token, { route: 'stream' })).user?.userId, owner.id);
  });

  await t.test('(7) a route that declares nothing refuses every token 403 PAT_ROUTE_UNDECLARED — one granted every scope too', async () => {
    const everything = await issue(owner, 'everything', { scopes: [...PAT_SCOPES] });
    for (const token of [issued.token, everything.token]) {
      for (const route of ['plain', 'stream'] as const) {
        const answer = await present(guard, token, { route });
        assert.equal(answer.status, 403, `${route}: ${JSON.stringify(answer.body)}`);
        assert.equal((answer.body as { code?: string }).code, 'PAT_ROUTE_UNDECLARED');
      }
    }
  });

  await t.test('(8) a name is unique among live tokens, 50 live tokens is the cap, and a token\'s expiry frees both', async () => {
    const busy = await user('busy');
    const first = await issue(busy, 'ci');
    await assert.rejects(issue(busy, ' ci '), refusedWith('PAT_NAME_IN_USE'));
    await pats.revoke(busy.id, first.id);
    const second = await issue(busy, 'ci');
    for (let n = 1; n < PAT_MAX_ACTIVE_PER_USER; n++) await issue(busy, `script ${n}`);
    const live = await sql.query(
      'SELECT count(*)::int AS n FROM personal_access_token WHERE owner_id = $1 AND revoked_at IS NULL',
      [busy.id],
    );
    assert.equal(live.rows[0].n, PAT_MAX_ACTIVE_PER_USER);
    await assert.rejects(issue(busy, 'one too many'), refusedWith('PAT_LIMIT_REACHED'));

    // Past its expiry, `ci` is settled EXPIRED by the next issue: its name and its place are free.
    await sql.query(`UPDATE personal_access_token SET expires_at = now() - interval '1 second' WHERE id = $1`, [second.id]);
    const third = await issue(busy, 'ci');
    const settled = await row(second.id);
    assert.equal(settled.revoked_reason, 'EXPIRED');
    assert.ok(settled.revoked_at instanceof Date);
    assert.equal((await row(third.id)).revoked_at, null);
    // Another user's names are their own.
    await issue(other, 'ci');
  });

  await t.test('(8) input issue cannot honour is refused before anything is written', async () => {
    const countRows = async () =>
      (await sql.query('SELECT count(*)::int AS n FROM personal_access_token WHERE owner_id = $1', [owner.id])).rows[0].n;
    const before = await countRows();
    const cases: Array<[string, Partial<Parameters<PatService['issue']>[1]>, typeof BadRequestException | typeof NotFoundException]> = [
      ['a blank name', { name: '   ' }, BadRequestException],
      ['a name of 101 characters', { name: 'n'.repeat(101) }, BadRequestException],
      ['no scope', { scopes: [] }, BadRequestException],
      ['a scope that does not exist', { scopes: ['tasks:read', 'admin:write'] }, BadRequestException],
      ['zero days', { expiresInDays: 0 }, BadRequestException],
      ['more than a year', { expiresInDays: 366 }, BadRequestException],
      ['part of a day', { expiresInDays: 1.5 }, BadRequestException],
      ['a workspace id that is not one', { workspaceIds: ['not-a-uuid'] }, BadRequestException],
      ["another user's workspace", { workspaceIds: [workspaceId, theirWorkspaceId] }, NotFoundException],
    ];
    for (const [what, input, refusal] of cases) {
      await assert.rejects(issue(owner, `refused: ${what}`, input), refusal, what);
    }
    assert.equal(await countRows(), before);
  });

  await t.test('(9) last_used_* is written at most once a minute, and no request waits for the write', async () => {
    const used = await issue(owner, 'used');
    await present(guard, used.token, { ip: '203.0.113.7', userAgent: 'pat-spec/1' });
    const first = await eventually('the first use to be recorded', async () => {
      const current = await row(used.id);
      return current.last_used_at ? current : null;
    });
    assert.equal(first.last_used_ip, '203.0.113.7');
    assert.equal(first.last_used_user_agent, 'pat-spec/1');

    // Within the minute it is not written again.
    await present(guard, used.token, { ip: '198.51.100.9', userAgent: 'pat-spec/2' });
    await sleep(500);
    const throttled = await row(used.id);
    assert.equal(throttled.last_used_at.getTime(), first.last_used_at.getTime());
    assert.equal(throttled.last_used_ip, '203.0.113.7');

    // A minute on it is — and with the row locked by another transaction, the write waits while the
    // request is answered.
    await sql.query(
      `UPDATE personal_access_token SET last_used_at = last_used_at - interval '61 seconds' WHERE id = $1`,
      [used.id],
    );
    const locker = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM personal_access_token WHERE id = $1 FOR UPDATE', [used.id]);
      const answered = await Promise.race([
        present(guard, used.token, { ip: '198.51.100.9', userAgent: 'pat-spec/3' }).then((answer) => answer.user?.userId),
        sleep(5_000).then(() => 'still waiting'),
      ]);
      assert.equal(answered, owner.id, 'the request was answered while its last-use write waited on the lock');
      assert.equal((await row(used.id)).last_used_ip, '203.0.113.7', 'the write is still waiting');
      await locker.query('COMMIT');
    } finally {
      await locker.end().catch(() => undefined);
    }
    const later = await eventually('the later use to be recorded', async () => {
      const current = await row(used.id);
      return current.last_used_ip === '198.51.100.9' ? current : null;
    });
    assert.equal(later.last_used_user_agent, 'pat-spec/3');
  });
});

// ── (10) the production apiserver ─────────────────────────────────────────────────────────────

test('(10) the production apiserver: a token reaches a route holding the scope it declares and no other; routes no scope opens refuse every token while a login reaches them; revoked, expired and unknown tokens are one 401; the stream takes a login\'s ?access_token= and never a token\'s', {
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

  const userId = randomUUID();
  const email = `production-${RUN}-${userId}@personal-access-token.invalid`;
  await db.user.create({ data: { id: userId, email, name: 'Before', passwordHash: 'x' } });
  const pats = new PatService(db as unknown as PrismaService);
  const issue = (name: string, scopes: readonly string[] = PAT_SCOPES) =>
    pats.issue(userId, { name, scopes: [...scopes], expiresInDays: 90, createdVia: 'WEB' });
  const reader = (await issue('reader', ['tasks:read', 'projects:read', 'sessions:read', 'workspaces:read'])).token;
  const token = (await issue('every scope')).token;
  const jwtSecret = `pat-spec-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: userId, email });
  server = await startApiserver(url, jwtSecret);

  // A token holding the scope a route declares reaches it, as a login does.
  for (const route of ['/api/tasks', '/api/projects', '/api/sessions', '/api/workspaces']) {
    for (const [who, bearer] of [['a reading token', reader], ['a login', login]]) {
      const answer = await call(server, 'GET', route, bearer);
      assert.equal(answer.status, 200, `GET ${route} by ${who} answered ${answer.status}: ${answer.text}`);
    }
  }

  // A write is refused to a token without its scope, before anything is written; holding it, the token writes.
  const task = (by: string) => ({
    title: `written by ${by}`,
    // Outside a project, the one criterion this door takes without more: a command and its exit code.
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  });
  const withoutScope = await call(server, 'POST', '/api/tasks', reader, task('reader'));
  assert.equal(withoutScope.status, 403, withoutScope.text);
  assert.deepEqual(withoutScope.json, {
    code: 'PAT_SCOPE_MISSING',
    scope: 'tasks:write',
    message: 'This access token was not granted the tasks:write scope this route needs',
  });
  for (const [by, bearer] of [['token', token], ['login', login]]) {
    const created = await call(server, 'POST', '/api/tasks', bearer, task(by));
    assert.equal(created.status, 201, `POST /api/tasks by ${by} answered ${created.status}: ${created.text}`);
  }

  // Routes no scope opens refuse a token holding every scope, with their reason and writing nothing,
  // and a login reaches each of them as before.
  const closed: Array<[string, string, (by: string) => unknown, string]> = [
    ['GET', '/api/users/me', () => undefined, 'ACCOUNT'],
    ['PATCH', '/api/users/me', (by) => ({ name: `renamed by ${by}` }), 'ACCOUNT'],
    ['POST', '/api/auth/change-password', () => ({ currentPassword: 'not-it', newPassword: 'a-new-password-1' }), 'AUTH'],
    ['POST', `/api/projects/${randomUUID()}/pause`, () => undefined, 'OWNER_INTERACTIVE'],
  ];
  const loginAnswers: string[] = [];
  for (const [method, route, body, reason] of closed) {
    const byToken = await call(server, method, route, token, body('token'));
    assert.equal(byToken.status, 403, `${method} ${route} with a token answered ${byToken.status}: ${byToken.text}`);
    assert.equal(byToken.json?.reason, reason, `${method} ${route}: ${byToken.text}`);
    const byLogin = await call(server, method, route, login, body('login'));
    assert.ok(
      byLogin.status !== 401 && byLogin.status !== 403,
      `${method} ${route} with a login answered ${byLogin.status}: ${byLogin.text}`,
    );
    loginAnswers.push(`${method} ${route} ${byLogin.status}`);
  }
  const written = await sql.query(
    `SELECT (SELECT count(*)::int FROM task WHERE owner_id = $1 AND title = 'written by reader') AS by_reader,
            (SELECT count(*)::int FROM task WHERE owner_id = $1 AND title = 'written by token') AS by_token,
            (SELECT count(*)::int FROM task WHERE owner_id = $1 AND title = 'written by login') AS by_login,
            (SELECT name FROM "user" WHERE id = $1) AS name`,
    [userId],
  );
  assert.deepEqual(
    written.rows,
    [{ by_reader: 0, by_token: 1, by_login: 1, name: 'renamed by login' }],
    loginAnswers.join('; '),
  );

  // The app's own PatService verified the token, and recorded the use from where the request came.
  const used = await eventually("the app to record the token's use", async () => {
    const current = (await sql.query(
      'SELECT last_used_at, last_used_ip FROM personal_access_token WHERE token_hash = $1',
      [sha256(token)],
    )).rows[0];
    return current?.last_used_at ? current : null;
  });
  assert.match(used.last_used_ip, /127\.0\.0\.1$/);

  const revoked = await issue('revoked');
  await pats.revoke(userId, revoked.id);
  const expired = await issue('expired');
  await sql.query(`UPDATE personal_access_token SET expires_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
  for (const [what, dead] of [['revoked', revoked.token], ['expired', expired.token], ['unknown', unknownToken()]]) {
    const answer = await call(server, 'GET', '/api/tasks', dead);
    assert.equal(answer.status, 401, `a ${what} token answered ${answer.status}: ${answer.text}`);
    assert.deepEqual(answer.json, INVALID_TOKEN, `a ${what} token`);
  }

  const asQuery = (bearer: string) => `/api/events?access_token=${encodeURIComponent(bearer)}`;
  assert.equal((await call(server, 'GET', asQuery(login))).status, 200, "the stream takes a login's ?access_token=");
  const tokenInUrl = await call(server, 'GET', asQuery(token));
  assert.equal(tokenInUrl.status, 401, tokenInUrl.text);
  assert.deepEqual(tokenInUrl.json, INVALID_TOKEN);
  // In the header, the stream is open to a token holding events:read, and to no other.
  assert.equal((await call(server, 'GET', '/api/events', token)).status, 200, 'a token holding events:read');
  const withoutEvents = await call(server, 'GET', '/api/events', reader);
  assert.equal(withoutEvents.status, 403, withoutEvents.text);
  assert.equal(withoutEvents.json?.scope, 'events:read');
});

// ── (11) whose write it is, and which door it came through ────────────────────────────────────

test("(11) the production apiserver: a task created through a token is its user's and its activity row names the token; through a login the row says LOGIN; every user door that creates tasks records each task it inserts, and no other task is recorded", {
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

  // 0384, on the database this run migrated from empty: two nullable columns, and a CHECK that takes
  // a kind of LOGIN or PAT (or none) and a token id exactly when the kind is PAT. It runs again.
  const applied = await sql.query(
    `SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0384_activity_credential'`,
  );
  assert.deepEqual(applied.rows, [{ done: true }]);
  const columns = async () => (await sql.query(
    `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'activity' AND column_name LIKE 'credential%'
      ORDER BY column_name`,
  )).rows.map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
  assert.deepEqual(await columns(), ['credential_id uuid NULL', 'credential_kind text NULL']);
  const probe = randomUUID();
  const insert = (kind: string | null, id: string | null) => sql.query(
    `INSERT INTO activity (id, actor_id, type, credential_kind, credential_id) VALUES ($1, $2, 'probe', $3, $4)`,
    [randomUUID(), probe, kind, id],
  );
  for (const [kind, id] of [[null, null], ['LOGIN', null], ['PAT', randomUUID()]] as const) await insert(kind, id);
  for (const [kind, id] of [['PAT', null], ['LOGIN', randomUUID()], [null, randomUUID()], ['SESSION', null]] as const) {
    await assert.rejects(
      insert(kind, id),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'activity_credential_chk',
      `kind ${kind} with ${id ? 'a token id' : 'no token id'} is refused`,
    );
  }
  await sql.query(ACTIVITY_MIGRATION);
  assert.deepEqual(await columns(), ['credential_id uuid NULL', 'credential_kind text NULL'], '0384 runs again');
  await sql.query('DELETE FROM activity WHERE actor_id = $1', [probe]);

  const userId = randomUUID();
  const email = `audit-${RUN}-${userId}@personal-access-token.invalid`;
  await db.user.create({ data: { id: userId, email, name: 'Audited', passwordHash: 'x' } });
  // The paired create files a verification, which only a project can count.
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId: userId, title: `audit ${RUN}` } });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await establishProjectContractForPgTest(db, userId, projectId, `audit ${RUN}`);
  const pats = new PatService(db as unknown as PrismaService);
  const issue = (name: string, scopes: string[]) =>
    pats.issue(userId, { name, scopes, expiresInDays: 90, createdVia: 'WEB' });
  const writer = await issue('writer', ['tasks:read', 'tasks:write']);
  const reader = await issue('reader', ['tasks:read']);
  const jwtSecret = `pat-spec-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: userId, email });
  server = await startApiserver(url, jwtSecret);

  const task = (title: string) => ({
    title,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  });
  /** A task as stored — its creator — and every activity row about it. Ids arrive as public ids. */
  const stored = async (publicId: string) => {
    const id = toUuid(publicId);
    const row = await sql.query(
      'SELECT creator_type, creator_id, creator_session_id FROM task WHERE id = $1',
      [id],
    );
    const activity = await sql.query(
      `SELECT actor_id, type, payload, credential_kind, credential_id FROM activity WHERE payload->>'taskId' = $1`,
      [id],
    );
    return { id, creator: row.rows[0], activity: activity.rows };
  };
  // The user's, whichever door: exactly what the Web has always written.
  const theUsers = { creator_type: 'USER', creator_id: userId, creator_session_id: null };
  const throughToken = (taskId: string) => ({
    actor_id: userId,
    type: 'task.created',
    payload: { taskId },
    credential_kind: 'PAT',
    credential_id: writer.id,
  });
  const throughLogin = (taskId: string) => ({ ...throughToken(taskId), credential_kind: 'LOGIN', credential_id: null });

  const byToken = await call(server, 'POST', '/api/tasks', writer.token, task('created through a token'));
  assert.equal(byToken.status, 201, byToken.text);
  const tokenTask = await stored(byToken.json.id);
  assert.deepEqual(tokenTask.creator, theUsers);
  assert.deepEqual(tokenTask.activity, [throughToken(tokenTask.id)]);

  const byLogin = await call(server, 'POST', '/api/tasks', login, task('created through a login'));
  assert.equal(byLogin.status, 201, byLogin.text);
  const loginTask = await stored(byLogin.json.id);
  assert.deepEqual(loginTask.creator, theUsers);
  assert.deepEqual(loginTask.activity, [throughLogin(loginTask.id)]);

  // The batch: one row for each task it inserts.
  const batch = await call(server, 'POST', '/api/tasks/batch-create', writer.token, {
    tasks: [task('batch one'), task('batch two')],
  });
  assert.equal(batch.status, 201, batch.text);
  assert.equal(batch.json.length, 2, batch.text);
  for (const created of batch.json) {
    const written = await stored(created.id);
    assert.deepEqual(written.creator, theUsers);
    assert.deepEqual(written.activity, [throughToken(written.id)]);
  }

  // The paired create: the subject, and the check written beside it.
  const paired = await call(server, 'POST', '/api/tasks', writer.token, {
    title: 'a subject',
    projectId,
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    verification: { title: '[VERIFY] a subject' },
  });
  assert.equal(paired.status, 201, paired.text);
  for (const id of [paired.json.id, paired.json.verification.id]) {
    const written = await stored(id);
    assert.deepEqual(written.creator, theUsers);
    assert.deepEqual(written.activity, [throughToken(written.id)]);
  }

  // A dry run writes nothing, and neither does a write the token was not granted.
  const preview = await call(server, 'POST', '/api/tasks/batch-create', writer.token, {
    dryRun: true,
    tasks: [task('only previewed')],
  });
  assert.equal(preview.status, 201, preview.text);
  const refused = await call(server, 'POST', '/api/tasks', reader.token, task('refused its scope'));
  assert.equal(refused.status, 403, refused.text);

  // Six tasks, six rows: one each, nothing recorded twice, no task for the preview or the refusal.
  const titles = await sql.query('SELECT title FROM task WHERE owner_id = $1 ORDER BY title', [userId]);
  assert.deepEqual(titles.rows.map((row) => row.title), [
    '[VERIFY] a subject',
    'a subject',
    'batch one',
    'batch two',
    'created through a login',
    'created through a token',
  ]);
  const recorded = await sql.query(
    `SELECT credential_kind, credential_id, count(*)::int AS rows,
            count(DISTINCT payload->>'taskId')::int AS tasks,
            bool_and(payload->>'taskId' IN (SELECT id::text FROM task WHERE owner_id = $1)) AS all_theirs
       FROM activity WHERE actor_id = $1 AND type = 'task.created' GROUP BY 1, 2 ORDER BY 1`,
    [userId],
  );
  assert.deepEqual(recorded.rows, [
    { credential_kind: 'LOGIN', credential_id: null, rows: 1, tasks: 1, all_theirs: true },
    { credential_kind: 'PAT', credential_id: writer.id, rows: 5, tasks: 5, all_theirs: true },
  ]);
});
