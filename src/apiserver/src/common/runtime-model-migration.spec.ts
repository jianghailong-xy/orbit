import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const sql = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0079_runtime_default_models/migration.sql'),
  'utf8',
);

test('Runtime-default migration stabilizes null and blank legacy session models', () => {
  assert.match(sql, /LOCK TABLE "agent", "session" IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(
    sql,
    /ADD COLUMN "uses_runtime_default_model" BOOLEAN NOT NULL DEFAULT false/,
  );
  assert.match(sql, /SET "model" = btrim\(a\."model"\)/);
  assert.match(sql, /s\."model" IS NULL OR btrim\(s\."model"\) = ''/);
  assert.match(sql, /a\."model" IS NOT NULL[\s\S]*btrim\(a\."model"\) <> ''/);
  assert.match(sql, /WHEN s\."provider" = 'codex' THEN 'gpt-5\.6-sol'/);
  assert.match(sql, /WHEN s\."provider" = 'kimi'[\s\S]*THEN 'kimi-code\/kimi-for-coding'/);
  assert.match(sql, /ELSE 'claude-opus-5'/);
  assert.match(sql, /s\."provider" IN \('claude', 'codex'\)/);
  assert.match(sql, /s\."provider" = 'kimi' AND s\."provider_builtin" = true/);
});
