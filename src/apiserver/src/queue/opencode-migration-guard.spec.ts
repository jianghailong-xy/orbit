import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  path.join(process.cwd(), 'prisma', 'migrations', '0080_opencode_runtime', 'migration.sql'),
  'utf8',
);

/** A guard as it stands: its body in the last migration that (re)defines it. */
function guardInForce(name: string): string {
  const root = path.join(process.cwd(), 'prisma', 'migrations');
  const bodies = readdirSync(root).sort().flatMap((dir) => {
    let sql: string;
    try {
      sql = readFileSync(path.join(root, dir, 'migration.sql'), 'utf8');
    } catch {
      return [];
    }
    const body = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\(\\)[\\s\\S]*?\\$\\$ LANGUAGE plpgsql;`))?.[0];
    return body ? [body] : [];
  });
  return bodies.at(-1) ?? '';
}

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

test('the silent claim skip stays narrowed to PENDING -> RUNNING, on the recorded engine first', () => {
  // A BEFORE trigger returning NULL drops the row update without raising, so any future
  // PENDING -> RUNNING writer that forgets the GUC would fail silently. Keep the predicate
  // exactly this narrow, and keep the invariant written down next to it.
  assert.match(migration, /INVARIANT: after this migration, PENDING -> RUNNING/);
  const guard = migration.match(/CREATE OR REPLACE FUNCTION guard_opencode_runner_claim[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ?? '';
  assert.match(guard, /OLD\."status" = 'PENDING'/);
  assert.match(guard, /NEW\."status" = 'RUNNING'/);
  assert.match(guard, /NEW\."provider" = 'opencode'/);
  // The guard in force (migration 0414, docs/provider-engine-contract.md §5.5): a session recorded on
  // the runtime is gated whatever credential it spends, and one without an engine — an older
  // replica's — by the slug rule above. Still only PENDING -> RUNNING, still the same capability.
  const current = guardInForce('guard_opencode_runner_claim');
  assert.match(current, /OLD\."status" = 'PENDING'/);
  assert.match(current, /NEW\."status" = 'RUNNING'/);
  assert.match(current, /NEW\."engine" = 'opencode' OR \(NEW\."engine" IS NULL AND NEW\."provider" = 'opencode'\)/);
  assert.match(current, /current_setting\('orbit\.runner_supports_opencode', true\)/);
});

test('OpenCode compatibility provider makes legacy reclaim fail before Claude dispatch', () => {
  const guardInsert = migration.match(/INSERT INTO "model_provider"[\s\S]*?\n\);/)?.[0] ?? '';
  assert.match(guardInsert, /'opencode'/);
  assert.match(guardInsert, /'claude'/);
  assert.match(guardInsert, /'orbit-opencode-compatibility-guard'/);
  assert.doesNotMatch(guardInsert, /'iv:tag:ciphertext'/);
});
