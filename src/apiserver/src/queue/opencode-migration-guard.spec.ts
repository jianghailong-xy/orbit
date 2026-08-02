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
  assert.match(migration, /BEFORE UPDATE OR DELETE ON "model_provider"/);
});

test('OpenCode migration blocks legacy control-plane claims without a transaction capability', () => {
  assert.match(migration, /current_setting\('orbit\.runner_supports_opencode', true\)/);
  assert.match(migration, /RETURN NULL/);
  assert.match(migration, /BEFORE UPDATE OF "status" ON "session"/);
});

test('OpenCode compatibility provider makes legacy reclaim fail before Claude dispatch', () => {
  const guardInsert = migration.match(/INSERT INTO "model_provider"[\s\S]*?\n\);/)?.[0] ?? '';
  assert.match(guardInsert, /'opencode'/);
  assert.match(guardInsert, /'claude'/);
  assert.match(guardInsert, /'orbit-opencode-compatibility-guard'/);
  assert.doesNotMatch(guardInsert, /'iv:tag:ciphertext'/);
});
