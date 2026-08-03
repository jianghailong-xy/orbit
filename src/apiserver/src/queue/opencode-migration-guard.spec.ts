import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  path.join(process.cwd(), 'prisma', 'migrations', '0080_opencode_runtime', 'migration.sql'),
  'utf8',
);

test('OpenCode migration permanently reserves a protected compatibility provider row', () => {
  assert.match(migration, /__orbit_builtin_opencode_guard__/);
  assert.match(migration, /orbit-opencode-compatibility-guard/);
  assert.match(migration, /model_provider_builtin_opencode_guard_shape/);
  assert.match(migration, /BEFORE DELETE ON "model_provider"/);
  assert.match(migration, /NEW\."slug" IS DISTINCT FROM 'opencode'/);
});

test('the provider fence blocks removal/rename without breaking table-wide maintenance', () => {
  // These artifacts outlive the rolling deploy, so a blanket UPDATE/DELETE guard would turn any
  // later bulk write on model_provider into a hard error. Only retiring the fence is blocked.
  assert.doesNotMatch(migration, /BEFORE UPDATE OR DELETE ON "model_provider"/);
  const shape = migration.match(/ADD CONSTRAINT "model_provider_builtin_opencode_guard_shape"[\s\S]*?\);/)?.[0] ?? '';
  assert.match(shape, /"owner_id" IS NULL/);
  assert.match(shape, /"enabled" = true/);
  assert.match(shape, /"api_key_enc" = 'orbit-opencode-compatibility-guard'/);
  // Cosmetic columns stay writable.
  assert.doesNotMatch(shape, /"label"/);
});

test('OpenCode migration blocks legacy control-plane claims without a transaction capability', () => {
  assert.match(migration, /current_setting\('orbit\.runner_supports_opencode', true\)/);
  assert.match(migration, /RETURN NULL/);
  assert.match(migration, /BEFORE UPDATE OF "status" ON "session"/);
});

test('the silent claim skip is documented and stays narrowed to PENDING -> RUNNING', () => {
  // A BEFORE trigger returning NULL drops the row update without raising, so any future
  // PENDING -> RUNNING writer that forgets the GUC would fail silently. Keep the predicate
  // exactly this narrow, and keep the invariant written down next to it.
  assert.match(migration, /INVARIANT: after this migration, PENDING -> RUNNING/);
  const guard = migration.match(/CREATE OR REPLACE FUNCTION guard_opencode_runner_claim[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? '';
  assert.match(guard, /OLD\."status" = 'PENDING'/);
  assert.match(guard, /NEW\."status" = 'RUNNING'/);
  assert.match(guard, /NEW\."provider" = 'opencode'/);
});

test('OpenCode compatibility provider makes legacy reclaim fail before Claude dispatch', () => {
  const guardInsert = migration.match(/INSERT INTO "model_provider"[\s\S]*?\n\);/)?.[0] ?? '';
  assert.match(guardInsert, /'opencode'/);
  assert.match(guardInsert, /'claude'/);
  assert.match(guardInsert, /'orbit-opencode-compatibility-guard'/);
  assert.doesNotMatch(guardInsert, /'iv:tag:ciphertext'/);
});
