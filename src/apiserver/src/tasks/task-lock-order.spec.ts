/**
 * §8.6 LO1/LO4's compatibility pre-lock helpers, plus their historical database contract.
 *
 * Migration 0182 retires the task/acceptance triggers, so these helpers are no longer part of the
 * DONE definition. They remain conservative application locking until that broader task-write
 * machinery is simplified; the final test makes the semantic retirement explicit.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTANCE_FACT_TASK_COLUMNS,
  TASK_FACT_SCOPE_MOVED,
  TaskScopeMovedError,
  touchesAcceptanceFact,
} from './task-lock-order';
import { taskFenceConflictMessage } from './task-supersession';

// ---------------------------------------------------------------------------------------------
// The closed set: which PATCHes reach a project, and which do not.
// ---------------------------------------------------------------------------------------------

test('every acceptance-fact column asks for the lock, whatever value it is given', () => {
  // Three values per field on purpose. The bug this replaces was a routing rule that asked what the
  // value MEANT — `dto.verdict != null && dto.verdict !== before.verdict` — so a revocation, a
  // restatement and a clear all read as "no verdict here" and took the no-lock path while still
  // writing the column and still firing the trigger.
  const fields = [
    'status', 'completionPolicy', 'projectId', 'verdict',
    'verifiesTaskId', 'terminalReason', 'supersededByTaskId',
  ] as const;
  for (const field of fields) {
    for (const value of ['DONE', null, '']) {
      assert.equal(
        touchesAcceptanceFact({ [field]: value }), true,
        `${field} = ${JSON.stringify(value)} writes an acceptance-fact column and must be locked`,
      );
    }
  }
});

test('a PATCH that writes no acceptance-fact column is left on the fast path', () => {
  assert.equal(touchesAcceptanceFact({}), false);
  // Explicit `undefined` is the shape a DTO actually arrives in for "not present", and it is the
  // one distinction the rule turns on: absent means the column is not written.
  assert.equal(touchesAcceptanceFact({ status: undefined, verdict: undefined }), false);
  // Renames, assignee moves, labels, due dates: none of them reach `project_acceptance_reopen`, and
  // making them queue behind a project lock would be a throughput regression bought for nothing.
  assert.equal(touchesAcceptanceFact({ title: 'x', assigneeId: 'a' } as never), false);
});

// ---------------------------------------------------------------------------------------------
// Drift: the same list, written three times, checked once.
// ---------------------------------------------------------------------------------------------

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations',
    '0136_task_acceptance_fact_lock_order', 'migration.sql'),
  'utf8',
);
const RETIREMENT = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations',
    '0182_project_done_gate_acceptance_only', 'migration.sql'),
  'utf8',
);

/** The `AFTER UPDATE OF` / `BEFORE UPDATE OF` column list of one named trigger, as a sorted set. */
function triggerColumns(sql: string, trigger: string): string[] {
  const at = sql.indexOf(`CREATE TRIGGER "${trigger}"`);
  assert.notEqual(at, -1, `${trigger} is not created by the migration text`);
  const body = sql.slice(at, sql.indexOf('EXECUTE FUNCTION', at));
  const of = body.indexOf('UPDATE OF');
  assert.notEqual(of, -1, `${trigger} does not name a column list`);
  return [...body.slice(of, body.indexOf('ON "task"', of)).matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1]).sort();
}

test('the guard pre-locks for exactly the columns the constant names', () => {
  // `ACCEPTANCE_FACT_TASK_COLUMNS` is the TypeScript copy of the list; the migration is the
  // database's. A column in one and not the other is a write path that reaches a project from an
  // AFTER trigger with the task already held — and it would be invisible, because nothing about a
  // new column's name says it reopens a project. The migration checks ITSELF against the AFTER
  // trigger at install time (`ACCEPTANCE_FACT_COLUMN_DRIFT`); this closes the third side.
  assert.deepEqual(
    triggerColumns(MIGRATION, 'task_acceptance_fact_lock_order_update'),
    [...ACCEPTANCE_FACT_TASK_COLUMNS].sort(),
  );
});

test('the DTO predicate covers exactly the columns the constant names', () => {
  // The two spellings of one set — snake_case columns and camelCase DTO fields — reconciled here
  // rather than trusted. Adding a column to the constant and forgetting the predicate would leave
  // the new fact taking the fast path, which is the original bug with a new column name on it.
  const camel = (c: string) => c.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
  for (const column of ACCEPTANCE_FACT_TASK_COLUMNS) {
    assert.equal(
      touchesAcceptanceFact({ [camel(column)]: 'v' }), true,
      `${column} is in the constant but ${camel(column)} does not ask for the lock`,
    );
  }
});

test('the migration deliberately guards nothing on the dependency table', () => {
  // 0132 removed the cause rather than ordering it: `task_dependency_dispatch_touch` is DROPped and
  // an edge write advances `task_dependency_revision` (rank 70) instead, so a pure edge path takes
  // the owner mutex and nothing else. A guard here would pre-take `task` rows NOWAIT from a path
  // that no longer touches them — turning edge writes that cannot deadlock into refusable ones.
  assert.doesNotMatch(MIGRATION, /CREATE TRIGGER "task_dependency_project_lock_order"/);
  assert.doesNotMatch(MIGRATION, /ON "task_dependency"/);
  // And the reason is written down where the next reader will look for it.
  assert.match(MIGRATION, /task_dependency_revision/);
});

test('0182 retires both task acceptance triggers and both historical pre-lock triggers', () => {
  for (const trigger of [
    'project_acceptance_task_fact',
    'project_acceptance_task_fact_update',
    'task_acceptance_fact_lock_order_insert_delete',
    'task_acceptance_fact_lock_order_update',
  ]) {
    assert.match(RETIREMENT, new RegExp(`DROP TRIGGER IF EXISTS "${trigger}" ON "task"`));
  }
});

test('every acquisition the migration adds on a row it already holds is NOWAIT', () => {
  // The argument for a BEFORE trigger taking a project is that it never waits WHILE HOLDING THE
  // TASK: on UPDATE and DELETE the row being written is locked before any trigger of ours runs, so
  // waiting there is the edge that closes the cycle. One `FOR NO KEY UPDATE` without NOWAIT on
  // those paths would put the inversion back and nothing else in the suite would notice.
  //
  // INSERT is the exception, and it is 0134's exception: the row does not exist yet and the FK
  // checks are on the AFTER side, so nothing below the project is held and a waiter that holds
  // nothing cannot be in a cycle.
  const guard = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION "task_acceptance_fact_lock_order"'),
    MIGRATION.indexOf('-- 2. The dependency side needs nothing'),
  )
    // Comment lines out first: the guard EXPLAINS the acquisitions it is removing, and scanning
    // prose for lock modes finds the ones being described rather than the ones being taken.
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const acquisitions = [...guard.matchAll(/FOR (?:NO KEY UPDATE|UPDATE|SHARE|KEY SHARE)[^;]*/g)]
    .map((m) => m[0]);
  assert.equal(acquisitions.length, 2, `expected the waiting and the NOWAIT branch: ${acquisitions}`);
  const waiting = acquisitions.filter((a) => !/NOWAIT/.test(a));
  assert.equal(waiting.length, 1,
    `exactly one waiting acquisition is allowed (the INSERT branch); found: ${waiting.join(' | ')}`);
  const at = guard.indexOf("IF TG_OP = 'INSERT' THEN");
  assert.notEqual(at, -1, 'the guard no longer has an INSERT branch');
  assert.match(guard.slice(at, guard.indexOf('ELSE', at)), /FOR NO KEY UPDATE;/);
});

// ---------------------------------------------------------------------------------------------
// The door out: the guard's refusal reaches an HTTP caller as a sentence, never as a SQLSTATE.
// ---------------------------------------------------------------------------------------------

test('the guard\'s refusal is translated into a 409 sentence', () => {
  for (const message of [
    'TASK_FACT_PROJECT_BUSY: project p is being written right now',
    `${TASK_FACT_SCOPE_MOVED}: a task's project changed`,
  ]) {
    const translated = taskFenceConflictMessage(new Error(message));
    assert.ok(translated, `untranslated marker would reach the caller as a 500: ${message}`);
    assert.doesNotMatch(translated, /_BUSY|_MOVED|55P03|lock_not_available/,
      'the translation should be a sentence, not the marker repeated');
    assert.match(translated, /retry/i, 'and it should say what to do');
  }
});

test('a scope that moved says nothing was written', () => {
  const moved = new TaskScopeMovedError("a task's project");
  assert.match(moved.message, /nothing was written; retry/);
  // NOT retried by `withTransactionRetry`, deliberately: this is raised before any write, and
  // `classifyTransactionError` treats `lock_not_available` and this marker as decisions rather
  // than faults. Re-running would spend the attempts re-earning the same correct refusal.
  assert.ok(taskFenceConflictMessage(moved));
});
