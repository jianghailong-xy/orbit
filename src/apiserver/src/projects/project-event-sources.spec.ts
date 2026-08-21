import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const migration = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0117_project_event_sources/migration.sql'),
  'utf8',
);
const tasksService = readFileSync(
  path.resolve(__dirname, '../../src/tasks/tasks.service.ts'),
  'utf8',
);

test('the Project event producer migration owns the complete unit-06 source contract', () => {
  for (const trigger of [
    'project_task_event_source',
    'project_task_dependency_event_source',
    'project_session_event_source',
    'project_approval_event_source',
    'project_user_edit_event_source',
  ]) {
    assert.match(migration, new RegExp(`CREATE TRIGGER "${trigger}"`));
  }

  for (const kind of [
    'task.created',
    'task.updated',
    'task.status_changed',
    'task.reparented',
    'task.dependency_changed',
    'task.deleted',
    'session.started',
    'session.ended',
    'session.failed',
    'session.awaiting_input',
    'session.approval_pending',
    'merge.succeeded',
    'merge.conflict',
    'user.policy_changed',
    'user.approval_resolved',
    'user.project_edited',
    'user.manual_trigger',
  ]) {
    assert.ok(migration.includes(`'${kind}'`), `${kind} has no producer`);
  }

  assert.match(migration, /IF p_project_id IS NULL THEN\s+RETURN;/);
  assert.match(migration, /p_kind \|\| ':tx:' \|\| txid_current\(\)::text/);
  assert.match(migration, /ON CONFLICT \("project_id", "dedupe_key"\) WHERE "consumed_at" IS NULL/);
  assert.match(migration, /NEW\."batch_id"[\s\S]*'session\.started:batch:'/);
});

test('manual task starts record one Project request and automatic starts do not', () => {
  assert.match(tasksService, /if \(!auto && task\.projectId\) \{\s+await this\.recordManualProjectTriggers/);
  assert.match(tasksService, /runnable\.map\(\(task\) => task\.projectId\)/);
  assert.match(tasksService, /SELECT "project_event_manual_trigger"\(/);
});
