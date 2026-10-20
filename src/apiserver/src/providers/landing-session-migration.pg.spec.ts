import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The 0436 migration replayed over representative data
 * (docs/project-integration-line-contract.md §2.9 LS1–LS3, revision 12).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/providers/landing-session-migration.pg.spec.ts
 *
 * WHAT IT PROVES. The migration file shipped to deploys is applied to a schema that already holds
 * what a deployment holds the moment before it: a configured provider labelled "Orbit" (slug
 * `orbit`), every stored reference that names it, sessions, tasks, a project and a binding. It then
 * asserts the move aside, the guard row, the session discriminator, the subject table and the two
 * partial unique indexes — the facts the running code depends on. Kept in its own schema; still
 * guarded by the destructive-PG identity fence because it drops that schema on each run.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';
const SCHEMA = 'landing_session_migration';
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0436_landing_sessions/migration.sql'),
  'utf8',
);

const OWNER = '00000000-0000-7000-8000-000000004361';
const PROJECT = '00000000-0000-7000-8000-000000004362';
const CODEBASE = '00000000-0000-7000-8000-000000004363';
const TASK = '00000000-0000-7000-8000-000000004364';
const SESSION = '00000000-0000-7000-8000-000000004365';
const PROVIDER = '00000000-0000-7000-8000-000000004366';
const LANDING = '00000000-0000-7000-8000-000000004367';
const LANDING_SESSION = '00000000-0000-7000-8000-000000004368';

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/** Only the relations 0436 reads or changes, in the shape a deployment has before it. */
async function seedPre0436(client: Client): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  await client.query(String.raw`
    CREATE TABLE "user" (
      "id" UUID PRIMARY KEY,
      "preferences" JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE "model_provider" (
      "id" UUID PRIMARY KEY,
      "slug" TEXT NOT NULL UNIQUE,
      "label" TEXT NOT NULL,
      "runtime" TEXT NOT NULL DEFAULT 'claude',
      "base_url" TEXT NOT NULL,
      "api_key_enc" TEXT NOT NULL,
      "models" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "default_model" TEXT,
      "preset_slug" TEXT,
      "follows_preset" BOOLEAN NOT NULL DEFAULT false,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "position" INTEGER,
      "owner_id" UUID,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "provider_pool" (
      "id" UUID PRIMARY KEY,
      "slug" TEXT NOT NULL UNIQUE,
      "label" TEXT NOT NULL,
      "owner_id" UUID NOT NULL
    );
    CREATE TABLE "provider_slug_alias" (
      "slug" TEXT PRIMARY KEY,
      "provider_id" UUID NOT NULL,
      "engine" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "session" (
      "id" UUID PRIMARY KEY,
      "provider" TEXT NOT NULL DEFAULT 'claude',
      "owner_id" UUID NOT NULL,
      "model" TEXT
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "provider" TEXT,
      "model" TEXT
    );
    CREATE TABLE "task_route_decision" (
      "id" UUID PRIMARY KEY,
      "provider" TEXT,
      "baseline" JSONB
    );
    CREATE TABLE "task_run_request" (
      "id" UUID PRIMARY KEY,
      "status" TEXT NOT NULL,
      "target" JSONB
    );
    CREATE TABLE "workspace" (
      "id" UUID PRIMARY KEY,
      "provider_fallbacks" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "model_routing_providers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    );
    CREATE TABLE "agent" (
      "id" UUID PRIMARY KEY,
      "default_provider" TEXT,
      "provider_fallbacks" JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE "wiki_space" (
      "id" UUID PRIMARY KEY,
      "settings" JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      CONSTRAINT "project_id_owner_id_key" UNIQUE ("id", "owner_id")
    );
    CREATE TABLE "project_codebase" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL
    );
    CREATE TABLE "project_integration_job" (
      "id" UUID PRIMARY KEY,
      "session_id" UUID,
      "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // The holder and every stored reference the migration promises to carry.
  await client.query(`INSERT INTO "user" ("id", "preferences") VALUES (
    $1, '{"defaultModels":{"orbit":"deepseek-chat","opencode":"orbit-orbit/other"}}'::jsonb
  )`, [OWNER]);
  await client.query(`INSERT INTO "model_provider"
    ("id","slug","label","runtime","base_url","api_key_enc","owner_id")
    VALUES ($1,'orbit','Orbit personal key','claude','https://api.invalid','iv:tag:ct',$2)`,
  [PROVIDER, OWNER]);
  await client.query(`INSERT INTO "session" ("id","provider","owner_id") VALUES ($1,'orbit',$2)`, [SESSION, OWNER]);
  await client.query(`INSERT INTO "session" ("id","provider","owner_id","model")
    VALUES (gen_random_uuid(),'opencode',$1,'orbit-orbit/deepseek-chat')`, [OWNER]);
  await client.query(`INSERT INTO "task" ("id","provider") VALUES (gen_random_uuid(),'orbit')`);
  await client.query(`INSERT INTO "task_route_decision" ("id","provider","baseline")
    VALUES (gen_random_uuid(),'orbit','{"provider":"orbit","model":"x"}'::jsonb)`);
  await client.query(`INSERT INTO "task_run_request" ("id","status","target")
    VALUES (gen_random_uuid(),'BOUND','{"provider":"orbit","model":"orbit-orbit/x"}'::jsonb)`);
  await client.query(`INSERT INTO "workspace" ("id","provider_fallbacks","model_routing_providers")
    VALUES (gen_random_uuid(),'[{"provider":"orbit","model":"x"}]'::jsonb, ARRAY['orbit'])`);
  await client.query(`INSERT INTO "agent" ("id","default_provider","provider_fallbacks")
    VALUES (gen_random_uuid(),'orbit','[{"provider":"orbit"}]'::jsonb)`);
  await client.query(`INSERT INTO "wiki_space" ("id","settings")
    VALUES (gen_random_uuid(),'{"maintenance":{"provider":"orbit"}}'::jsonb)`);
  await client.query(`INSERT INTO "project" ("id","owner_id") VALUES ($1,$2)`, [PROJECT, OWNER]);
  await client.query(`INSERT INTO "project_codebase" ("id","project_id") VALUES ($1,$2)`, [CODEBASE, PROJECT]);
}

test('0436 moves an existing orbit holder aside, rewrites every reference and installs the guards',
  { skip, timeout: 60_000 }, async () => {
    const client = await connect();
    try {
      await seedPre0436(client);
      await client.query(MIGRATION);

      // 1. The holder moved, every stored reference followed.
      const holder = await client.query<{ slug: string }>(
        `SELECT "slug" FROM "model_provider" WHERE "id" = $1`, [PROVIDER]);
      assert.equal(holder.rows[0]?.slug, 'orbit-2');
      const session = await client.query<{ provider: string }>(
        `SELECT "provider" FROM "session" WHERE "id" = $1`, [SESSION]);
      assert.equal(session.rows[0]?.provider, 'orbit-2');
      const models = await client.query<{ model: string }>(
        `SELECT "model" FROM "session" WHERE "provider" = 'opencode'`);
      assert.equal(models.rows[0]?.model, 'orbit-orbit-2/deepseek-chat');
      const task = await client.query<{ provider: string }>(`SELECT "provider" FROM "task"`);
      assert.equal(task.rows[0]?.provider, 'orbit-2');
      const route = await client.query<{ provider: string; baseline: { provider: string } }>(
        `SELECT "provider", "baseline" FROM "task_route_decision"`);
      assert.equal(route.rows[0]?.provider, 'orbit-2');
      assert.equal(route.rows[0]?.baseline.provider, 'orbit-2');
      const bound = await client.query<{ target: { provider: string; model: string } }>(
        `SELECT "target" FROM "task_run_request"`);
      assert.deepEqual(bound.rows[0]?.target, { provider: 'orbit-2', model: 'orbit-orbit-2/x' });
      const workspace = await client.query<{ provider_fallbacks: Array<{ provider: string }>; model_routing_providers: string[] }>(
        `SELECT "provider_fallbacks", "model_routing_providers" FROM "workspace"`);
      assert.equal(workspace.rows[0]?.provider_fallbacks[0]?.provider, 'orbit-2');
      assert.deepEqual(workspace.rows[0]?.model_routing_providers, ['orbit-2']);
      const agent = await client.query<{ default_provider: string; provider_fallbacks: Array<{ provider: string }> }>(
        `SELECT "default_provider", "provider_fallbacks" FROM "agent"`);
      assert.equal(agent.rows[0]?.default_provider, 'orbit-2');
      assert.equal(agent.rows[0]?.provider_fallbacks[0]?.provider, 'orbit-2');
      const prefs = await client.query<{ preferences: { defaultModels: Record<string, string> } }>(
        `SELECT "preferences" FROM "user"`);
      assert.deepEqual(prefs.rows[0]?.preferences.defaultModels, {
        'orbit-2': 'deepseek-chat',
        'opencode': 'orbit-orbit-2/other',
      });
      const wiki = await client.query<{ settings: { maintenance: { provider: string } } }>(
        `SELECT "settings" FROM "wiki_space"`);
      assert.equal(wiki.rows[0]?.settings.maintenance.provider, 'orbit-2');

      // 2. The reserved name is held by the guard, and cannot be taken again.
      const guard = await client.query<{ id: string; api_key_enc: string; enabled: boolean }>(
        `SELECT "id", "api_key_enc", "enabled" FROM "model_provider" WHERE "slug" = 'orbit'`);
      assert.equal(guard.rows[0]?.id, '00000000-0000-7000-8000-000000000436');
      assert.equal(guard.rows[0]?.api_key_enc, 'orbit-provider-compatibility-guard');
      assert.equal(guard.rows[0]?.enabled, true);
      await assert.rejects(
        client.query(`INSERT INTO "model_provider"
          ("id","slug","label","runtime","base_url","api_key_enc")
          VALUES (gen_random_uuid(),'orbit','another','claude','https://x.invalid','k')`),
        /model_provider_builtin_orbit_guard_shape|duplicate key/,
      );
      await assert.rejects(
        client.query(`DELETE FROM "model_provider" WHERE "slug" = 'orbit'`),
        /reserved for the platform/,
      );
      await assert.rejects(
        client.query(`UPDATE "model_provider" SET "slug" = 'orbit-elsewhere' WHERE "slug" = 'orbit'`),
        /reserved for the platform/,
      );

      // 3. The session discriminator: default CONVERSATION, closed set.
      const kind = await client.query<{ kind: string }>(
        `SELECT "kind" FROM "session" WHERE "id" = $1`, [SESSION]);
      assert.equal(kind.rows[0]?.kind, 'CONVERSATION');
      await assert.rejects(
        client.query(`INSERT INTO "session" ("id","owner_id","kind") VALUES (gen_random_uuid(),$1,'TAKEOVER')`, [OWNER]),
        /session_kind_check/,
      );

      // 4. project_landing: one open TASK per task, one open round per line, history references with
      //    no foreign keys.
      await client.query(`INSERT INTO "project_landing"
        ("id","project_id","owner_id","codebase_id","subject","task_id","episode","session_id")
        VALUES ($1,$2,$3,$4,'TASK',$5,1,$6)`,
      [LANDING, PROJECT, OWNER, CODEBASE, TASK, LANDING_SESSION]);
      await assert.rejects(
        client.query(`INSERT INTO "project_landing"
          ("id","project_id","owner_id","codebase_id","subject","task_id","episode","session_id")
          VALUES (gen_random_uuid(),$1,$2,$3,'TASK',$4,2,gen_random_uuid())`,
        [PROJECT, OWNER, CODEBASE, TASK]),
        /project_landing_open_task_key/,
      );
      await client.query(`UPDATE "project_landing"
        SET "settled_at" = CURRENT_TIMESTAMP, "settled_as" = 'LANDED' WHERE "id" = $1`, [LANDING]);
      await client.query(`INSERT INTO "project_landing"
        ("id","project_id","owner_id","codebase_id","subject","task_id","episode","session_id")
        VALUES (gen_random_uuid(),$1,$2,$3,'TASK',$4,2,gen_random_uuid())`,
      [PROJECT, OWNER, CODEBASE, TASK]);
      // The round: one open PROMOTION per project and codebase.
      await client.query(`INSERT INTO "project_landing"
        ("id","project_id","owner_id","codebase_id","subject","promotion_id","episode","session_id")
        VALUES (gen_random_uuid(),$1,$2,$3,'PROMOTION',gen_random_uuid(),1,gen_random_uuid())`,
      [PROJECT, OWNER, CODEBASE]);
      await assert.rejects(
        client.query(`INSERT INTO "project_landing"
          ("id","project_id","owner_id","codebase_id","subject","promotion_id","episode","session_id")
          VALUES (gen_random_uuid(),$1,$2,$3,'PROMOTION',gen_random_uuid(),2,gen_random_uuid())`,
        [PROJECT, OWNER, CODEBASE]),
        /project_landing_open_round_key/,
      );
      // The subject shape: a TASK names a task, a PROMOTION names a promotion.
      await assert.rejects(
        client.query(`INSERT INTO "project_landing"
          ("id","project_id","owner_id","codebase_id","subject","episode","session_id")
          VALUES (gen_random_uuid(),$1,$2,$3,'TASK',1,gen_random_uuid())`,
        [PROJECT, OWNER, CODEBASE]),
        /project_landing_subject_shape_check/,
      );
      // `task_id` and `session_id` carry no foreign key: a history reference may name nothing.
      await client.query(`INSERT INTO "project_landing"
        ("id","project_id","owner_id","codebase_id","subject","task_id","episode","session_id")
        VALUES (gen_random_uuid(),$1,$2,$3,'TASK',gen_random_uuid(),3,gen_random_uuid())`,
      [PROJECT, OWNER, CODEBASE]);

      // 5. The attempt's link and the two indexes the reads use.
      const landingColumn = await client.query<{ column_name: string }>(
        `SELECT "column_name" FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'project_integration_job' AND column_name = 'landing_id'`,
        [SCHEMA]);
      assert.equal(landingColumn.rowCount, 1);
      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1
          AND indexname IN ('project_integration_job_session_created_idx',
                            'project_integration_job_landing_idx')`, [SCHEMA]);
      assert.equal(indexes.rowCount, 2);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await client.end();
    }
  });
