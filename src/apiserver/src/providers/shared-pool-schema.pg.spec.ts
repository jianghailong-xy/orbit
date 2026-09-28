import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { sha256 } from '../common/crypto.util';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

/**
 * Shared Codex pools' tables (migration 0321) against a real PostgreSQL.
 *
 * What makes a shared pool safe to hand keys to is largely held by the database, so only a database can
 * show it: the composite foreign key that keeps a key's contributor inside the key's own pool, the unique
 * fingerprint that keeps one key from going in twice, the cascades that take a person's keys and session
 * tokens with them — which is what makes a removed person's token stop working at once — and the CHECK
 * that keeps the personal Claude pools 0265 made exactly what they were. Each refusal is paired with the
 * same write going through, so a write failing for some other reason cannot pass for a refusal.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

/** A driver error carrying this SQLSTATE, and this constraint when one is named. */
const pgError = (code: string, constraint?: string) => (e: unknown) => {
  const error = e as { code?: string; constraint?: string };
  assert.equal(error.code, code, String(e));
  if (constraint) assert.equal(error.constraint, constraint, String(e));
  return true;
};

test('shared pools (migration 0321) against PostgreSQL', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  const newUser = async (name: string) =>
    (await prisma.user.create({
      data: { email: `shared-schema-${name}-${randomUUID()}@example.invalid`, name, passwordHash: 'not-a-login' },
    })).id;
  const ann = await newUser('ann');
  const mia = await newUser('mia');
  const otto = await newUser('otto');

  const sharedPool = async (label: string, ownerId: string) =>
    (await sql.query<{ id: string }>(
      `INSERT INTO provider_pool (id, slug, label, owner_id, engine, shared, updated_at)
       VALUES ($1, $2, $3, $4, 'codex', true, now()) RETURNING id`,
      [randomUUID(), `shared-schema-${randomUUID()}`, label, ownerId],
    )).rows[0].id;
  const person = (poolId: string, userId: string, role = 'MEMBER') =>
    sql.query('INSERT INTO provider_pool_person (pool_id, user_id, role) VALUES ($1, $2, $3)', [poolId, userId, role]);
  const key = (poolId: string, contributorId: string, secret = `sk-proj-${randomUUID()}`) =>
    sql.query<{ id: string }>(
      `INSERT INTO pool_api_key (id, pool_id, contributor_id, label, key_fingerprint, key_hint, secret_encrypted, updated_at)
       VALUES ($1, $2, $3, 'k', $4, $5, 'iv:tag:ct', now()) RETURNING id`,
      [randomUUID(), poolId, contributorId, sha256(secret), secret.slice(-4)],
    );
  const session = async (ownerId: string) =>
    (await prisma.session.create({
      data: { title: 'shared schema', prompt: 'hello', ownerId, creatorId: ownerId },
      select: { id: true },
    })).id;
  const token = (poolId: string, userId: string, sessionId: string) =>
    sql.query(
      `INSERT INTO pool_gateway_token (id, token_hash, pool_id, user_id, session_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
      [randomUUID(), sha256(randomUUID()), poolId, userId, sessionId],
    );
  const usage = (poolId: string, keyId: string, userId: string) =>
    sql.query(
      `INSERT INTO pool_usage (pool_id, key_id, user_id, window_start, input_tokens, output_tokens, cost_micros, updated_at)
       VALUES ($1, $2, $3, date_trunc('month', now())::date, 10, 5, 1000, now())`,
      [poolId, keyId, userId],
    );
  const count = async (table: string, where: string, params: unknown[]) =>
    (await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;

  await t.test('0321 replayed onto this server: the provider_pool columns, the four tables, and session.pool_key_id', async () => {
    const applied = await sql.query(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
         FROM _prisma_migrations WHERE migration_name = '0321_shared_provider_pool'`,
    );
    assert.deepEqual(applied.rows, [{ finished: true, rolled_back: false }]);
    const columns = await sql.query<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'provider_pool' AND column_name IN ('engine', 'shared', 'members_can_add', 'own_key_first'))
            OR (table_name = 'session' AND column_name = 'pool_key_id'))
        ORDER BY table_name, column_name`,
    );
    assert.deepEqual(columns.rows, [
      { table_name: 'provider_pool', column_name: 'engine', column_default: "'claude'::text", is_nullable: 'NO' },
      { table_name: 'provider_pool', column_name: 'members_can_add', column_default: 'true', is_nullable: 'NO' },
      { table_name: 'provider_pool', column_name: 'own_key_first', column_default: 'true', is_nullable: 'NO' },
      { table_name: 'provider_pool', column_name: 'shared', column_default: 'false', is_nullable: 'NO' },
      { table_name: 'session', column_name: 'pool_key_id', column_default: null, is_nullable: 'YES' },
    ]);
    const keys = await sql.query<{ relation: string; name: string; definition: string }>(
      `SELECT c.conrelid::regclass::text AS relation, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid::regclass::text IN ('provider_pool_person', 'pool_api_key', 'pool_gateway_token', 'pool_usage')
        ORDER BY 1, 2`,
    );
    assert.deepEqual(keys.rows, [
      { relation: 'pool_api_key', name: 'pool_api_key_pool_id_contributor_id_fkey', definition: 'FOREIGN KEY (pool_id, contributor_id) REFERENCES provider_pool_person(pool_id, user_id) ON DELETE CASCADE' },
      { relation: 'pool_gateway_token', name: 'pool_gateway_token_pool_id_user_id_fkey', definition: 'FOREIGN KEY (pool_id, user_id) REFERENCES provider_pool_person(pool_id, user_id) ON DELETE CASCADE' },
      { relation: 'pool_gateway_token', name: 'pool_gateway_token_session_id_fkey', definition: 'FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE' },
      { relation: 'pool_usage', name: 'pool_usage_key_id_pool_id_fkey', definition: 'FOREIGN KEY (key_id, pool_id) REFERENCES pool_api_key(id, pool_id) ON DELETE CASCADE' },
      { relation: 'pool_usage', name: 'pool_usage_user_id_fkey', definition: 'FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE' },
      { relation: 'provider_pool_person', name: 'provider_pool_person_pool_id_fkey', definition: 'FOREIGN KEY (pool_id) REFERENCES provider_pool(id) ON DELETE CASCADE' },
      { relation: 'provider_pool_person', name: 'provider_pool_person_user_id_fkey', definition: 'FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE' },
    ]);
    // `session.pool_key_id` names a key by no foreign key, as 0268's pool member column names none.
    const sessionKeys = await sql.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'session'::regclass AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE '%pool_key_id%'`,
    );
    assert.equal(sessionKeys.rowCount, 0);
  });

  await t.test('a pool made the 0265 way is a personal Claude pool, and the engine check holds shared and codex together', async () => {
    const personal = await prisma.providerPool.create({
      data: { slug: `shared-schema-${randomUUID()}`, label: 'Claude accounts', ownerId: ann },
    });
    assert.deepEqual(
      { engine: personal.engine, shared: personal.shared, membersCanAdd: personal.membersCanAdd, ownKeyFirst: personal.ownKeyFirst },
      { engine: 'claude', shared: false, membersCanAdd: true, ownKeyFirst: true },
    );
    // A personal pool may also be `codex` (migration 0323): the pool one's own ChatGPT login runs on. What
    // the check still holds together is that a SHARED pool is Codex and nothing else — the one credential
    // several people may share is an organization/project key, never anybody's login.
    const ownLogin = await prisma.providerPool.create({
      data: { slug: `shared-schema-${randomUUID()}`, label: 'My ChatGPT', ownerId: ann, engine: 'codex' },
    });
    assert.deepEqual({ engine: ownLogin.engine, shared: ownLogin.shared }, { engine: 'codex', shared: false });
    for (const [engine, shared] of [['claude', true], ['kimi', true], ['kimi', false]] as const) {
      await assert.rejects(
        sql.query(
          `INSERT INTO provider_pool (id, slug, label, owner_id, engine, shared, updated_at)
           VALUES ($1, $2, 'bad', $3, $4, $5, now())`,
          [randomUUID(), `shared-schema-${randomUUID()}`, ann, engine, shared],
        ),
        pgError('23514', 'provider_pool_engine_check'),
      );
    }
    assert.ok(await sharedPool('Team Codex', ann));
  });

  await t.test("a key's contributor has to be a person of the key's own pool", async () => {
    const pool = await sharedPool('Team Codex', ann);
    const other = await sharedPool('Other team', otto);
    await person(pool, ann, 'ADMIN');
    await person(other, otto, 'ADMIN');
    // Otto is a person of a pool — not of this one.
    await assert.rejects(key(pool, otto), pgError('23503', 'pool_api_key_pool_id_contributor_id_fkey'));
    await assert.rejects(key(pool, mia), pgError('23503', 'pool_api_key_pool_id_contributor_id_fkey'));
    await person(pool, mia);
    assert.equal((await key(pool, mia)).rowCount, 1);
    // A session token is bound the same way: to a person of the pool.
    const hers = await session(mia);
    await assert.rejects(token(pool, otto, hers), pgError('23503', 'pool_gateway_token_pool_id_user_id_fkey'));
    assert.equal((await token(pool, mia, hers)).rowCount, 1);
  });

  await t.test('one key goes into a pool once, by its fingerprint — whoever adds it; another pool may hold it too', async () => {
    const pool = await sharedPool('Team Codex', ann);
    const other = await sharedPool('Other team', ann);
    await person(pool, ann, 'ADMIN');
    await person(pool, mia);
    await person(other, ann, 'ADMIN');
    const secret = `sk-proj-${randomUUID()}`;
    await key(pool, ann, secret);
    await assert.rejects(key(pool, ann, secret), pgError('23505', 'pool_api_key_pool_id_key_fingerprint_key'));
    await assert.rejects(key(pool, mia, secret), pgError('23505', 'pool_api_key_pool_id_key_fingerprint_key'));
    assert.equal((await key(other, ann, secret)).rowCount, 1);
    assert.equal((await key(pool, mia)).rowCount, 1);
  });

  await t.test("a person removed takes their keys, their keys' ledger and their session tokens at once; the pool deleted takes everything", async () => {
    const pool = await sharedPool('Team Codex', ann);
    await person(pool, ann, 'ADMIN');
    await person(pool, mia);
    const annKey = (await key(pool, ann)).rows[0].id;
    const miaKey = (await key(pool, mia)).rows[0].id;
    const hers = await session(mia);
    const his = await session(ann);
    await token(pool, mia, hers);
    await token(pool, ann, his);
    await usage(pool, miaKey, ann);
    await usage(pool, annKey, mia);

    await sql.query('DELETE FROM provider_pool_person WHERE pool_id = $1 AND user_id = $2', [pool, mia]);
    assert.deepEqual(
      {
        keys: await count('pool_api_key', 'pool_id = $1 AND contributor_id = $2', [pool, mia]),
        tokens: await count('pool_gateway_token', 'pool_id = $1 AND user_id = $2', [pool, mia]),
        ledgerOnHerKey: await count('pool_usage', 'key_id = $1', [miaKey]),
      },
      { keys: 0, tokens: 0, ledgerOnHerKey: 0 },
    );
    // Ann's key and token stand — and so does what Mia spent on Ann's key, which is Ann's key's record.
    assert.deepEqual(
      {
        keys: await count('pool_api_key', 'pool_id = $1', [pool]),
        tokens: await count('pool_gateway_token', 'pool_id = $1', [pool]),
        ledger: await count('pool_usage', 'pool_id = $1', [pool]),
      },
      { keys: 1, tokens: 1, ledger: 1 },
    );
    // Her session is hers still; only the token that ran it through this pool is gone.
    assert.equal(await count('session', 'id = $1', [hers]), 1);

    await sql.query('DELETE FROM provider_pool WHERE id = $1', [pool]);
    for (const table of ['provider_pool_person', 'pool_api_key', 'pool_gateway_token', 'pool_usage']) {
      assert.equal(await count(table, 'pool_id = $1', [pool]), 0, `${table} kept a row of the deleted pool`);
    }
    assert.equal(await count('session', 'id = ANY($1::uuid[])', [[hers, his]]), 2);
  });

  await t.test("a session deleted takes its tokens; the person and the pool stay", async () => {
    const pool = await sharedPool('Team Codex', ann);
    await person(pool, ann, 'ADMIN');
    const his = await session(ann);
    await token(pool, ann, his);
    await sql.query('DELETE FROM session WHERE id = $1', [his]);
    assert.equal(await count('pool_gateway_token', 'session_id = $1', [his]), 0);
    assert.equal(await count('provider_pool_person', 'pool_id = $1', [pool]), 1);
  });

  await t.test('a role, a key state and a share cap outside what they can be are refused', async () => {
    const pool = await sharedPool('Team Codex', ann);
    await assert.rejects(person(pool, ann, 'OWNER'), pgError('23514', 'provider_pool_person_role_check'));
    await person(pool, ann, 'ADMIN');
    const id = (await key(pool, ann)).rows[0].id;
    await assert.rejects(
      sql.query(`UPDATE pool_api_key SET state = 'EXPIRED' WHERE id = $1`, [id]),
      pgError('23514', 'pool_api_key_state_check'),
    );
    await assert.rejects(
      sql.query('UPDATE pool_api_key SET share_cap = -1 WHERE id = $1', [id]),
      pgError('23514', 'pool_api_key_share_cap_check'),
    );
    for (const state of ['INVALID', 'DISABLED', 'ACTIVE']) {
      await sql.query('UPDATE pool_api_key SET state = $2 WHERE id = $1', [id, state]);
    }
    await sql.query('UPDATE pool_api_key SET share_cap = 0 WHERE id = $1', [id]);
    await sql.query('UPDATE pool_api_key SET share_cap = NULL WHERE id = $1', [id]);
  });
});
