import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  path.join(process.cwd(), 'prisma', 'migrations', '0367_antigravity_runtime', 'migration.sql'),
  'utf8',
);
/** The statements alone: the header names tables and columns in prose. */
const statements = migration
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n');

test('Antigravity migration permanently reserves a protected compatibility provider row', () => {
  assert.match(migration, /__orbit_builtin_antigravity_guard__/);
  assert.match(migration, /orbit-antigravity-compatibility-guard/);
  assert.match(migration, /model_provider_builtin_antigravity_guard_shape/);
  assert.match(migration, /BEFORE DELETE ON "model_provider"/);
  assert.match(migration, /NEW\."slug" IS DISTINCT FROM 'antigravity'/);
});

test('the provider fence blocks removal/rename without breaking table-wide maintenance', () => {
  // These artifacts outlive the rolling deploy, so a blanket UPDATE/DELETE guard would turn any
  // later bulk write on model_provider into a hard error. Only retiring the fence is blocked.
  assert.doesNotMatch(migration, /BEFORE UPDATE OR DELETE ON "model_provider"/);
  const shape = migration.match(/ADD CONSTRAINT "model_provider_builtin_antigravity_guard_shape"[\s\S]*?\);/)?.[0] ?? '';
  assert.match(shape, /"id" = '00000000-0000-7000-8000-000000000367'/);
  assert.match(shape, /"owner_id" IS NULL/);
  assert.match(shape, /"enabled" = true/);
  assert.match(shape, /"api_key_enc" = 'orbit-antigravity-compatibility-guard'/);
  // Cosmetic columns stay writable.
  assert.doesNotMatch(shape, /"label"/);
});

test('Antigravity migration blocks legacy control-plane claims without a transaction capability', () => {
  assert.match(migration, /current_setting\('orbit\.runner_supports_antigravity', true\)/);
  assert.match(migration, /RETURN NULL/);
  assert.match(migration, /BEFORE UPDATE OF "status" ON "session"/);
});

test('the silent claim skip is documented and stays narrowed to PENDING -> RUNNING', () => {
  // A BEFORE trigger returning NULL drops the row update without raising, so any future
  // PENDING -> RUNNING writer that forgets the GUC would fail silently. Keep the predicate
  // exactly this narrow, and keep the invariant written down next to it.
  assert.match(migration, /INVARIANT: after this migration, PENDING -> RUNNING/);
  const guard = migration.match(/CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? '';
  assert.match(guard, /OLD\."status" = 'PENDING'/);
  assert.match(guard, /NEW\."status" = 'RUNNING'/);
  assert.match(guard, /NEW\."provider" = 'antigravity'/);
});

test('Antigravity compatibility provider makes legacy reclaim fail before Claude dispatch', () => {
  const guardInsert = migration.match(/INSERT INTO "model_provider"[\s\S]*?\n\);/)?.[0] ?? '';
  assert.match(guardInsert, /'antigravity'/);
  assert.match(guardInsert, /'claude'/);
  assert.match(guardInsert, /'orbit-antigravity-compatibility-guard'/);
  assert.doesNotMatch(guardInsert, /'iv:tag:ciphertext'/);
});

test('whatever already held the slug moves aside first, in both halves of the namespace', () => {
  // 0265: a pool's slug and a provider's are one namespace, so either could hold `antigravity`,
  // and the guard row's INSERT would be refused by the dispatch-slug guard if a pool still did.
  const move = statements.indexOf('UPDATE "provider_pool" SET "slug" = candidate');
  const insert = statements.indexOf('INSERT INTO "model_provider"');
  assert.ok(move >= 0, 'a pool holding the slug is not moved');
  assert.ok(move < insert, 'the pool must be moved before the guard row claims the slug');
  assert.match(statements, /UPDATE "model_provider" SET "slug" = candidate WHERE "slug" = 'antigravity'/);
  // The suffix is free in BOTH tables, or renaming one would collide with the other.
  assert.match(
    statements,
    /WHILE EXISTS \(SELECT 1 FROM "model_provider" WHERE "slug" = candidate\)\s+OR EXISTS \(SELECT 1 FROM "provider_pool" WHERE "slug" = candidate\)/,
  );
  // And the lock covers the namespace and the dispatch identities for the whole rewrite.
  assert.match(
    statements,
    /LOCK TABLE "model_provider", "provider_pool", "session", "task" IN SHARE ROW EXCLUSIVE MODE/,
  );
});

test('every stored dispatch reference moves with it', () => {
  // The columns that can hold a configured slug and are still read (the header says why each).
  for (const write of [
    /UPDATE "session" SET "provider" = candidate WHERE "provider" = 'antigravity'/,
    /UPDATE "task" SET "provider" = candidate WHERE "provider" = 'antigravity'/,
    /UPDATE "task_route_decision" SET "provider" = candidate/,
    /UPDATE "task_route_decision"\s+SET "baseline" = jsonb_set\("baseline", '\{provider\}'/,
    /UPDATE "task_run_request"[\s\S]*?WHERE "status" = 'BOUND'/,
    /UPDATE "workspace" w\s+SET "provider_fallbacks"/,
    /UPDATE "agent" a\s+SET "provider_fallbacks"/,
    /UPDATE "agent" SET "default_provider" = candidate/,
    /array_replace\("model_routing_providers", 'antigravity', candidate\)/,
    /UPDATE "user"\s+SET "preferences" = jsonb_set\(\s+"preferences",\s+'\{defaultModels\}'/,
    /UPDATE "wiki_space"\s+SET "settings" = jsonb_set\("settings", '\{maintenance,provider\}'/,
  ]) {
    assert.match(statements, write);
  }
  // Orphans included: the rewrite is not conditional on a row still holding the slug, because
  // before this migration the name could only ever have meant a configured identity.
  assert.doesNotMatch(statements, /IF EXISTS \(SELECT 1 FROM "model_provider" WHERE "slug" = 'antigravity'\)/);
});
