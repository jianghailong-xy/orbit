import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const sql = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0083_moonshot_kimi_runtime/migration.sql'),
  'utf8',
);

test('Moonshot migration moves every row of that vendor onto the Kimi runtime', () => {
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;\s*$/);
  // Runtime and endpoint have to move in the same statement: the Kimi CLI is given Moonshot's
  // platform API, and a row left on the Anthropic-compatible shim would fail every turn.
  assert.match(
    sql,
    /UPDATE "model_provider"\s*SET "runtime" = 'kimi',\s*"base_url" = regexp_replace\("base_url", '\/anthropic\/\?\$', '\/v1'\)\s*WHERE "preset_slug" = 'moonshot';/,
  );
});

test('Moonshot migration drops session ids Kimi never issued', () => {
  // These were pre-generated for the Claude runtime. Kimi resumes by id, so one it did not
  // create makes the next spawn resume a conversation that does not exist.
  assert.match(sql, /UPDATE "session"\s*SET "runtime_session_id" = NULL/);
  // The identity can sit on the session or be inherited from its agent; both point at the row.
  assert.match(sql, /COALESCE\(\s*"provider",\s*\(SELECT "provider" FROM "agent"/);
  assert.match(sql, /IN \(SELECT "slug" FROM "model_provider" WHERE "preset_slug" = 'moonshot'\)/);
});
