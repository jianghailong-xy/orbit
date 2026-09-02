import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const migration = readFileSync(join(
  process.cwd(),
  'prisma',
  'migrations',
  '0187_fineweb_executable_backfill',
  'migration.sql',
), 'utf8');

test('N19 is an explicit bounded declaration-only migration with four strict classes', () => {
  assert.match(migration, /Schema deployment installs only the classifier, audit ledger/);
  assert.match(migration, /CHECK \("batch_size" BETWEEN 1 AND 1000\)/);
  assert.match(migration, /LIMIT batch_row\."batch_size"[\s\S]*FOR UPDATE OF task SKIP LOCKED/);
  assert.match(migration, /ON CONFLICT ON CONSTRAINT "task_executable_backfill_item_pkey" DO NOTHING/);

  for (const taskClass of ['FINEWEB', 'WARC', 'MERGE', 'VERIFY']) {
    assert.match(migration, new RegExp(`RETURN QUERY SELECT '${taskClass}'::text`));
  }
  // 0187 is frozen history and predates 0224's rename of this enum label.
  assert.match(migration, /无可判定的标题前缀且没有验收标准；保持 HUMAN_SIGNOFF。/);
  assert.match(migration, /标题不符合对应前缀的严格 dump\/shard 模板；未猜测命令。/);
  assert.match(migration, /task\."status" = 'OPEN'/);
  assert.match(migration, /task\."completion_criterion" = 'HUMAN_SIGNOFF'/);
  assert.match(migration, /task\."completion_policy" = 'MANUAL'/);
  assert.match(migration, /task\."verifies_task_id" IS NULL/);

  const taskUpdates = [...migration.matchAll(
    /UPDATE "task" task[\s\S]*?RETURNING task\."id"/g,
  )].map((match) => match[0]);
  assert.equal(taskUpdates.length, 2, 'only the bounded forward and rollback doors update task');
  for (const statement of taskUpdates) {
    const setClause = statement.match(/SET([\s\S]*?)\n\s+FROM/)?.[1] ?? '';
    assert.doesNotMatch(setClause, /"status"\s*=/,
      'neither direction may write task.status');
  }
  assert.match(taskUpdates[0], /SET "completion_criterion" = 'EXECUTABLE'/);
  assert.match(taskUpdates[0], /"acceptance_expected_exit_code" = 0/);
  assert.match(taskUpdates[1], /item\."previous_completion_criterion"/);
  assert.match(migration, /installed_acceptance_command_sha256/);
  assert.match(migration, /N19_ROLLBACK_DRIFT/);
  assert.match(migration, /N19_SCOPE_DRIFT/);

  assert.doesNotMatch(migration, /n19_fineweb_executable_backfill_step\([^)]*\)\s*;/,
    'schema deployment must not invoke its operator door');
});
