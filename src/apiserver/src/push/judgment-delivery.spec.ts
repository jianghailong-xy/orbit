import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('judgment delivery is a transactional inbox/outbox, not a polling state machine', () => {
  const migration = readFileSync(join(
    process.cwd(), 'prisma', 'migrations', '0182_task_judgment_delivery', 'migration.sql',
  ), 'utf8');
  const worker = readFileSync(join(process.cwd(), 'src', 'push', 'judgment-delivery.service.ts'), 'utf8');

  assert.match(migration, /AFTER INSERT ON "task_judgment_request"/);
  assert.match(migration, /INSERT INTO "task_judgment_inbox_item"/);
  assert.match(migration, /INSERT INTO "task_judgment_push_delivery"/);
  assert.match(migration, /UNIQUE \("request_id", "request_version"\)/);
  assert.match(migration, /AFTER UPDATE OF "status" ON "task_judgment_request"/);
  assert.doesNotMatch(worker, /setInterval\s*\(/);
  assert.match(worker, /next_attempt_at/);
  assert.match(worker, /FOR UPDATE OF delivery SKIP LOCKED/);
  assert.match(worker, /request\."status" = 'OPEN'/);
});
