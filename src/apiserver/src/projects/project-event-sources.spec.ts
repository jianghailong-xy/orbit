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
const sessionScope = readFileSync(
  path.resolve(
    __dirname,
    '../../prisma/migrations/0133_session_event_source_update_scope/migration.sql',
  ),
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
  // Both halves now read off the FROZEN command rather than off the task as it stands: `auto` and
  // the Project are decided when the request is planned and recorded on its receipt, so a delivery
  // arriving after the task moved Project cannot file the press's signal against a Project the
  // press never named — or, if the task was deleted, lose it entirely.
  assert.match(tasksService, /if \(!target\.auto && target\.projectId\) \{\s+await this\.recordManualProjectTriggers/);
  assert.match(tasksService, /SELECT "project_event_manual_trigger"\(/);
  // The batch records one request per project for the tasks that ACTUALLY STARTED, not for
  // everything it considered runnable (§13.6 SU6). A task whose supersession commits between the
  // classification and its dispatch is refused by the database, and an event written beforehand
  // would leave a durable USER request — and a Coordinator wake to answer it — for a run that never
  // existed.
  assert.match(tasksService, /started\.has\(item\.taskId\)/);
  assert.match(tasksService, /results\.filter\(\(result\) => result\.ok\)/);
  assert.doesNotMatch(tasksService, /runnable\.map\(\(task\) => task\.projectId\)/);
});

test('the Session event source is declared over the three columns that can carry an event', () => {
  // `UPDATE OF` keeps the trigger from being queued at all, so a telemetry-only write never
  // reaches `task` or `project`; `WHEN` covers the writer that names one of the three columns
  // while re-asserting the value it already had. The behaviour behind both, and the barrier that
  // proves the lock domain actually shrank, is project-session-event-scope.pg.spec.ts.
  assert.match(sessionScope, /AFTER INSERT OR DELETE ON "session"/);
  assert.match(
    sessionScope,
    /AFTER UPDATE OF "status", "deleted_at", "merge_status" ON "session"/,
  );
  assert.match(
    sessionScope,
    /WHEN \(OLD\."status" IS DISTINCT FROM NEW\."status"\s+OR OLD\."deleted_at" IS DISTINCT FROM NEW\."deleted_at"\s+OR OLD\."merge_status" IS DISTINCT FROM NEW\."merge_status"\)/,
  );
  // The same predicate inside the function, ahead of both lookups: a redefined trigger must not
  // be able to put `task` and `project` back into a telemetry write's lock set.
  const body = sessionScope.slice(sessionScope.indexOf('CREATE OR REPLACE FUNCTION'));
  const earlyReturn = body.indexOf("IF TG_OP = 'UPDATE'");
  assert.ok(earlyReturn > 0 && earlyReturn < body.indexOf('FROM "task" t'));
  assert.match(
    body,
    /NEW\."status" IS NOT DISTINCT FROM OLD\."status"\s+AND NEW\."deleted_at" IS NOT DISTINCT FROM OLD\."deleted_at"\s+AND NEW\."merge_status" IS NOT DISTINCT FROM OLD\."merge_status" THEN\s+RETURN NULL;/,
  );
});
