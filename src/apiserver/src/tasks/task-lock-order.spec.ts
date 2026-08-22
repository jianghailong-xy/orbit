/**
 * §8.6 LO1/LO4 as pure functions, plus the one thing a pure function cannot check: that the three
 * places the acceptance-fact column set is written down still agree with each other.
 *
 * The pg spec beside this one proves the ORDER holds against a real PostgreSQL. This one exists for
 * the half a database cannot answer — which PATCHes need the order at all, what a caller is told
 * when the retries are spent, and whether a column added to a trigger a year from now will be
 * noticed by anyone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTANCE_FACT_TASK_COLUMNS,
  LOCK_ORDER_RETRY_ATTEMPTS,
  LockOrderContendedError,
  PROJECT_FACT_WRITE_CONTENDED,
  TASK_FACT_SCOPE_MOVED,
  TaskScopeMovedError,
  isLockOrderContention,
  touchesAcceptanceFact,
  withLockOrderRetry,
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
    '0134_task_acceptance_fact_lock_order', 'migration.sql'),
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

test('the migration installs a guard on the dependency table too', () => {
  // The other half of the same order. An edge write locks two task rows without naming either —
  // the FK takes `FOR KEY SHARE` on the prerequisite and 0122's touch trigger UPDATEs the dependent
  // — so without this the order was whatever the planner chose.
  assert.match(MIGRATION, /CREATE TRIGGER "task_dependency_project_lock_order"/);
  assert.match(MIGRATION, /BEFORE INSERT OR UPDATE OR DELETE ON "task_dependency"/);
});

test('every acquisition the migration adds on a row it already holds is NOWAIT', () => {
  // The argument for a BEFORE trigger taking a project is that it never waits WHILE HOLDING THE
  // TASK: on UPDATE and DELETE the row being written is locked before any trigger of ours runs, so
  // waiting there is the edge that closes the cycle. One `FOR NO KEY UPDATE` without NOWAIT on
  // those paths would put the inversion back and nothing else in the suite would notice.
  //
  // INSERT is the exception, and it is 0132's exception: the row does not exist yet and the FK
  // checks are on the AFTER side, so nothing below the project is held and a waiter that holds
  // nothing cannot be in a cycle. It is excluded by name below rather than by the regex, so that
  // adding a THIRD waiting acquisition has to be an edit to this test.
  const guards = MIGRATION.slice(
    MIGRATION.indexOf('CREATE OR REPLACE FUNCTION "task_acceptance_fact_lock_order"'),
    MIGRATION.indexOf('-- 3. The two column lists are one list'),
  )
    // Comment lines out first. Both guards EXPLAIN the acquisitions they are removing — the FK's
    // `FOR KEY SHARE`, the touch trigger's `FOR NO KEY UPDATE` — and scanning prose for lock modes
    // finds the ones being described rather than the ones being taken.
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const acquisitions = [...guards.matchAll(/FOR (?:NO KEY UPDATE|UPDATE|SHARE|KEY SHARE)[^;]*/g)]
    .map((m) => m[0]);
  assert.ok(acquisitions.length >= 3, 'expected the guards to take project and task rows');
  const waiting = acquisitions.filter((a) => !/NOWAIT/.test(a));
  assert.equal(waiting.length, 1,
    `exactly one waiting acquisition is allowed (the INSERT branch); found: ${waiting.join(' | ')}`);
  // ...and it is under `TG_OP = 'INSERT'`, not somewhere else that happens to have been written
  // without NOWAIT.
  const at = guards.indexOf("IF TG_OP = 'INSERT' THEN");
  assert.notEqual(at, -1, 'the guard no longer has an INSERT branch');
  // Searched FORWARD from the branch, not from the start of the text: `ELSE` occurs earlier in the
  // function body, so anchoring on its first occurrence produced an empty slice and a test that
  // asserted nothing about anything.
  assert.match(guards.slice(at, guards.indexOf('ELSE', at)), /FOR NO KEY UPDATE;/);
});

// ---------------------------------------------------------------------------------------------
// LO4: what a caller is told, and how many times the server tries before saying it.
// ---------------------------------------------------------------------------------------------

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

test('a contended write is retried, with a fresh attempt each time', async () => {
  let attempts = 0;
  const result = await withLockOrderRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw deadlock();
    return 'committed';
  }, { sleep: async () => {}, random: () => 0.5 });
  assert.equal(result, 'committed');
  assert.equal(attempts, 3);
});

test('the retries are bounded, and what is left is a named condition rather than a 500', async () => {
  let attempts = 0;
  const error = await withLockOrderRetry(async () => {
    attempts += 1;
    throw deadlock();
  }, { sleep: async () => {}, random: () => 0.5 }).catch((e: unknown) => e);
  assert.equal(attempts, LOCK_ORDER_RETRY_ATTEMPTS);
  assert.ok(error instanceof LockOrderContendedError);
  assert.equal(error.code, PROJECT_FACT_WRITE_CONTENDED);
  // The cause is kept, so the log line still says which SQLSTATE it was.
  assert.equal((error.cause as { code: string }).code, '40P01');
  // ...and the caller is told nothing was written, because nothing was: PostgreSQL rolled each
  // attempt back whole. This sentence is the difference between "retry" and "check what happened".
  assert.match(error.message, /every one was rolled back whole/);
});

test('the backoff doubles and is jittered, so collided writers do not re-collide in lockstep', async () => {
  const slept: number[] = [];
  await withLockOrderRetry(async () => { throw deadlock(); }, {
    baseDelayMs: 100,
    sleep: async (ms) => { slept.push(ms); },
    random: () => 0,      // the bottom of the jitter window
  }).catch(() => {});
  assert.deepEqual(slept, [75, 150, 300]);          // 100·2^n · 0.75
  const top: number[] = [];
  await withLockOrderRetry(async () => { throw deadlock(); }, {
    baseDelayMs: 100,
    sleep: async (ms) => { top.push(ms); },
    random: () => 1,      // the top of it
  }).catch(() => {});
  assert.deepEqual(top, [125, 250, 500]);           // 100·2^n · 1.25
  // One sleep FEWER than attempts: the last failure is reported, not slept on.
  assert.equal(slept.length, LOCK_ORDER_RETRY_ATTEMPTS - 1);
});

test('only contention is retried; a refusal is a refusal', async () => {
  let attempts = 0;
  const error = await withLockOrderRetry(async () => {
    attempts += 1;
    throw Object.assign(new Error('duplicate key'), { code: '23505' });
  }, { sleep: async () => {} }).catch((e: unknown) => e);
  // Retrying a rule violation would turn one clear 409 into four identical failures and a delay.
  assert.equal(attempts, 1);
  assert.equal((error as { code: string }).code, '23505');
});

test('the conditions counted as contention are the ones that roll back whole', () => {
  for (const code of ['40P01', '40001', '55P03']) {
    assert.equal(isLockOrderContention(Object.assign(new Error('x'), { code })), true, code);
  }
  // The database's own typed markers say the same thing out loud, so they are recognised by name —
  // 0134 raises them with `lock_not_available`, which is `55P03`, but the marker is what survives
  // being wrapped by Prisma.
  for (const marker of ['TASK_FACT_PROJECT_BUSY', 'TASK_DEPENDENCY_PROJECT_BUSY']) {
    assert.equal(isLockOrderContention(new Error(`${marker}: project x is busy`)), true, marker);
  }
  assert.equal(isLockOrderContention(new Error(`${TASK_FACT_SCOPE_MOVED}: a task's project`)), true);
  // A serialization failure is retryable; a constraint violation and an ordinary error are not.
  assert.equal(isLockOrderContention(Object.assign(new Error('x'), { code: '23514' })), false);
  assert.equal(isLockOrderContention(new Error('something else')), false);
});

test('a scope that moved is a retry, not a failure', () => {
  const moved = new TaskScopeMovedError("a task's project");
  assert.equal(isLockOrderContention(moved), true);
  // Nothing was written — the check happens under the locks and before the write — so the caller's
  // whole remedy is a fresh snapshot.
  assert.match(moved.message, /nothing was written; retry/);
});

// ---------------------------------------------------------------------------------------------
// The door out: every marker reaches an HTTP caller as a sentence, never as a SQLSTATE.
// ---------------------------------------------------------------------------------------------

test('every condition this unit can raise is translated into a 409 sentence', () => {
  const raised = [
    'TASK_FACT_PROJECT_BUSY: project p is being written right now',
    'TASK_DEPENDENCY_PROJECT_BUSY: project p is being written right now',
    'TASK_DEPENDENCY_TASK_BUSY: a task this dependency edge names',
    `${TASK_FACT_SCOPE_MOVED}: a task's project changed`,
    `${PROJECT_FACT_WRITE_CONTENDED}: this project's tasks are being written`,
  ];
  for (const message of raised) {
    const translated = taskFenceConflictMessage(new Error(message));
    assert.ok(translated, `untranslated marker would reach the caller as a 500: ${message}`);
    assert.doesNotMatch(translated, /_BUSY|_MOVED|_CONTENDED|40P01/,
      'the translation should be a sentence, not the marker repeated');
  }
});

test('the spent-retry sentence does not advise the remedy the server just exhausted', () => {
  const translated = taskFenceConflictMessage(new LockOrderContendedError(4, deadlock()));
  assert.ok(translated);
  // Every other marker here ends "retry", because one retry is genuinely the remedy. This one has
  // already been retried four times, so telling the caller to retry would be advice the server took
  // on their behalf and does not want repeated immediately.
  assert.match(translated, /Try again in a moment/);
  assert.match(translated, /nothing was changed/);
});
