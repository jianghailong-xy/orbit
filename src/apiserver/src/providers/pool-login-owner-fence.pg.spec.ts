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
 * The pool-owner fence on a ChatGPT login, on a database every migration has run on.
 *
 * A ChatGPT account signed into a Codex pool runs its owner's sessions and nobody else's. Since 0358 a
 * pool of one's own takes people and API keys as well (the 2026-10-02 direction), so the people its owner
 * adds sit right beside its logins. Two composite foreign keys hold the line in the database, each
 * (pool_id, user_id) → provider_pool(id, owner_id) ON DELETE CASCADE: 0323's on `pool_codex_login`, the
 * login itself, and 0324's on `pool_login_token`, a session token minted on one. Later migrations touch
 * both tables — 0355 drops `pool_login_token.account_id` with its own foreign key — and none of them may
 * drop or loosen either fence. This holds them to that:
 *   * each fence, read back with pg_get_constraintdef, is what its migration's own statement makes: the
 *     statement is matched word for word in the migration file and replayed in a transaction that is
 *     rolled back, so "as 0323/0324 wrote it" is PostgreSQL's reading of the original, not a guess at it;
 *   * a row naming anybody but the pool's owner — a person the owner added to the pool, the owner of
 *     another pool — is refused by that very constraint, and the same row naming the owner goes in, so a
 *     write failing for some other reason cannot pass for the refusal.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');

/** Both fences, each with the statement its migration adds it by, verbatim. */
const FENCES = [
  {
    migration: '0323_pool_codex_login',
    table: 'pool_codex_login',
    name: 'pool_codex_login_pool_id_user_id_fkey',
    statement: [
      'ALTER TABLE "pool_codex_login" ADD CONSTRAINT "pool_codex_login_pool_id_user_id_fkey"',
      '  FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool"("id", "owner_id")',
      '  ON DELETE CASCADE ON UPDATE NO ACTION;',
    ].join('\n'),
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
  },
] as const;

/** Either statement as pg_get_constraintdef reads it back: MATCH SIMPLE and ON UPDATE NO ACTION are the
 *  defaults, which it leaves unsaid. */
const DEFINITION = 'FOREIGN KEY (pool_id, user_id) REFERENCES provider_pool(id, owner_id) ON DELETE CASCADE';

/** A driver error carrying this SQLSTATE and naming this constraint. */
const pgError = (code: string, constraint: string) => (e: unknown) => {
  const error = e as { code?: string; constraint?: string };
  assert.equal(error.code, code, String(e));
  assert.equal(error.constraint, constraint, String(e));
  return true;
};

test('the pool-owner fence of 0323 and 0324, after every migration', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  await t.test('each fence reads back exactly as 0323 / 0324 wrote it', async () => {
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
      assert.deepEqual(await definitionOf(fence.table, fence.name), [DEFINITION], `${fence.name} after every migration`);
      // DEFINITION is PostgreSQL's own reading of that statement: replayed alone on this database, in a
      // transaction that is rolled back, it reads back as exactly that.
      await sql.query('BEGIN');
      try {
        await sql.query(`ALTER TABLE "${fence.table}" DROP CONSTRAINT "${fence.name}"`);
        await sql.query(fence.statement);
        assert.deepEqual(await definitionOf(fence.table, fence.name), [DEFINITION], `${fence.migration}'s statement replayed`);
      } finally {
        await sql.query('ROLLBACK');
      }
    }
  });

  const newUser = async (name: string) =>
    (await prisma.user.create({
      data: { email: `owner-fence-${name}-${randomUUID()}@example.invalid`, name, passwordHash: 'not-a-login' },
    })).id;
  const ann = await newUser('ann'); // the pool's owner
  const mia = await newUser('mia'); // a person Ann added to her pool
  const otto = await newUser('otto'); // the owner of another pool
  const codexPool = async (ownerId: string) =>
    (await sql.query<{ id: string }>(
      `INSERT INTO provider_pool (id, slug, label, owner_id, engine, shared, updated_at)
       VALUES ($1, $2, 'My ChatGPT', $3, 'codex', false, now()) RETURNING id`,
      [randomUUID(), `owner-fence-${randomUUID()}`, ownerId],
    )).rows[0].id;
  const pool = await codexPool(ann);
  await codexPool(otto);
  // As 0358 has it: the owner is a person of their own pool, and so is everybody they add.
  await sql.query(
    `INSERT INTO provider_pool_person (pool_id, user_id, role) VALUES ($1, $2, 'ADMIN'), ($1, $3, 'MEMBER')`,
    [pool, ann, mia],
  );
  const strangers = [mia, otto];

  await t.test('a ChatGPT login naming anybody but the pool’s owner is refused by the fence', async () => {
    const login = (userId: string) =>
      sql.query(
        `INSERT INTO pool_codex_login (pool_id, user_id, account_id, access_token_enc, refresh_token_enc, expires_at, updated_at)
         VALUES ($1, $2, $3, 'iv:tag:ct', 'iv:tag:ct', now() + interval '1 day', now())`,
        [pool, userId, `account-${randomUUID()}`],
      );
    for (const stranger of strangers) {
      await assert.rejects(login(stranger), pgError('23503', 'pool_codex_login_pool_id_user_id_fkey'));
    }
    assert.equal((await login(ann)).rowCount, 1);
  });

  await t.test('a login pool’s session token naming anybody but the pool’s owner is refused by the fence', async () => {
    const token = async (userId: string) => {
      const session = await prisma.session.create({
        data: { title: 'owner fence', prompt: 'hello', ownerId: userId, creatorId: userId },
        select: { id: true },
      });
      return sql.query(
        `INSERT INTO pool_login_token (id, token_hash, pool_id, user_id, session_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
        [randomUUID(), sha256(randomUUID()), pool, userId, session.id],
      );
    };
    for (const stranger of strangers) {
      await assert.rejects(token(stranger), pgError('23503', 'pool_login_token_pool_id_user_id_fkey'));
    }
    assert.equal((await token(ann)).rowCount, 1);
  });
});
