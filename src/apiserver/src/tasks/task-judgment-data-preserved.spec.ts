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
  //   0231 landed the SOURCE snapshot: a new `project_codebase` table, fifteen `session` columns
  //        and two on `task`, two new guards of its own, and one value added to
  //        `project_blocker_kind_chk`. It is pure ADDITION — it names none of the six preserved
  //        triggers/functions above, neither of the 0177 relations, and no `project_acceptance_*`
  //        object; its only two `CREATE OR REPLACE FUNCTION`s are its own new guards, so it is not
  //        a third writer of the DONE fence.
  //   0232 landed the task criterion declaration: two nullable columns on `task`, one index and
  //        one foreign key into `project_acceptance_criterion_definition` with ON DELETE SET NULL.
  //        Pure addition, and reachable from nothing here: it names none of the six preserved
  //        triggers/functions, neither 0177 relation and no `project_acceptance_*` TRIGGER or
  //        FUNCTION; it carries no `CREATE OR REPLACE FUNCTION` at all, so it is not another
  //        writer of the DONE fence; and it writes no data, so no preserved row is touched. The
  //        `project_acceptance_criterion_definition` table it references is not modified — being
  //        pointed AT changes nothing about a criterion, which is the whole reason the referential
  //        action is SET NULL on the referencing side.
  //   0233 removed the four wiring columns from `project_acceptance_criterion_definition` —
  //        `completion_criterion`, `acceptance_command`, `acceptance_expected_exit_code` and
  //        `evidence_task_id` — with the CHECK that bound them. Read against every claim above:
  //        it is the first later migration that ALTERs a preserved relation, and the alteration is
  //        confined to that one table. It drops columns whose NAMES appear in the 0177 pair, but
  //        on the criterion, not on `task`: `task.acceptance_command`,
  //        `task.acceptance_expected_exit_code` and `task_executable_acceptance_pair` are not
  //        named by it at all, nor is any task row read or written. It carries no `DROP TYPE`, and
  //        its closing gate RAISEs unless `task_completion_criterion` still holds all three labels
  //        with `task.completion_criterion` as its one remaining user — so the enum is not merely
  //        untouched, it is asserted. It names none of the six preserved triggers/functions above,
  //        and its two `CREATE OR REPLACE FUNCTION`s are `project_acceptance_definition_normalize`
  //        and `project_completion_contract_snapshot`, so it is not a third writer of the DONE
  //        fence. Its one DML statement rewrites the three hash columns of the criterion rows it
  //        just narrowed, which is the table 0228 preserved and 0233 is deliberately changing.
  //   0234 removed `evaluation_plan_revision` and `evaluation_plan_hash` from
  //        `project_acceptance_criterion_definition` — the lane the four columns 0233 dropped used
  //        to feed — by a further account-owner decision. Read against every claim above: like
  //        0233 it ALTERs exactly one preserved relation and nothing else. It names none of the
  //        six preserved triggers/functions, neither 0177 relation, and no `task` object at all —
  //        not `task.acceptance_command`, not `task.acceptance_expected_exit_code`, not
  //        `task_executable_acceptance_pair`, not `task_completion_criterion`, and no task row is
  //        read or written. It carries no `DROP TABLE`, `DROP VIEW` or `DROP TYPE`; its one
  //        `DROP FUNCTION` is `project_acceptance_definition_evaluation_plan_hash`, which existed
  //        only to compute the column it drops. Its two `CREATE OR REPLACE FUNCTION`s are
  //        `project_acceptance_definition_normalize` and `project_completion_contract_snapshot`,
  //        so it is not a third writer of the DONE fence. It has no INSERT/UPDATE/DELETE of its
  //        own: its only write is `project_refresh_completion_contract`, which rebuilds
  //        `project_completion_contract` — a projection that postdates 0228 and is not one of the
  //        preserved relations — because that row stored an `evaluationPlanVersions` key listing
  //        the two columns this migration removes.
  //   0236 made the EXECUTABLE acceptance budget declarable: one nullable column on `task`,
  //        `acceptance_timeout_seconds`, and a CHECK over it. Read against every claim above: it
  //        ALTERs `task`, which is where the 0177 pair lives, but it only ADDS — it drops no
  //        column, no constraint, no trigger, no function and no type, and it names none of the
  //        six preserved triggers/functions, neither 0177 relation and no `project_acceptance_*`
  //        object. It cannot invalidate a preserved row: every existing row reads NULL for the new
  //        column, which the new constraint permits unconditionally, so the CHECK is satisfied
  //        without a backfill and no task row is read or written. It carries no
  //        `CREATE OR REPLACE FUNCTION` at all, so it is not another writer of the DONE fence, and
  //        it neither reads nor recomputes `task.completion_criterion` — it only mentions the
  //        label 'EXECUTABLE' inside its own CHECK.
  //   0237 dropped the column default from `task.completion_criterion`, so that a criterion has to
  //        be declared rather than supplied by the database. Read against every claim above: it is
  //        one statement, `ALTER TABLE "task" ALTER COLUMN ... DROP DEFAULT`. Like 0236 it ALTERs
  //        `task` — the table whose ROWS this file is about — and like 0236 it cannot reach one: a
  //        default is read only by an INSERT that omits the column, so dropping it changes what a
  //        FUTURE insert must say and leaves every stored value where it is. The column stays NOT
  //        NULL and keeps its type. It has no INSERT/UPDATE/DELETE, so no preserved row is read or
  //        written; it names neither 0177 relation and not `task_executable_acceptance_pair`; it
  //        carries no `ALTER TYPE` and no `DROP TYPE`, so all three `task_completion_criterion`
  //        labels survive and `task.completion_criterion` remains the type's one user; it names no
  //        `project_acceptance_*` object; and it carries no `CREATE OR REPLACE FUNCTION` and no
  //        TRIGGER at all, so it is not another writer of the DONE fence.
  //   0238 added the evidence decision door: one new table, `task_evidence_decision`, one new enum
  //        `task_evidence_decision_value`, and two indexes. Read against every claim above: it is
  //        pure addition and touches no preserved relation. It ALTERs nothing — not `task`, not
  //        `task_completion_evidence` — so the 0177 pair, `task_executable_acceptance_pair` and
  //        every stored row are out of its reach; it names no `project_acceptance_*` object and
  //        none of the six preserved triggers/functions; it carries no `CREATE OR REPLACE
  //        FUNCTION` and no TRIGGER at all, so it is not another writer of the DONE fence, and
  //        EVIDENCE_JUDGMENT remains — to that fence — a criterion with no implementation. It
  //        REFERENCES two preserved tables, `task(id, owner_id)` and 0181's bound-fact key on
  //        `task_completion_evidence`, which is why it needed no column of its own on either:
  //        being pointed AT changes nothing about a row, and neither unique constraint is created,
  //        dropped or rewritten here. It carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive untouched, and it has no INSERT/UPDATE/
  //        DELETE, so no preserved row is read or written.
  //   0239 gave the DONE writer fence a lane for EVIDENCE_JUDGMENT, so a CONFIRM decision on the
  //        current evidence revision derives DONE. Read against every claim above: it is the THIRD
  //        `CREATE OR REPLACE` of that function and therefore the third chance to revert one of
  //        the others silently — it does not, every lane 0228 and 0230 wrote is restated and one
  //        is added, and the assertion below still holds 0230 to differing from 0228 by exactly
  //        its own. It creates no table, column, index, enum, type or trigger and carries no
  //        INSERT/UPDATE/DELETE, so no preserved row is read or written and neither 0177 relation,
  //        `task_executable_acceptance_pair` nor any `project_acceptance_*` object is named. Its
  //        new lane READS two tables inside the fence body — `task_completion_evidence`, which is
  //        preserved, and 0238's `task_evidence_decision` — which is not one of the things this
  //        file forbids: reading a row drops, alters and rewrites nothing, and the unique
  //        constraints the read leans on are neither created nor changed here. It carries no
  //        `ALTER TYPE` and no `DROP TYPE`, so all three `task_completion_criterion` labels
  //        survive, and it names none of the six preserved triggers/functions above.
  assert.deepEqual(dirs.slice(dirs.indexOf(REMOVAL_DIR)),
    [REMOVAL_DIR, '0229_project_acceptance_judgment_removal',
      '0230_executable_exit_code_judgment', '0231_project_codebase_session_source',
      '0232_task_criterion_declaration',
      '0233_project_acceptance_criterion_wiring_removal',
      '0234_project_acceptance_evaluation_plan_lane_removal',
      '0236_executable_acceptance_budget',
      '0237_task_completion_criterion_explicit_declaration',
      '0238_task_evidence_decision',
      '0239_evidence_judgment_confirm_lane'],
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
