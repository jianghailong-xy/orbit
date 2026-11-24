/**
 * Migrations 1551 (the drive_* tables become document_*) and 1592 (they, and 1560's document_sync, become drive_*
 * again), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-tables-rename.pg.spec.ts
 *
 *   (1) the migrated database has no table, view, index, sequence or constraint whose name begins `document_`, and the
 *       eleven drive_* tables are there;
 *   (2) the drive migrations as they were applied (1283, 1327, 1339, 1438, 1439, 1440, 1448, read from their files) are
 *       replayed into a scratch schema and filled with a row of every kind; 1551 then renames every table, constraint,
 *       index and sequence `drive_*` to `document_*` and creates nothing, every table keeps its row count and the text of
 *       every row. 1560 adds document_sync with a row; 1592 then renames every table, constraint, index and sequence
 *       `document_*` back to `drive_*` and creates nothing: every name is the one it had before 1551, every table keeps
 *       its row count and the text of every row, the renamed sequence goes on numbering the change feed, and the names
 *       it leaves are exactly the names the fully migrated database has (which `prisma migrate diff` holds to
 *       schema.prisma). Run a second time, each changes nothing.
 *
 * Not destructive: the scratch schema is dropped, and every public row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const migration = (dir: string) => readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
/** What created and shaped the drive tables before 1551; 1340 is share_link's and stays out of the scratch schema. */
const BEFORE_1551 = [
  '1283_drive_chunk_store', '1327_drive_name_layer', '1339_drive_mount_credential', '1438_drive_removed_entry',
  '1439_drive_entry_name_trgm', '1440_drive_trash_group_marking', '1448_drive_purge_fk_indexes',
];
const MIGRATION_1551 = migration('1551_documents_tables');
const MIGRATION_1560 = migration('1560_document_sync');
const MIGRATION_1592 = migration('1592_drive_tables');
/** The ten tables 1551 renamed; 1592 renames them and document_sync (1560). */
const BASES = ['staging', 'staging_chunk', 'version_chunk', 'trash_group', 'entry', 'version', 'commit',
  'removed_entry', 'change', 'mount_credential'];
const ALL = [...BASES, 'sync'];
type Prefix = 'drive_' | 'document_';

/** Every name a schema's drive or document tables carry: the tables, their constraints, indexes and owned sequences. */
async function names(sql: Client, schema: string, prefix: Prefix, bases = BASES): Promise<string[]> {
  const tables = bases.map((base) => prefix + base);
  const { rows } = await sql.query<{ n: string }>(`
    SELECT 'table ' || c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = $1 AND c.relkind = 'r' AND c.relname = ANY ($2)
    UNION ALL
    SELECT 'constraint ' || t.relname || '.' || k.conname || ' ' || k.contype::text FROM pg_constraint k
      JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname = $1 AND t.relname = ANY ($2)
    UNION ALL
    SELECT 'index ' || t.relname || '.' || i.relname FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
     WHERE ns.nspname = $1 AND t.relname = ANY ($2)
    UNION ALL
    SELECT 'sequence ' || s.relname FROM pg_class s JOIN pg_namespace ns ON ns.oid = s.relnamespace
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype = 'a'
      JOIN pg_class t ON t.oid = d.refobjid
     WHERE ns.nspname = $1 AND s.relkind = 'S' AND t.relname = ANY ($2)
    ORDER BY 1`, [schema, tables]);
  return rows.map((row) => row.n).sort();
}

/** Every object of any kind, in a schema, whose name begins with the prefix: relations and constraints. */
async function prefixed(sql: Client, schema: string, prefix: Prefix): Promise<string[]> {
  const { rows } = await sql.query<{ n: string }>(`
    SELECT c.relkind::text || ' ' || c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = $1 AND c.relname LIKE $2
    UNION ALL
    SELECT 'constraint ' || k.conname FROM pg_constraint k JOIN pg_namespace ns ON ns.oid = k.connamespace
     WHERE ns.nspname = $1 AND k.conname LIKE $2
    ORDER BY 1`, [schema, `${prefix.slice(0, -1)}\\_%`]);
  return rows.map((row) => row.n);
}

/** Per table: how many rows, and a digest of the text of every row. A rename changes neither. */
async function contents(sql: Client, schema: string, prefix: Prefix, bases = BASES): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const base of bases) {
    const { rows } = await sql.query<{ n: number; digest: string }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM ${sql.escapeIdentifier(schema)}.${sql.escapeIdentifier(prefix + base)} t`);
    out[base] = `${rows[0].n} ${rows[0].digest}`;
  }
  return out;
}

test('migrations 1551 and 1592 rename the drive tables there and back without touching a row', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const scratch = `pre1551_${randomUUID().slice(0, 8)}`;
  t.after(async () => {
    await sql.query('RESET search_path').catch(() => undefined);
    await sql.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`).catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  // (1) The database every migration ran on.
  assert.deepEqual(await prefixed(sql, 'public', 'document_'), [], 'no relation or constraint named document_* is left');
  const migrated = await names(sql, 'public', 'drive_', ALL);
  assert.deepEqual(migrated.filter((n) => n.startsWith('table ')), ALL.map((base) => `table drive_${base}`).sort());
  assert.ok(migrated.includes('sequence drive_change_seq_seq'), 'the change feed has its sequence');

  // (2) The drive tables as they stood before 1551, from the migration files that made them, in a scratch schema. Their
  // foreign keys to "user", "runner" and "file_blob" find the public tables through the search path.
  await sql.query(`CREATE SCHEMA ${scratch}`);
  await sql.query(`SET search_path TO ${scratch}, public`);
  for (const dir of BEFORE_1551) await sql.query(migration(dir));
  assert.equal((await names(sql, scratch, 'drive_')).filter((n) => n.startsWith('table ')).length, 10);

  const run = randomUUID().slice(0, 8);
  const owner = randomUUID();
  const runner = randomUUID();
  const sha = `${run}${'0'.repeat(56)}`;
  await sql.query(`INSERT INTO public."user" ("id", "email", "name", "password_hash") VALUES ($1, $2, 'owner', 'x')`,
    [owner, `documents-rename-${run}@documents-rename.invalid`]);
  await sql.query(`INSERT INTO public."runner" ("id", "owner_id", "name", "token_hash") VALUES ($1, $2, 'a runner', $3)`,
    [runner, owner, `documents-rename-${runner}`]);
  await sql.query(`INSERT INTO public."file_blob" ("sha256", "size_bytes", "storage") VALUES ($1, 5, 'local')`, [sha]);

  const [root, folder, file, version, oldVersion, group, staging, upload] = Array.from({ length: 8 }, () => randomUUID());
  await sql.query('BEGIN');
  await sql.query(`INSERT INTO drive_trash_group ("id", "owner_id", "kind", "folder_id", "folder_path", "actor_kind")
                   VALUES ($1, $2, 'VERSION', $3, '/reports', 'OWNER')`, [group, owner, folder]);
  await sql.query(`INSERT INTO drive_entry ("id", "owner_id", "parent_id", "kind", "name", "last_writer_kind")
                   VALUES ($1, $2, NULL, 'FOLDER', '', 'OWNER'), ($3, $2, $1, 'FOLDER', 'reports', 'OWNER')`,
    [root, owner, folder]);
  await sql.query(`INSERT INTO drive_entry ("id", "owner_id", "parent_id", "kind", "name", "current_version_id", "size_bytes", "last_writer_kind")
                   VALUES ($1, $2, $3, 'FILE', 'q3.txt', $4, 5, 'AGENT')`, [file, owner, folder, version]);
  await sql.query(`INSERT INTO drive_version ("id", "owner_id", "entry_id", "size_bytes", "chunk_count", "writer_kind")
                   VALUES ($1, $2, $3, 5, 1, 'AGENT')`, [version, owner, file]);
  await sql.query(`INSERT INTO drive_version ("id", "owner_id", "entry_id", "size_bytes", "chunk_count", "writer_kind", "replaced_at", "trash_group_id")
                   VALUES ($1, $2, $3, 5, 1, 'OWNER', now(), $4)`, [oldVersion, owner, file, group]);
  await sql.query('COMMIT');
  await sql.query(`INSERT INTO drive_version_chunk ("version_id", "idx", "owner_id", "offset", "size_bytes", "sha256")
                   VALUES ($1, 0, $3, 0, 5, $4), ($2, 0, $3, 0, 5, $4)`, [version, oldVersion, owner, sha]);
  await sql.query(`INSERT INTO drive_staging ("id", "owner_id", "source", "entry_id", "runner_id", "generation", "dirty")
                   VALUES ($1, $2, 'MOUNT', $3, $4, 1, true)`, [staging, owner, file, runner]);
  await sql.query(`INSERT INTO drive_staging ("id", "owner_id", "source", "parent_id", "name", "declared_size")
                   VALUES ($1, $2, 'OWNER_UPLOAD', $3, 'notes.md', 5)`, [upload, owner, folder]);
  await sql.query(`INSERT INTO drive_staging_chunk ("staging_id", "idx", "owner_id", "sha256", "size_bytes")
                   VALUES ($1, 0, $2, $3, 5)`, [upload, owner, sha]);
  await sql.query(`INSERT INTO drive_commit ("owner_id", "commit_id", "entry_id", "result")
                   VALUES ($1, $2, $3, '{"seq": "2"}')`, [owner, `commit-${run}`, file]);
  await sql.query(`INSERT INTO drive_change ("owner_id", "entry_id", "parent_id", "op")
                   VALUES ($1, $2, NULL, 'UPSERT'), ($1, $3, $2, 'UPSERT'), ($1, $4, $3, 'UPSERT')`, [owner, root, folder, file]);
  await sql.query(`INSERT INTO drive_removed_entry ("owner_id", "entry_id", "parent_id", "name")
                   VALUES ($1, $2, $3, 'draft.txt')`, [owner, randomUUID(), folder]);
  await sql.query(`INSERT INTO drive_mount_credential ("id", "owner_id", "runner_id", "generation", "token_hash")
                   VALUES ($1, $2, $3, 1, $4)`, [randomUUID(), owner, runner, `hash-${run}`]);

  const namesBefore = await names(sql, scratch, 'drive_');
  const rowsBefore = await contents(sql, scratch, 'drive_');
  for (const base of BASES) assert.notEqual(rowsBefore[base].split(' ')[0], '0', `drive_${base} has a row to keep`);
  const { rows: [{ last: lastSeq }] } = await sql.query<{ last: string }>('SELECT max("seq")::text AS last FROM drive_change');

  // 1551, sent whole, as `migrate deploy` sends it.
  await sql.query(MIGRATION_1551);

  assert.deepEqual(await prefixed(sql, scratch, 'drive_'), [], 'no relation or constraint named drive_* is left');
  const namesAfter1551 = await names(sql, scratch, 'document_');
  assert.deepEqual(namesAfter1551, namesBefore.map((n) => n.replace(/(^|[ .])drive_/g, '$1document_')).sort(),
    'every name is the old one with drive_ replaced by document_, and nothing is added or dropped');
  assert.deepEqual(await contents(sql, scratch, 'document_'), rowsBefore, 'every table keeps its row count and every row');
  const rowsAfter1551 = await contents(sql, scratch, 'document_');
  await sql.query(MIGRATION_1551);
  assert.deepEqual(await names(sql, scratch, 'document_'), namesAfter1551, '1551 run twice changes nothing');
  assert.deepEqual(await contents(sql, scratch, 'document_'), rowsAfter1551);

  // 1560's document_sync, with a running sync and an ended one.
  await sql.query(MIGRATION_1560);
  await sql.query(`INSERT INTO document_sync ("id", "owner_id", "runner_id", "source_name", "dest_path", "dest_entry_id",
                     "status", "files_seen", "files_done", "bytes_sent", "failed", "failed_count", "ended_at")
                   VALUES ($1, $3, $4, 'reports', '/reports', $5, 'UPLOADING', 3, 1, 5, '[]', 0, NULL),
                          ($2, $3, $4, 'notes', '/notes', NULL, 'DONE', 2, 1, 5, '[{"path":"a.md","error":"too large"}]', 1, now())`,
    [randomUUID(), randomUUID(), owner, runner, folder]);

  const documentNames = await names(sql, scratch, 'document_', ALL);
  const rowsBefore1592 = await contents(sql, scratch, 'document_', ALL);
  for (const base of ALL) assert.notEqual(rowsBefore1592[base].split(' ')[0], '0', `document_${base} has a row to keep`);

  // 1592, sent whole.
  await sql.query(MIGRATION_1592);

  assert.deepEqual(await prefixed(sql, scratch, 'document_'), [], 'no relation or constraint named document_* is left');
  const namesAfter = await names(sql, scratch, 'drive_', ALL);
  assert.deepEqual(namesAfter, documentNames.map((n) => n.replace(/(^|[ .])document_/g, '$1drive_')).sort(),
    'every name is the old one with document_ replaced by drive_, and nothing is added or dropped');
  assert.deepEqual(await names(sql, scratch, 'drive_'), namesBefore, 'the ten tables carry the names they had before 1551');
  assert.deepEqual(namesAfter, migrated, 'the names are the ones the fully migrated database has');
  assert.deepEqual(await contents(sql, scratch, 'drive_', ALL), rowsBefore1592,
    'every table keeps its row count and every row');
  assert.deepEqual(await contents(sql, scratch, 'drive_'), rowsBefore, 'the ten tables hold what they held before 1551');

  // The renamed sequence still numbers the feed, after what it had already handed out.
  const { rows: [{ seq }] } = await sql.query<{ seq: string }>(
    `INSERT INTO drive_change ("owner_id", "entry_id", "op") VALUES ($1, $2, 'REMOVE') RETURNING "seq"::text AS seq`,
    [owner, randomUUID()]);
  assert.ok(BigInt(seq) > BigInt(lastSeq), `the next change seq ${seq} follows ${lastSeq}`);
  // And the renamed foreign keys and checks still hold: a chunk of no version is refused, and so is a bad sync status.
  await assert.rejects(sql.query(
    `INSERT INTO drive_version_chunk ("version_id", "idx", "owner_id", "offset", "size_bytes", "sha256")
     VALUES ($1, 0, $2, 0, 5, $3)`, [randomUUID(), owner, sha]), /drive_version_chunk_version_fkey/);
  await assert.rejects(sql.query(
    `INSERT INTO drive_sync ("id", "owner_id", "runner_id", "source_name", "dest_path", "status", "ended_at")
     VALUES ($1, $2, $3, 'x', '/x', 'LOST', now())`, [randomUUID(), owner, runner]), /drive_sync_status_check/);

  // A second run finds nothing to rename.
  const rowsAfter = await contents(sql, scratch, 'drive_', ALL);
  await sql.query(MIGRATION_1592);
  assert.deepEqual(await names(sql, scratch, 'drive_', ALL), namesAfter);
  assert.deepEqual(await contents(sql, scratch, 'drive_', ALL), rowsAfter);
});
