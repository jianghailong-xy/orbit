import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The half of 2026-09-02 that is easy to lose: the data the owner explicitly kept.
 *
 * "Can we delete only the executable and judgement DEPENDENCIES, and not the executable DATA" is
 * the sentence that fixed the scope. So this asserts, from the immutable migration ledger, that
 * nothing in the removal can reach a preserved row: not the 0177 pair and its CHECK, not a
 * `task_completion_criterion` label, not a task row, and not one of the three
 * `project_acceptance_*` tables.
 *
 * A row count is deliberately NOT asserted here. The count on a deployment is a property of that
 * deployment; what this file can hold immutably is that the migration has no statement capable of
 * changing one. `task-judgment-data-preserved.pg.spec.ts` checks the structure on a live server,
 * and the loaded-database replay is recorded in the task's delivery.
 */

const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0228_task_judgment_removal';
const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVAL_DIR, 'migration.sql'), 'utf8');

/** The removal's statements, comments stripped: prose naming a table is not a statement on it. */
const STATEMENTS = REMOVAL_SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');

const PRESERVED_RELATIONS = [
  'task',
  'project',
  'project_acceptance_criterion_definition',
  'project_acceptance_criterion',
  'project_acceptance_conclusion',
  'project_acceptance_run',
  'project_acceptance_audit',
  'task_completion_evidence',
  'task_legacy_evidence_import',
  'session',
  'run_event',
  'task_comment',
  'task_dependency',
  'session_merge_receipt',
];

test('the removal drops exactly the five judgment relations and their two views', () => {
  const dropped = [...STATEMENTS.matchAll(/DROP\s+(TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?"([a-z_0-9]+)"/gi)]
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`);
  assert.deepEqual(dropped.sort(), [
    'TABLE task_executable_judgment_result',
    'TABLE task_judgment_backfill_batch',
    'TABLE task_judgment_inbox_item',
    'TABLE task_judgment_push_delivery',
    'TABLE task_judgment_request',
    'VIEW project_judgment_blocker',
    'VIEW task_judgment_signal',
  ]);
});

test('no preserved relation is dropped, altered, or written by the removal', () => {
  for (const relation of PRESERVED_RELATIONS) {
    assert.doesNotMatch(STATEMENTS, new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"${relation}"`, 'i'),
      `the removal drops ${relation}`);
    assert.doesNotMatch(STATEMENTS, new RegExp(`ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"${relation}"`, 'i'),
      `the removal alters ${relation}`);
  }
  // No ALTER TABLE at all, in fact, and no DML of any kind. Both halves matter: the first is what
  // could drop a column, the second is what could rewrite a row.
  assert.deepEqual([...STATEMENTS.matchAll(/ALTER\s+TABLE/gi)].length, 0);
  for (const write of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+"?[a-z_]/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i, /\bALTER\s+TYPE\b/i]) {
    assert.equal(write.test(STATEMENTS), false, `the removal carries a ${write}`);
  }
});

test('the 0177 declaration and the completion criterion enum are never named as targets', () => {
  // The two columns and the CHECK are the data the owner kept. Nothing may drop or rename them,
  // and no enum label may be removed — the type is not among the seven the removal drops.
  for (const target of ['acceptance_command', 'acceptance_expected_exit_code',
    'task_executable_acceptance_pair', 'task_completion_criterion']) {
    assert.doesNotMatch(STATEMENTS, new RegExp(`DROP\\s+(?:COLUMN|CONSTRAINT|TYPE)\\s+(?:IF\\s+EXISTS\\s+)?"?${target}"?`, 'i'),
      `the removal drops ${target}`);
    assert.doesNotMatch(STATEMENTS, new RegExp(`RENAME[^\\n]*${target}`, 'i'));
  }
  const droppedTypes = [...STATEMENTS.matchAll(/DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?"([a-z_0-9]+)"/gi)]
    .map((match) => match[1]).sort();
  assert.deepEqual(droppedTypes, [
    'task_judgment_decision',
    'task_judgment_push_delivery_status',
    'task_judgment_recipient_type',
    'task_judgment_request_origin',
    'task_judgment_request_status',
    'task_judgment_supersession_rule',
  ]);
  // `task_judgment_device_policy` is deliberately NOT among them: 0184 also gave it to
  // `task_legacy_evidence_import`, a preserved ledger, and dropping it would mean rewriting a
  // column of a table this change has no mandate over.
  assert.ok(!droppedTypes.includes('task_judgment_device_policy'));
});

test('the 0150/0172 gate triggers and 0141 verdict functions are not touched by the removal', () => {
  for (const name of ['project_acceptance_done_gate', 'project_acceptance_advance_epoch',
    'project_acceptance_epoch_audit', 'project_acceptance_criteria_fact',
    'task_verification_verdict_atomic', 'task_verification_carrier_status_derive']) {
    assert.doesNotMatch(STATEMENTS, new RegExp(`DROP\\s+(?:TRIGGER|FUNCTION)[^\\n]*${name}`, 'i'),
      `the removal drops ${name}`);
    assert.doesNotMatch(STATEMENTS, new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+"?${name}"?`, 'i'),
      `the removal rewrites ${name}, which must stay byte-identical`);
  }
  // One function IS rewritten, on purpose and only one: the DONE writer fence loses its judgment
  // lane and keeps the other four.
  const replaced = [...STATEMENTS.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"([a-z_0-9]+)"/gi)]
    .map((match) => match[1]);
  assert.deepEqual(replaced, ['task_done_canonical_writer_fence']);
  const fence = STATEMENTS.slice(STATEMENTS.indexOf('CREATE OR REPLACE FUNCTION'));
  assert.doesNotMatch(fence.slice(0, fence.indexOf('$$ LANGUAGE plpgsql;')), /task_judgment_request/u);
  for (const lane of ['verifies_task_id', 'ALL_CHILDREN_DONE', 'VERIFICATION_PASSED']) {
    assert.ok(fence.includes(lane), `the fence lost its ${lane} lane`);
  }
});

test('the ledger stays append-only, and every later migration is accounted for', () => {
  const dirs = readdirSync(MIGRATIONS).filter((dir) => /^\d{4}_/.test(dir)).sort();
  // 0228 is no longer the newest, and each later migration below was read against the claims in
  // this file before being added to the list. Anything ADDED after it is one that has not been,
  // which is what this assertion is for.
  //
  //   0229 removed the project acceptance judgment, by a later and separate account-owner
  //        decision. It names none of the preserved relations above.
  //   0230 restored the EXECUTABLE exit-code comparison, again by account-owner decision. It
  //        matters here because it is the second CREATE OR REPLACE of the DONE writer fence, and
  //        a replacement is how one migration silently reverts another. It does not: every lane
  //        0228 wrote is carried over byte for byte, it ADDS one lane for EXECUTABLE, and it
  //        carries no DDL and no DML of any kind besides that one function body. The preserved
  //        data this file is about — the 0177 pair, the criterion labels, the task rows, the
  //        project acceptance tables — is not reachable from it.
  assert.deepEqual(dirs.slice(dirs.indexOf(REMOVAL_DIR)),
    [REMOVAL_DIR, '0229_project_acceptance_judgment_removal',
      '0230_executable_exit_code_judgment'],
    'a later migration exists; re-read it before trusting the assertions above');
  // Stated rather than described: 0230's fence differs from 0228's by exactly one added lane.
  const later = readFileSync(
    path.join(MIGRATIONS, '0230_executable_exit_code_judgment', 'migration.sql'), 'utf8',
  );
  const executable = (sql: string): string[] => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION "task_done_canonical_writer_fence"');
    return sql.slice(start, sql.indexOf('$$ LANGUAGE plpgsql;', start))
      .split('\n').map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('--'));
  };
  const carried = executable(REMOVAL_SQL);
  const restated = executable(later);
  const added = restated.filter((line) => !carried.includes(line));
  assert.deepEqual(added, [
    'IF NOT canonical',
    'AND NEW."completion_criterion" = \'EXECUTABLE\'::"task_completion_criterion"',
    'AND NEW."acceptance_command" IS NOT NULL',
    'AND NEW."acceptance_expected_exit_code" IS NOT NULL THEN',
    "HINT = 'let the declared acceptance command run, or record a verification verdict; "
      + "EVIDENCE_JUDGMENT is declared but has no implementation';",
  ], '0230 changed a line of the fence that 0228 owns');
  const lost = carried.filter((line) => !restated.includes(line));
  assert.deepEqual(lost, [
    "HINT = 'record a verification verdict; EXECUTABLE and EVIDENCE_JUDGMENT are declared but "
      + "have no implementation';",
  ], '0230 dropped a lane 0228 wrote: a CREATE OR REPLACE is how that happens silently');
  // 0177 itself is immutable and still declares the pair this change kept.
  const declaration = readFileSync(
    path.join(MIGRATIONS, '0177_task_executable_acceptance', 'migration.sql'), 'utf8',
  );
  assert.match(declaration, /"acceptance_command"/u);
  assert.match(declaration, /"acceptance_expected_exit_code"/u);
  assert.match(declaration, /task_executable_acceptance_pair/u);
});
