import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const sql = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0372_gemini_antigravity_runtime/migration.sql'),
  'utf8',
);
/** The statements alone: the comments name tables and columns in prose. */
const statements = sql
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n');

test('Gemini migration moves every row of that preset onto the Antigravity runtime', () => {
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;\s*$/);
  // Runtime and endpoint move in the same statement: agy appends /v1beta/models/… itself, so a row
  // left on the OpenAI-compatible base would 404 every turn.
  assert.match(
    statements,
    /UPDATE "model_provider"\s*SET "runtime" = 'antigravity',\s*"base_url" = regexp_replace\("base_url", '\/v1beta\/openai\/\?\$', ''\)\s*WHERE "preset_slug" = 'gemini';/,
  );
});

test('Gemini migration drops the thread ids Codex minted on those rows', () => {
  assert.match(
    statements,
    /UPDATE "session"\s*SET "runtime_session_id" = NULL\s*WHERE "runtime_session_id" IS NOT NULL\s*AND "provider" IN \(SELECT "slug" FROM "model_provider" WHERE "preset_slug" = 'gemini'\);/,
  );
});

test("0367's claim guard is widened to a borrowed Antigravity slug, and stays exactly as narrow otherwise", () => {
  // The function 0367 installed, replaced in place: no second trigger, no new transition.
  assert.doesNotMatch(statements, /CREATE TRIGGER/);
  const guard =
    statements.match(/CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/)?.[0] ??
    '';
  assert.ok(guard, 'the claim guard is not replaced');
  assert.match(guard, /OLD\."status" = 'PENDING'/);
  assert.match(guard, /NEW\."status" = 'RUNNING'/);
  assert.match(guard, /current_setting\('orbit\.runner_supports_antigravity', true\)/);
  assert.match(guard, /NEW\."provider" = 'antigravity'/);
  // The rows dispatch resolves for the session (custom-provider.ts providerSlugsOn).
  assert.match(
    guard,
    /EXISTS \(\s*SELECT 1 FROM "model_provider" mp\s+WHERE mp\."slug" = NEW\."provider"\s+AND mp\."runtime" = 'antigravity'\s+AND mp\."enabled"\s+AND \(mp\."owner_id" IS NULL OR mp\."owner_id" = NEW\."owner_id"\)/,
  );
  assert.match(guard, /RETURN NULL;/);
  // A read, never a lock: the trigger must not add a wait edge (common/db-write-inventory.ts).
  assert.doesNotMatch(guard, /FOR (?:NO KEY )?UPDATE|FOR (?:KEY )?SHARE/);
});
