import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const sql = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0077_kimi_runtime/migration.sql'),
  'utf8',
);

test('Kimi migration serializes its collision lookup and old-version reference writes', () => {
  assert.match(
    sql,
    /BEGIN;[\s\S]*LOCK TABLE "model_provider", "agent", "session" IN SHARE ROW EXCLUSIVE MODE/,
  );
  assert.match(sql, /SET "preset_slug" = 'moonshot'[\s\S]*WHERE "preset_slug" = 'kimi'/);
  assert.match(sql, /target_slug := 'moonshot-' \|\| suffix/);
  assert.match(
    sql,
    /ALTER TABLE "conversation_turn" ADD COLUMN "lease_generation" UUID/,
  );
  assert.match(
    sql,
    /ALTER TABLE "session" ADD COLUMN "inbox_lease_generation" UUID/,
  );
  assert.match(sql, /ALTER TABLE "session" ADD COLUMN "inbox_lease_owner" UUID/);
  assert.match(sql, /CREATE TABLE "inbox_lease_generation"/);
  assert.match(sql, /"lease_owner" UUID/);
  assert.match(sql, /ALTER TABLE "agent" ADD COLUMN "provider_builtin" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /ALTER TABLE "session" ADD COLUMN "provider_builtin" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(sql, /COMMIT;\s*$/);
});

test('Kimi migration moves both provider references before renaming the configured row', () => {
  const agent = sql.indexOf('UPDATE "agent" SET "provider" = target_slug');
  const session = sql.indexOf('UPDATE "session" SET "provider" = target_slug');
  const provider = sql.indexOf('UPDATE "model_provider" SET "slug"');
  assert.ok(agent >= 0);
  assert.ok(session > agent);
  assert.ok(provider > session);
});

test('Kimi migration preserves orphan references and fences stale replicas after commit', () => {
  assert.match(
    sql,
    /ELSE[\s\S]*UPDATE "agent" SET "provider" = '__orbit_reserved_legacy_kimi_0077__'[\s\S]*UPDATE "session" SET "provider" = '__orbit_reserved_legacy_kimi_0077__'/,
  );
  assert.match(
    sql,
    /CHECK \("slug" NOT IN \('kimi', '__orbit_reserved_legacy_kimi_0077__'\)\)/,
  );
});

test('Kimi migration collision-safely vacates its reserved orphan tombstone', () => {
  assert.match(
    sql,
    /reserved_slug TEXT := '__orbit_reserved_legacy_kimi_0077__'[\s\S]*UPDATE "agent" SET "provider" = target_slug WHERE "provider" = reserved_slug[\s\S]*UPDATE "model_provider" SET "slug" = target_slug WHERE "slug" = reserved_slug/,
  );
});
