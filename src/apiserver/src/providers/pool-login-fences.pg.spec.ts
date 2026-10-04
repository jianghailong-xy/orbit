import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

/**
 * Who a ChatGPT login, and the session token minted on it, may belong to — the two composite fences, on a
 * database every migration has run on.
 *
 * A ChatGPT account signed into a Codex pool belongs to a PERSON of the pool (0371, the 2026-10-03
 * direction): whoever signed it in, its owner or anybody the pool is shared with, so
 * `pool_codex_login`'s (pool_id, user_id) → provider_pool_person(pool_id, user_id) admits every one of a
 * pool's people — and nobody the pool does not hold — and a person leaving takes the logins they signed
 * in with them. The session token minted off a login stays the pool OWNER's alone (0324's (pool_id,
 * user_id) → provider_pool(id, owner_id)): a member's sessions run under their own `pool_gateway_token`,
 * and no `pool_login_token` is ever minted for them. Two migrations have touched these tables since the
 * fences were first drawn — 0355 drops `pool_login_token.account_id` with its own foreign key, and 0371
 * swaps `pool_codex_login`'s fence on purpose — and nothing else may drop or loosen either. This holds
 * them to that:
 *   * each fence, read back with pg_get_constraintdef, is what its migration's own statement makes: the
 *     statement is matched word for word in the migration file and replayed in a transaction that is
 *     rolled back, so "as 0371/0324 wrote it" is PostgreSQL's reading of the original, not a guess at it;
 *   * the login fence admits the owner and a member alike and refuses the owner of another pool, and the
 *     token fence refuses that same member and takes the owner, so the two answers cannot drift into each
 *     other.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/** Both fences, each with the statement its migration adds it by, verbatim, and that statement as
 *  pg_get_constraintdef reads it back (MATCH SIMPLE and ON UPDATE NO ACTION are the defaults, which it
 *  leaves unsaid). */
const FENCES = [
  {
    migration: '0371_pool_login_person',
    table: 'pool_codex_login',
    name: 'pool_codex_login_pool_id_user_id_fkey',
    statement: [
      'ALTER TABLE "pool_codex_login" ADD CONSTRAINT "pool_codex_login_pool_id_user_id_fkey"',
      '  FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool_person"("pool_id", "user_id")',
      '  ON DELETE CASCADE ON UPDATE NO ACTION;',
    ].join('\n'),
    definition:
      'FOREIGN KEY (pool_id, user_id) REFERENCES provider_pool_person(pool_id, user_id) ON DELETE CASCADE',
  },
  {
    migration: '0324_pool_login_gateway',
    table: 'pool_login_token',
    name: 'pool_login_token_pool_id_user_id_fkey',
    statement: [
      'ALTER TABLE "pool_login_token" ADD CONSTRAINT "pool_login_token_pool_id_user_id_fkey"',
      '  FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool"("id", "owner_id")',
      '  ON DELETE CASCADE ON UPDATE NO ACTION;',
    ].join('\n'),
    definition: 'FOREIGN KEY (pool_id, user_id) REFERENCES provider_pool(id, owner_id) ON DELETE CASCADE',
  },
] as const;

/** A driver error carrying this SQLSTATE and naming this constraint. */
const pgError = (code: string, constraint: string) => (e: unknown) => {
  const error = e as { code?: string; constraint?: string };
  assert.equal(error.code, code, String(e));
  assert.equal(error.constraint, constraint, String(e));
  return true;
};

test('the login fence of 0371 and the token fence of 0324, after every migration', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const definitionOf = async (table: string, name: string) =>
    (await sql.query<{ definition: string }>(
      'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2',
      [table, name],
    )).rows.map((row) => row.definition);

  await t.test('each fence reads back exactly as 0371 / 0324 wrote it', async () => {
    const onDisk = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = (await sql.query<{ name: string }>(
      'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    )).rows.map((row) => row.name).sort();
    assert.deepEqual(applied, onDisk, 'this is not a database every migration has run on');

    for (const fence of FENCES) {
      const written = readFileSync(path.join(MIGRATIONS, fence.migration, 'migration.sql'), 'utf8');
      assert.ok(written.includes(fence.statement), `${fence.migration} no longer adds ${fence.name} by its original statement`);
      assert.deepEqual(await definitionOf(fence.table, fence.name), [fence.definition], `${fence.name} after every migration`);
      // DEFINITION is PostgreSQL's own reading of that statement: replayed alone on this database, in a
      // transaction that is rolled back, it reads back as exactly that.
      await sql.query('BEGIN');
      try {
        await sql.query(`ALTER TABLE "${fence.table}" DROP CONSTRAINT "${fence.name}"`);
        await sql.query(fence.statement);
        assert.deepEqual(await definitionOf(fence.table, fence.name), [fence.definition], `${fence.migration}'s statement replayed`);
      } finally {
        await sql.query('ROLLBACK');
      }
    }
  });

  const newUser = async (name: string) =>
    (await prisma.user.create({
      data: { email: `login-fence-${name}-${randomUUID()}@example.invalid`, name, passwordHash: 'not-a-login' },
    })).id;
  const ann = await newUser('ann'); // the pool's owner
  const mia = await newUser('mia'); // a person Ann's pool is shared with
  const otto = await newUser('otto'); // the owner of another pool, in no way in Ann's
  const codexPool = async (ownerId: string) =>
    (await sql.query<{ id: string }>(
      `INSERT INTO provider_pool (id, slug, label, owner_id, engine, shared, updated_at)
       VALUES ($1, $2, 'My ChatGPT', $3, 'codex', false, now()) RETURNING id`,
      [randomUUID(), `login-fence-${randomUUID()}`, ownerId],
    )).rows[0].id;
  const pool = await codexPool(ann);
  const ottos = await codexPool(otto);
  // As 0358 has it: the owner is a person of their own pool, and so is everybody they add — Otto is one
  // of his own, which is exactly why a login of his in Ann's pool is the fence's business.
  await sql.query(
    `INSERT INTO provider_pool_person (pool_id, user_id, role) VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
    [pool, ann, mia],
  );
  await sql.query(`INSERT INTO provider_pool_person (pool_id, user_id, role) VALUES ($1, $2, 'ADMIN')`, [ottos, otto]);

  await t.test('a ChatGPT login naming a person of the pool goes in; anybody the pool does not hold is refused by the fence', async () => {
    const login = (poolId: string, userId: string) =>
      sql.query(
        `INSERT INTO pool_codex_login (pool_id, user_id, account_id, access_token_enc, refresh_token_enc, expires_at, updated_at)
         VALUES ($1, $2, $3, 'iv:tag:ct', 'iv:tag:ct', now() + interval '1 day', now())`,
        [poolId, userId, `account-${randomUUID()}`],
      );
    // Whoever signed it in: the pool's owner, or somebody it is shared with (0371).
    assert.equal((await login(pool, ann)).rowCount, 1);
    assert.equal((await login(pool, mia)).rowCount, 1);
    // The owner of another pool holds a login there, not here.
    await assert.rejects(login(pool, otto), pgError('23503', 'pool_codex_login_pool_id_user_id_fkey'));
    assert.equal((await login(ottos, otto)).rowCount, 1);
  });

  await t.test('a login pool’s session token is still the owner’s alone: the member the login admits is refused by the fence', async () => {
    const token = async (userId: string) => {
      const session = await prisma.session.create({
        data: { title: 'login fence', prompt: 'hello', ownerId: userId, creatorId: userId },
        select: { id: true },
      });
      return sql.query(
        `INSERT INTO pool_login_token (id, token_hash, pool_id, user_id, session_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
        [randomUUID(), sha256(randomUUID()), pool, userId, session.id],
      );
    };
    await assert.rejects(token(mia), pgError('23503', 'pool_login_token_pool_id_user_id_fkey'));
    await assert.rejects(token(otto), pgError('23503', 'pool_login_token_pool_id_user_id_fkey'));
    assert.equal((await token(ann)).rowCount, 1);
  });

  await t.test('a person leaving the pool takes the logins they signed in with them', async () => {
    const held = async (userId: string) =>
      (await sql.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pool_codex_login WHERE pool_id = $1 AND user_id = $2',
        [pool, userId],
      )).rows[0].n;
    // Mia's login is in from the first case above; the owner's is beside it and stays.
    assert.equal(await held(mia), '1');
    await sql.query('DELETE FROM provider_pool_person WHERE pool_id = $1 AND user_id = $2', [pool, mia]);
    assert.equal(await held(mia), '0');
    assert.equal(await held(ann), '1');
  });
});
