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
  //   0240 added `runner.model_catalog_refresh_at`, one nullable column recording that someone
  //        asked a machine to re-read what models its CLIs offer. Read against every claim above:
  //        it is a single `ALTER TABLE "runner" ADD COLUMN` and `runner` is not a relation this
  //        file preserves, nor is it reachable from one — it names no `task` object, neither 0177
  //        relation, `task_executable_acceptance_pair` nor any `project_acceptance_*` object. It
  //        creates no table, index, enum or trigger, drops nothing, carries no `ALTER TYPE` and no
  //        `DROP TYPE`, has no `CREATE OR REPLACE FUNCTION` at all — so it is not a fourth writer
  //        of the DONE fence — and has no INSERT/UPDATE/DELETE, so no preserved row is read or
  //        written. Every existing runner reads NULL for the new column, which is exactly "nobody
  //        has asked", so it needs no backfill.
  //   0241 gave `attachment` a third, optional scope: `task_id`, with a foreign key into `task`
  //        (ON DELETE CASCADE), an index and a CHECK making the three scopes mutually exclusive.
  //        Read against every claim above: `attachment` is not a relation this file preserves and
  //        is not reachable from one. It ALTERs only `attachment` — it names no `task` COLUMN,
  //        neither 0177 relation, not `task_executable_acceptance_pair` and no
  //        `project_acceptance_*` object. It REFERENCES `task(id)`, which changes nothing about a
  //        task row: being pointed at is not being written, and no unique constraint on `task` is
  //        created, dropped or rewritten to carry it. It creates no table, enum or trigger, drops
  //        nothing, carries no `ALTER TYPE` and no `DROP TYPE` — so all three
  //        `task_completion_criterion` labels survive — has no `CREATE OR REPLACE FUNCTION` at
  //        all, so it is not a fourth writer of the DONE fence, and has no INSERT/UPDATE/DELETE,
  //        so no preserved row is read or written. Every existing attachment reads NULL for the
  //        new column, which the new CHECK permits unconditionally, so it needs no backfill.
  //   0242 widened `project_coordinator_wake`'s event CHECK by one spelling, so a criterion whose
  //        work is finished and whose result is on nobody's default branch has a name. Read against
  //        every claim above: `project_coordinator_wake` is not a relation this file preserves and
  //        is not reachable from one. It is one `ALTER TABLE ... DROP CONSTRAINT / ADD CONSTRAINT`
  //        over that table alone — it names no `task` object, neither 0177 relation,
  //        `task_executable_acceptance_pair` nor any `project_acceptance_*` object. It creates no
  //        table, column, index, enum or trigger, drops nothing but the constraint it immediately
  //        restates, carries no `ALTER TYPE` and no `DROP TYPE` — so all three
  //        `task_completion_criterion` labels survive — has no `CREATE OR REPLACE FUNCTION` at all,
  //        so it is not a fourth writer of the DONE fence, and has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. The set only grows, so no stored event can be refused
  //        by it and it needs no backfill.
  //   0243 gave `project_coordinator_wake` a fourth end — DELIVERED, the fact handed to the
  //        coordinator conversation a project already has — with one nullable JSONB column
  //        (`delivery`) recording what that delivery carried. Read against every claim above: like
  //        0242 it is confined to `project_coordinator_wake`, which is not a relation this file
  //        preserves and is not reachable from one. It ADDs one column, restates two CHECKs it
  //        widens (`status`, `session_id`), adds one of its own over the new column, and replaces
  //        one unique INDEX on that same table with a partial one — it names no `task` object,
  //        neither 0177 relation, `task_executable_acceptance_pair` nor any `project_acceptance_*`
  //        object. It creates no table, enum or trigger, carries no `ALTER TYPE` and no `DROP
  //        TYPE` — so all three `task_completion_criterion` labels survive — has no `CREATE OR
  //        REPLACE FUNCTION` at all, so it is not a fourth writer of the DONE fence, and has no
  //        INSERT/UPDATE/DELETE, so no preserved row is read or written. Both CHECKs only grow and
  //        the index only narrows what it constrains, so no stored row can be refused by it and it
  //        needs no backfill; every existing wake reads NULL for the new column, which its CHECK
  //        permits unconditionally.
  //   0244 gave `session` one nullable TEXT column, `engine_phase`: what the engine is doing in a
  //        stretch where it produces nothing else, so a compaction is distinguishable from a cold
  //        start. Read against every claim above: unlike 0240-0243 it does ALTER a relation this
  //        file preserves, which is what this ledger entry is for. The alteration is confined to
  //        that one table and is pure addition — one `ALTER TABLE ... ADD COLUMN` and one
  //        `COMMENT ON COLUMN`, both DDL. It names no `task` object, neither 0177 relation,
  //        `task_executable_acceptance_pair` nor any `project_acceptance_*` object. It creates no
  //        table, index, enum or trigger, drops nothing, carries no `ALTER TYPE` and no `DROP
  //        TYPE` — so all three `task_completion_criterion` labels survive — and has no `CREATE
  //        OR REPLACE FUNCTION` at all, so it is not a fourth writer of the DONE fence. Above all
  //        it has no INSERT/UPDATE/DELETE: a preserved session row is neither read nor written by
  //        it, and gains only a column reading NULL, which is exactly "no named phase", so it
  //        needs no backfill and no stored row can be refused by it.
  //   0245 gave `CONFIRM_ACCEPTANCE_CRITERIA` — HUMAN_ONLY in the authority table since unit T6 and
  //        with no writer anywhere until now — one place to be recorded: a new table,
  //        `project_standard_set_confirmation`, holding the account owner's statement that ONE
  //        version of a project's acceptance criteria expresses its goal, plus one index. Read
  //        against every claim above: it is pure addition and `project_standard_set_confirmation`
  //        is not a relation this file preserves. It ALTERs nothing — not `task`, not `project`,
  //        not `project_acceptance_criterion_definition` — so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It REFERENCES
  //        `project(id, owner_id)`, which changes nothing about a project row: being pointed at is
  //        not being written, and that unique constraint is neither created, dropped nor rewritten
  //        here. It names no `project_acceptance_*` object and none of the six preserved
  //        triggers/functions; it creates no enum, no function and no trigger — so it is not
  //        another writer of the DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all
  //        three `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE,
  //        so no preserved row is read or written. It is also not 0189's confirmation coming back:
  //        that relation, its two indexes and its BEFORE UPDATE guard were dropped by 0226 and are
  //        named by no statement here, and nothing reads this new row to allow or refuse anything,
  //        so the acceptance DONE gate 0229 removed is not reinstated under another name.
  //   0246 widened `project_coordinator_wake`'s event CHECK by one more spelling —
  //        `PROJECT_ACCEPTANCE_LANDED`, a project whose every task is terminal AND whose every
  //        stated criterion is satisfied with its work on the default branch — so the confirmation
  //        card has a fact of its own instead of riding a key the judgment branch spends first.
  //        Read against every claim above: it is 0242 again, statement for statement. One
  //        `ALTER TABLE "project_coordinator_wake" DROP CONSTRAINT / ADD CONSTRAINT` over a table
  //        this file does not preserve and cannot reach one from — it names no `task` object,
  //        neither 0177 relation, `task_executable_acceptance_pair` nor any `project_acceptance_*`
  //        object. Despite the event's SPELLING it touches no acceptance relation: the string
  //        appears only inside the CHECK's list of permitted values, and no criterion's `text` or
  //        `verification_method` is read, written or constrained by it. It creates no table,
  //        column, index, enum, type or trigger, drops nothing but the constraint it immediately
  //        restates, carries no `ALTER TYPE` and no `DROP TYPE` — so all three
  //        `task_completion_criterion` labels survive — has no `CREATE OR REPLACE FUNCTION` at
  //        all, so it is not another writer of the DONE fence, and has no INSERT/UPDATE/DELETE, so
  //        no preserved row is read or written. The set only grows, so no stored event can be
  //        refused by it and it needs no backfill. Nothing reads the new event to allow or refuse
  //        a status: it is delivered as a message and decides nothing.
  //   0249 added `project_criteria_decision`, one row per answered criteria proposal: the account
  //        owner's APPROVE or REJECT of an edit that was held because it does not plainly tighten
  //        the ruler, keyed by the `project_ratified_action_intent` row that asked. Read against
  //        every claim above: it is pure addition and `project_criteria_decision` is not a relation
  //        this file preserves. It ALTERs nothing — not `task`, not `project`, not
  //        `project_acceptance_criterion_definition` — so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It REFERENCES
  //        `project(id)`, `user(id)` and `project_ratified_action_intent(id)`, which changes
  //        nothing about any of those rows: being pointed at is not being written. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no enum, no function and no trigger — so it is not another writer of the DONE
  //        fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. It is also not the criteria proposal channel 0217
  //        built coming back: that relation, its six indexes and its nine functions were dropped
  //        by 0223, and not one of their names appears in any statement here. Nothing reads this
  //        new row to allow or refuse a status — a decision is what moves the criteria, and
  //        `status` stays a projection of the same two inputs it was a projection of before.
  //   0250 widened 0246's CHECK by one more spelling — `CRITERIA_DECISION_PENDING`, a project
  //        holding a loosening edit to its acceptance criteria that nobody has decided yet — so
  //        the coordinator conversation can be told a proposal is waiting. Read against every
  //        claim above: it is 0246 again, statement for statement, and the same reasoning holds
  //        line for line. One `ALTER TABLE "project_coordinator_wake" DROP CONSTRAINT / ADD
  //        CONSTRAINT` over a table this file does not preserve and cannot reach one from — it
  //        names no `task` object, neither 0177 relation, `task_executable_acceptance_pair` nor
  //        any `project_acceptance_*` object. Despite the event naming criteria it touches no
  //        acceptance relation: the string appears only inside the CHECK's list of permitted
  //        values, and no criterion's `text` or `verification_method` is read, written or
  //        constrained by it — which is the whole point of the fact, since a HELD edit is one
  //        that wrote no definition. It creates no table, column, index, enum, type or trigger,
  //        drops nothing but the constraint it immediately restates, carries no `ALTER TYPE` and
  //        no `DROP TYPE` — so all three `task_completion_criterion` labels survive — has no
  //        `CREATE OR REPLACE FUNCTION` at all, so it is not another writer of the DONE fence,
  //        and has no INSERT/UPDATE/DELETE, so no preserved row is read or written. The set only
  //        grows, so no stored event can be refused by it and it needs no backfill. Nothing reads
  //        the new event to allow or refuse a status: it was only ever delivered as a message —
  //        and since 2026-09-10 nothing builds it at all — and the decision it announces is the
  //        account owner's to make through a door of its own.
  //   0251 gave project acceptance §6 — "a criterion the evidence's own session wrote does not
  //        count" — the fact it reads, which did not exist: a new table,
  //        `project_criteria_authorship`, one row per `(definition_id, revision)` saying which
  //        conversation authored that version, plus one index and a backfill of the versions
  //        standing when it ran. Read against every claim above: the new relation is not one this
  //        file preserves, and authorship deliberately did NOT go on
  //        `project_acceptance_criterion_definition` as a column — three suites assert that
  //        relation's column list literally, and this is a fact about the write rather than about
  //        the assertion. So it ALTERs nothing: not `task`, not `project`, not
  //        `project_acceptance_criterion_definition`, and the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach. No
  //        criterion's `text` or `verification_method` can move by one byte. It REFERENCES
  //        `project(id, owner_id)`, which changes nothing about a project row: being pointed at is
  //        not being written, and that unique constraint is neither created, dropped nor rewritten
  //        here. It names no `project_acceptance_*` object in any statement and none of the six
  //        preserved triggers/functions; it creates no enum, no function and no trigger — so it is
  //        not another writer of the DONE fence — and carries no `ALTER TYPE` and no `DROP TYPE`,
  //        so all three `task_completion_criterion` labels survive. Unlike 0245 it does carry one
  //        INSERT, and that INSERT is the backfill: it writes only the new table's own rows, and
  //        it READS `project_acceptance_criterion_definition` and `project` to do it — which is
  //        not one of the things this file forbids, exactly as 0239's fence body reads two
  //        preserved tables. Reading a row drops, alters and rewrites nothing. Nothing reads the
  //        new row to allow or refuse anything yet: a project's status is decided exactly as
  //        before, and the acceptance DONE gate 0229 removed is not reinstated under another name.
  //   0253 added `session.fast_mode`, one boolean saying whether a session runs in its runtime's
  //        fast lane. Read against every claim above: it is one `ALTER TABLE "session" ADD COLUMN
  //        ... NOT NULL DEFAULT false` and nothing else. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, index, enum, type, function or trigger — so it is not another writer
  //        of the DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. The default is a constant, so PG writes only
  //        `pg_attribute.attmissingval` and never rewrites the heap: there is no backfill here and
  //        none is owed. Nothing reads the new column to allow or refuse a status — it is read by
  //        the claim, to decide one setting a runner hands an engine.
  //   0254 added `session.run_claimed_at` and `session.engine_phase_since`, two nullable
  //        timestamps the waiting notices count from — the claim writes the first, a change of
  //        `engine_phase` writes the second. Read against every claim above: like 0253 it ALTERs
  //        `session` and nothing else — two `ALTER TABLE "session" ADD COLUMN` and two `COMMENT ON
  //        COLUMN`, all DDL. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, index, enum, type, function or trigger — so it is not another writer
  //        of the DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. Both columns are nullable with no default, a
  //        catalog-only change: there is no backfill, and every existing session reads NULL, which
  //        is "not measured". Nothing reads either column to allow or refuse anything; they are
  //        clocks a notice displays.
  //   0255 added `codex_rate_limit_reset_operation`, one row per confirmed Codex earned rate-limit
  //        reset, and two nullable `runner` columns every heartbeat overwrites
  //        (`heartbeat_lease_owner`, `heartbeat_draining`). Read against every claim above: neither
  //        the new relation nor `runner` is one this file preserves. It does not touch `task`,
  //        `project` or `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It REFERENCES
  //        `user(id)` and `runner(id)`, which changes nothing about either row. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions. Unlike
  //        0253 and 0254 it does create one function and one trigger —
  //        `codex_rate_limit_reset_operation_guard`, BEFORE UPDATE on its own new table, reading only
  //        that row's OLD and NEW — so it is not another writer of the DONE fence, which belongs to
  //        `task`. It carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE statement,
  //        so no preserved row is read or written. Nothing reads the new rows or columns to allow or
  //        refuse a status: they decide whether one reset credit may be consumed.
  //   0256 added `session.commit_result_message`, the runner's message for a commit that went
  //        through, kept verbatim beside `commit_error`. Read against every claim above: like 0254
  //        it ALTERs `session` and nothing else — one `ALTER TABLE "session" ADD COLUMN` and one
  //        `COMMENT ON COLUMN`, both DDL. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, index, enum, type, function or trigger — so it is not another writer
  //        of the DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. The column is nullable with no default, a catalog-only
  //        change: there is no backfill, and every existing session reads NULL. Nothing reads it to
  //        allow or refuse anything; it is text a client displays.
  //   0258 settled, once, the PENDING approvals 0252's reaper can never reach: rows filed before
  //        `approval.turn_id` existed that nothing is asking any more. Read against every claim
  //        above: it is one anonymous `DO` block holding one `UPDATE "approval"`, a relation this
  //        file does not preserve, which moves `status` and `message` on the rows it matches and
  //        nothing else. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, column, index, enum, type, function or trigger — a `DO` block runs
  //        and is discarded, so it is not another writer of the DONE fence — and carries no
  //        `ALTER TYPE` and no `DROP TYPE`, so all three `task_completion_criterion` labels
  //        survive. It has no INSERT and no DELETE. It READS `session`, a preserved relation, to
  //        tell whether a session is still generating, and reads `tool_call` and Prisma's
  //        `_prisma_migrations`; as with 0239's fence body and 0251's backfill, reading a row
  //        drops, alters and rewrites nothing. Nothing reads a settled row to allow or refuse a
  //        status: an approval is not a credential, and ABANDONED is not a decision.
  //   0259 created the four Watch relations — `watch`, `watch_target`, `watch_match` and
  //        `watch_delivery` — for the persistent cross-session observation contract. Read against
  //        every claim above: it is four `CREATE TABLE IF NOT EXISTS` statements and their
  //        indexes, and there is no `ALTER TABLE` in the file at all, so `task`, `project` and
  //        `project_acceptance_criterion_definition` are untouched — the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no enum, no function and no trigger — so it is not another writer of the DONE
  //        fence — and carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive. It has no INSERT, UPDATE or DELETE of any
  //        kind: the four tables are new and start empty, so unlike 0251 there is not even a
  //        backfill reading a preserved row. It REFERENCES `user`("id") and `session`("id") from
  //        two new foreign keys, which changes nothing about either — being pointed at is not
  //        being written — and it deliberately puts NO foreign key on `watch_target`'s target, so
  //        it adds no reference to `task` whatsoever. Nothing reads a Watch row to allow or refuse
  //        a status: a watch observes a task's completion, it never decides one, and contract §9.1
  //        states the separation the other way round too — a Watch may not become a dependency
  //        gate or a fifth `dependencyState`.
  //   0260 added one partial index, `watch_delivery_lease_expiry_idx` on `watch_delivery`
  //        ("lease_deadline_at") WHERE "state" = 'IN_FLIGHT', for the Watch delivery worker's
  //        lease-expiry sweep. Read against every claim above: it is a single `CREATE INDEX IF NOT
  //        EXISTS` on a table 0259 created and nothing else — no `ALTER TABLE`, so `task`, `project`
  //        and `project_acceptance_criterion_definition` are untouched, the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, enum, type, function or trigger — so it is not another writer of the
  //        DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT, UPDATE or DELETE, so no
  //        row is read or written. Nothing reads the index to allow or refuse a status: it only
  //        makes returning an abandoned delivery lease cheap.
  //   0261 let a `watch_delivery` row carry a Watch's expiry as well as a Match, so that contract
  //        §5's turn can reach a session waiting on a watch that expired unmatched. Read against
  //        every claim above: it ALTERs `watch_delivery`, a table 0259 created and this file does not
  //        preserve, and nothing else. On that table it adds three columns (`kind` with a constant
  //        default, plus the nullable `watch_id` and `expiry_snapshot`), makes `match_id` nullable, and
  //        adds a foreign key from `watch_id` to `watch`, two CHECKs and one partial unique index. It
  //        does not touch `task`, `project` or `project_acceptance_criterion_definition`, so the 0177
  //        pair, `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions. It creates
  //        no table, enum, type, function or trigger, so it is not another writer of the DONE fence.
  //        It has no `ALTER TYPE` and no `DROP TYPE`, so all three `task_completion_criterion` labels
  //        survive. It has no INSERT, UPDATE or DELETE: the default is a catalog-only change, so
  //        existing deliveries become MATCH rows without being written. Nothing reads a delivery to
  //        allow or refuse a status: a delivery records whether a session was told, and decides
  //        nothing about the task it watched.
  //   0262 adds one relation of its own, `background_job_wake`: the wakes a runner-hosted job sends
  //        its session, kept beside the turn that delivers them. Read against every claim above: it
  //        creates that table, its unique index, a CHECK on its own `trigger` column and a foreign
  //        key from it to `session`, which constrains the new rows and leaves `session` as it was. It
  //        does not touch `task`, `project` or `project_acceptance_criterion_definition`, so the 0177
  //        pair, `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it creates
  //        no enum, type, function or trigger, and carries no `ALTER TYPE` and no `DROP TYPE`, so all
  //        three `task_completion_criterion` labels survive. It has no INSERT, no row UPDATE and no
  //        DELETE — the key's `ON DELETE CASCADE` is a referential action on the new table's rows.
  //        Nothing reads a wake to allow or refuse a status: a wake is a turn's content, not a decision.
  //   0263 let a `watch_delivery` row carry a Watch's REVOKED or UNRESOLVABLE end as well, so that a
  //        session waiting on a watch that can no longer be decided or read is told, as contract §3
  //        requires. Read against every claim above: it ALTERs `watch_delivery`, a table 0259 created
  //        and this file does not preserve, and nothing else. On that table it drops 0261's two CHECKs
  //        and adds them back under the same names, each widened by the two new kinds, and it adds no
  //        column, index or foreign key. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions. It creates
  //        no table, enum, type, function or trigger, so it is not another writer of the DONE fence.
  //        It has no `ALTER TYPE` and no `DROP TYPE`, so all three `task_completion_criterion` labels
  //        survive. It has no INSERT, UPDATE or DELETE: adding a CHECK back reads the `watch_delivery`
  //        rows to validate them and writes none. Nothing reads a delivery to allow or refuse a status:
  //        a delivery records whether a session was told, and decides nothing about the task it watched.
  //   0264 adds one relation of its own, `session_scheduled_wakeup`: the wakeups a session asks the
  //        control plane to hold until they are due. Read against every claim above: it creates that
  //        table, a CHECK on its own `state` column, a foreign key from it to `session`, one partial
  //        unique index and one partial index, which constrain the new rows and leave `session` as it
  //        was. It does not touch `task`, `project` or `project_acceptance_criterion_definition`, so the
  //        0177 pair, `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it creates no
  //        enum, type, function or trigger, and carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive. It has no INSERT, no row UPDATE and no DELETE —
  //        the key's `ON DELETE CASCADE` is a referential action on the new table's rows. Nothing reads a
  //        wakeup to allow or refuse a status: a wakeup says when a turn is filed, not what is decided.
  //   0265 added account pools: the `provider_pool` and `provider_pool_member` tables, a unique index
  //        on `model_provider` ("id", "owner_id") for the member's composite foreign key, and one
  //        function, `provider_dispatch_slug_guard`, fired BEFORE INSERT OR UPDATE OF "slug" by one
  //        trigger on `model_provider` and one on `provider_pool`. Read against every claim above: its
  //        only `ALTER TABLE` statements add foreign keys to the two tables it creates, so `task`,
  //        `project` and `project_acceptance_criterion_definition` are untouched — the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions. The function
  //        and triggers it does create fire only on `model_provider` and `provider_pool` and read only
  //        those two, so neither is another writer of the DONE fence. It has no `ALTER TYPE` and no
  //        `DROP TYPE`, so all three `task_completion_criterion` labels survive, and no INSERT, UPDATE
  //        or DELETE: both tables start empty. It REFERENCES `user`("id") and
  //        `model_provider`("id", "owner_id"), which writes neither. Nothing reads a pool to allow or
  //        refuse a status: a pool names credentials a session may be dispatched with, and decides
  //        nothing about any task.
  //   0268 adds two nullable columns to `session`, `pool_member_provider_id` and `pool_switch_notice`:
  //        the account-pool member a session last ran on, and the transcript line owed for a move
  //        between members. Read against every claim above: its one statement is that
  //        `ALTER TABLE "session"`, with no default, index, CHECK or foreign key, so no stored row is
  //        rewritten or constrained. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it creates
  //        no table, enum, type, function or trigger, and carries no `ALTER TYPE` and no `DROP TYPE`,
  //        so all three `task_completion_criterion` labels survive. It has no INSERT, UPDATE or
  //        DELETE. Nothing reads either column to allow or refuse a status: they say which credential
  //        a session runs on, and decide nothing about any task.
  //   0266 resolved, once, the `COORDINATOR_NO_PROGRESS` blockers the retired coordinator breaker
  //        left open: nothing raises that kind any more, so no condition and no code could clear
  //        one. Read against every claim above: it is one `UPDATE "project_blocker"`, a relation
  //        this file does not preserve, which writes `resolved_at`, `resolved_by` and `updated_at`
  //        on the open rows of that one kind and nothing else. It does not touch `task`, `project`
  //        or `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, column, index, enum, type, function or trigger — so it is not another
  //        writer of the DONE fence — and carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive. It has no INSERT and no DELETE, and reads no
  //        other relation. Nothing reads these rows to allow or refuse a status: the project list's
  //        attention read counts an open blocker, which is what they stop lighting, and the
  //        convergence measurement already left this kind out.
  //   0269 let a project blocker be resolved with a reason: it ALTERs `project_blocker`, a relation
  //        this file does not preserve, adding the nullable `resolution_note` and
  //        `resolved_by_user_id`, and it restates
  //        `project_blocker_resolution_final` (0125) with those two columns among the ones a resolved
  //        row may not change. Read against every claim above: it does not touch `task`, `project`
  //        or `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions. The one
  //        function it replaces is a `project_blocker` trigger function that reads only its own row,
  //        so it is not another writer of the DONE fence; it creates no table, enum, type or trigger,
  //        carries no `ALTER TYPE` and no `DROP TYPE`, so all three `task_completion_criterion`
  //        labels survive, and it has no INSERT, UPDATE or DELETE: both columns start NULL on every
  //        existing row. Nothing reads them to allow or refuse a status: they say why a blocker
  //        ended and who ended it.
  //   0267 adds OWNER_CONFIRMED, the fourth completion criterion: the account owner's own decision,
  //        recorded from the app, is what settles it. Read against every claim above: it carries an
  //        `ALTER TYPE "task_completion_criterion" ADD VALUE`, which adds a fourth label and can
  //        remove none, so all three labels this file keeps survive beside it; there is no
  //        `DROP TYPE`. It creates one enum of its own (`task_owner_decision_value`) and two tables
  //        of its own, `task_owner_confirmation_request` and `task_owner_decision`, each with a
  //        composite foreign key to `task`("id", "owner_id") — being pointed at is not being
  //        written, so `task` is neither altered nor written — and indexes and CHECKs on the new
  //        tables only. There is no `ALTER TABLE` at all, so `project`,
  //        `project_acceptance_criterion_definition`, the 0177 pair, `task_executable_acceptance_pair`
  //        and every stored row are out of its reach, and no criterion's `text` or
  //        `verification_method` can move by one byte. It names no `project_acceptance_*` object.
  //        It IS a writer of the DONE fence, like 0230 and 0239: its one `CREATE OR REPLACE
  //        FUNCTION` is `task_done_canonical_writer_fence`, restating every lane 0228, 0230 and 0239
  //        wrote line for line and adding one — the owner's newest `task_owner_decision` is a
  //        CONFIRM — plus the HINT that names it; it touches none of the other five preserved
  //        triggers/functions and creates no trigger. It has no INSERT, no row UPDATE and no DELETE:
  //        both tables start empty. Like 0239's lane, the new one only READS a row — the owner's
  //        decision — to admit a DONE that decision derives; nothing reads a preserved row to allow
  //        or refuse a status.
  //   0270 records a code project's integration line on `project_codebase`, a table 0231 created and
  //        this file does not preserve: four columns (`integration_ref_source`,
  //        `integration_started_at`, `merge_check_command`, `merge_check_timeout_seconds`), two CHECKs
  //        on them, and the `project_codebase_integration_lock` function and BEFORE UPDATE row trigger
  //        that refuse moving a line work has already landed on. Read against every claim above: its
  //        only `ALTER TABLE` statements are on `project_codebase`, so no column of `task`, `project`
  //        or `project_acceptance_criterion_definition` is added, dropped or changed, the 0177 pair and
  //        `task_executable_acceptance_pair` are out of its reach, and no criterion's `text` or
  //        `verification_method` can move by one byte. The trigger it creates is on `project_codebase`,
  //        not on `task`, so it is not another writer of the DONE fence and cannot change which status
  //        a write lands; the function it creates reads only the OLD and NEW of the row being written.
  //        It names no `project_acceptance_*` object and none of the six preserved triggers/functions,
  //        creates no enum or type and carries no `ALTER TYPE` or `DROP TYPE`, so all four
  //        `task_completion_criterion` labels survive. It has no INSERT, no row UPDATE and no DELETE:
  //        the columns take constant defaults, which PostgreSQL stores without rewriting the heap, and
  //        the table is empty in production anyway. Nothing it adds is read to allow or refuse a status.
  //   0271 adds `task_progress` — a Task's structured progress and its lifecycle epoch — with the
  //        `task_progress_epoch_advance` function and an AFTER UPDATE OF "status" row trigger on `task`
  //        that calls it, and the columns and CHECKs a CONTINUOUS watch needs on `watch`. Read against
  //        every claim above: its only `ALTER TABLE` statements are on `watch`, a table 0259 created and
  //        this file does not preserve, so no column of `task`, `project` or
  //        `project_acceptance_criterion_definition` is added, dropped or changed, the 0177 pair and
  //        `task_executable_acceptance_pair` are out of its reach, and no criterion's `text` or
  //        `verification_method` can move by one byte. The trigger it puts on `task` runs after a status
  //        write has landed and writes only `task_progress`, never a `task` row, so it is not another
  //        writer of the DONE fence and cannot change which status a write lands; the new table's foreign
  //        key references `task`("id"), and being pointed at is not being written. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions, creates no
  //        enum or type, and carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive. Its INSERT and UPDATE live inside that trigger
  //        function's body, which runs only on a later reopen: applying the migration reads and writes no
  //        stored row. Nothing reads progress to allow or refuse a status: it is what a reporter states,
  //        and a Watch reads it to decide when to tell somebody, never whether a task is done.
  //   0272 dropped `project_action`, the control loop's dispatch ledger, by account-owner decision:
  //        the loop that wrote it went in 6418a1e5 and DEP's last read of it in 9135ae64. Read against
  //        every claim above: it drops that table with its two triggers, their two functions and its
  //        two enums, `project_action_type` and `project_action_status`. Those are its only
  //        `DROP TYPE`s and it has no `ALTER TYPE`, so the three `task_completion_criterion` labels
  //        this file keeps survive, with 0267's fourth beside them. It ALTERs `session`, a preserved
  //        relation, by exactly one `DROP COLUMN "project_action_id"`, and
  //        `task_verification_failure` by one `DROP COLUMN "raised_by_action_id"`: no other column of
  //        either is named, no row is rewritten, and the values that go were archived before the
  //        migration was written. It narrows `project_blocker_kind_chk` by the one kind only the
  //        deleted verdict-apply retry could raise, and names neither of 0269's `project_blocker`
  //        columns nor the `project_blocker_resolution_final` function 0269 restated. It does not
  //        touch `task`, `project` or `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored task and criterion row are out of its
  //        reach, and no criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it creates
  //        no table, enum, type, function or trigger, so it is not another writer of the DONE fence.
  //        It has no INSERT, UPDATE or DELETE: putting the CHECK back reads `project_blocker` to
  //        validate it and writes nothing. Nothing it removes was still read to allow or refuse a
  //        status when it ran.
  //   0273 withdrew the provisioning lifecycle behind "create a workspace from a repo URL", by
  //        account-owner decision: two `workspace` columns — `provision_state` and
  //        `provision_error` — and the enum `workspace_provision_state` that only the first ever
  //        used. Read against every claim above: `workspace` is not a relation this file preserves
  //        and is not reachable from one. It ALTERs that one table by exactly two `DROP COLUMN`s,
  //        and names no `task` object, neither 0177 relation, `task_executable_acceptance_pair`
  //        nor any `project_acceptance_*` object. Its single `DROP TYPE` is
  //        `workspace_provision_state`, checked against the production catalog as that one
  //        column's alone; it is not `task_completion_criterion`, and there is no `ALTER TYPE`, so
  //        the three labels this file keeps survive with 0267's fourth beside them. It creates no
  //        table, column, index, enum, function or trigger, and has no `CREATE OR REPLACE
  //        FUNCTION` at all, so it is not another writer of the DONE fence. It has no INSERT,
  //        UPDATE or DELETE, so no preserved row is read or written. Nothing is lost with the
  //        columns: every workspace reads `provision_state = 'READY'` and a NULL
  //        `provision_error`, because the path that could write anything else never ran once.
  //        `workspace.repo_url` is deliberately NOT dropped beside them —
  //        `projects/project-integration-line.ts` still reads it to bootstrap a project's
  //        codebase binding — so no reader loses its input here.
  //   0274 added `session.import_source_cwd`, the pending marker behind `orbit session import`:
  //        non-null marks a session whose runner must copy a local Claude transcript into the
  //        worktree and replay it as run events before the engine spawns, and import-result's
  //        CAS clears it. Read against every claim above: it ALTERs `session`, a preserved
  //        relation, by exactly one `ADD COLUMN "import_source_cwd"` — no other column of
  //        `session` is named, no column is dropped, and the new column is NULL-able so no
  //        stored row is rewritten (an added column is metadata, not a row change). It names no
  //        `task`, `project` or `project_acceptance_criterion_definition` object, so the 0177
  //        pair, `task_executable_acceptance_pair` and every stored task and criterion row are
  //        out of its reach, and no criterion's `text` or `verification_method` can move by one
  //        byte. It creates no table, enum, type, function or trigger, carries no `ALTER TYPE`
  //        and no `DROP TYPE`, so the three `task_completion_criterion` labels survive with
  //        0267's fourth beside them, and it is not another writer of the DONE fence. It has no
  //        INSERT, UPDATE or DELETE, so no preserved row is read or written.
  //   0275 added the storage behind importing a directory's existing Claude Code history: four
  //        `runner` columns (`claude_history_status`, `_path`, `_at`, `_result`) holding the
  //        one-slot request/answer relay the new-workspace form asks through, and
  //        `session.imported_at`, durable provenance for a session that arrived as an imported
  //        transcript. Read against every claim above: it ALTERs exactly two tables, `runner` —
  //        which is not a preserved relation and is not reachable from one — and `session`, a
  //        preserved relation, by exactly one `ADD COLUMN "imported_at"`. No other column of
  //        `session` is named, no column is dropped anywhere, and every added column is NULL-able,
  //        so no stored row is rewritten (an added column is metadata, not a row change). It names
  //        no `task`, `project` or `project_acceptance_criterion_definition` object, so the 0177
  //        pair, `task_executable_acceptance_pair` and every stored task and criterion row are out
  //        of its reach, and no criterion's `text` or `verification_method` can move by one byte.
  //        It creates no table, enum, type, function or trigger, carries no `ALTER TYPE` and no
  //        `DROP TYPE`, so the three `task_completion_criterion` labels survive with 0267's fourth
  //        beside them, and it is not another writer of the DONE fence. It has no INSERT, UPDATE
  //        or DELETE, so no preserved row is read or written.
  //   0276 added `task_list.pause_epoch` and `task_list.pause_applied_epoch` — two INTEGER NOT NULL
  //        DEFAULT 0 counters that split a list's pause decision from the projection of it onto the
  //        tasks — plus one index on `task`, `task_list_id_id_idx (list_id, id)`, which is what
  //        makes the projector's keyset page a range scan instead of a sort of the whole list.
  //        Read against every claim above: it ALTERs exactly one table, `task_list`, which is not a
  //        preserved relation and is not reachable from one, by exactly two `ADD COLUMN`s. No
  //        column is dropped anywhere. Both columns carry a DEFAULT, which makes the ADD
  //        catalog-only — PostgreSQL 11+ records the default in the catalog rather than rewriting
  //        the heap — so no stored row is rewritten and no existing list needs a backfill (the
  //        projection was already the same transaction as the pause, so every list starts
  //        applied = epoch = 0). The index is a second copy of two columns `task` already has; it
  //        reads every row of `task` once to build and changes none of them, is dropped by nothing,
  //        and names no `task`, `project` or `project_acceptance_criterion_definition` COLUMN beyond
  //        `list_id` and `id`. It creates no table, enum, type, function or trigger, carries no
  //        `ALTER TYPE` and no `DROP TYPE`, so the three `task_completion_criterion` labels survive
  //        with 0267's fourth beside them, and it is not another writer of the DONE fence. It has
  //        no INSERT, UPDATE or DELETE, so no preserved row is read or written.
  //   0277 dropped `run_event_session_id_seq_idx`, the plain index the RunEvent model declared
  //        beside its `@@unique([sessionId, seq])` on the same two columns in the same order: one
  //        `DROP INDEX`, nothing else. Read against every claim above: an index holds no data of
  //        its own, so no row of `run_event` — a preserved relation, and the one this file names
  //        by that name — is read, rewritten or lost; what is removed is a derived structure over
  //        columns that stay exactly as they are, and the unique index
  //        `run_event_session_id_seq_key` (the ingest path's `ON CONFLICT` arbiter) is untouched,
  //        so `session_id, seq` remains unique. It names no `task`, `project` or
  //        `project_acceptance_criterion_definition` object, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored task and criterion row are out of
  //        its reach, and no criterion's `text` or `verification_method` can move by one byte. It
  //        creates no table, column, enum, type, function or trigger, carries no `ALTER TYPE`,
  //        `DROP TYPE`, `INSERT`, `UPDATE` or `DELETE`, and has no `CREATE OR REPLACE FUNCTION`
  //        at all, so it is not another writer of the DONE fence. The production catalog was read
  //        before the drop: the index had never been scanned (`idx_scan = 0`) while its unique
  //        twin carried 13.7M.
  //   0278 added `project_open_item` and `project_open_item_delivery` — the exception items of the
  //        integration-line contract, and where each was queued — plus one constant-default column on
  //        `project`, `exception_escalation_seconds`. Read against every claim above: the two tables
  //        are its own, and the only preserved relations it names are `project` and `task`, which it
  //        reaches by ADDing that one column and by pointing two foreign keys at unique keys they
  //        already had. No column of either is dropped or rewritten, and a referential action is not
  //        a write. It carries no DML of any kind — no `INSERT INTO`, no `UPDATE ... SET`, no
  //        `DELETE FROM` — so no stored task, criterion or acceptance row can move by one byte, and
  //        the 0177 pair and the `task_completion_criterion` labels are out of its reach (it creates
  //        no type and alters none). Its one function and trigger, `project_open_item_terminal_guard`,
  //        is BEFORE UPDATE on its own new table and refuses rewrites of a resolved item: it writes
  //        nothing, names none of the six preserved triggers or functions, and is not a second writer
  //        of the DONE fence. Nothing it creates uses the `project_acceptance_` prefix or the word
  //        `judgment`.
  //   0279 added `project_criteria_decision.diff_snapshot`, the diff an answered criteria proposal
  //        was decided against, written in the same INSERT as the answer because an APPROVE
  //        overwrites the definitions it was taken from and nothing else keeps their words. Read
  //        against every claim above: it ALTERs exactly one table, `project_criteria_decision`,
  //        which is not a preserved relation and is not reachable from one, by exactly one
  //        `ADD COLUMN` — nullable, with no default, so the ADD is catalog-only and no stored row
  //        is rewritten. No column is dropped anywhere. The only other statement is a
  //        `COMMENT ON COLUMN` on that same new column, which is catalog prose and touches no row.
  //        It names no `task`, `project` or `project_acceptance_criterion_definition` object, so
  //        the 0177 pair, `task_executable_acceptance_pair` and every stored task and criterion row
  //        are out of its reach, and no criterion's `text` or `verification_method` can move by one
  //        byte — this column RECORDS what those said and is written by nobody who could change
  //        them. It creates no table, enum, type, function or trigger, carries no `ALTER TYPE` and
  //        no `DROP TYPE`, so the three `task_completion_criterion` labels survive with 0267's
  //        fourth beside them, and it is not another writer of the DONE fence. It has no INSERT,
  //        UPDATE or DELETE, so no preserved row is read or written, and no backfill is attempted:
  //        a decision recorded before this migration has no snapshot and never will.
  //   0280 added `task_list.task_count` and the three `task_list_task_count_sync` triggers that
  //        maintain it, so that `GET /task-lists` stops recounting the whole `task` table on every
  //        poll. Read against every claim above: it is the first later migration whose triggers sit
  //        ON `task`, so what they WRITE is the question — and all three write one column of
  //        `task_list` and nothing else; `task` is only read, through the INSERT/DELETE/UPDATE
  //        transition tables of the statement that fired them. No column of `task` is added,
  //        dropped or rewritten, so `task.acceptance_command`, `task.acceptance_expected_exit_code`
  //        and every stored task row survive untouched, and `task_executable_acceptance_pair` is
  //        not named. Its one DML statement is the backfill, which UPDATEs `task_list` — not a
  //        preserved relation, and not reachable from one — from a `count(*)` of `task`. It creates
  //        no type and carries no `ALTER TYPE`/`DROP TYPE`, so the `task_completion_criterion`
  //        labels stand with 0267's fourth. Its one `CREATE FUNCTION` is `task_list_task_count_sync`
  //        — a new name, created rather than replaced — so it is not another writer of the DONE
  //        fence, and it drops no trigger or function at all. Nothing it creates uses the
  //        `project_acceptance_` prefix or the word `judgment`.
  //   0281 added `project_integration_job` — one row per attempt the platform makes to put a branch
  //        onto a project's integration line — plus the foreign key 0278 left waiting on
  //        `project_open_item.integration_job_id`. Read against every claim above: the table is its
  //        own, and the only preserved relations it names are `project`, `project_codebase`, `task`
  //        and `session`, each reached by a foreign key pointed at a unique key they already had. A
  //        referential action is not a write, and the two it declares on preserved rows are
  //        `SET NULL` on its OWN columns (`task_id`, `session_id`), never on theirs. It carries no
  //        DML of any kind — no `INSERT INTO`, no `UPDATE ... SET`, no `DELETE FROM` — so no stored
  //        task, criterion or acceptance row moves by one byte, and it creates no type and alters
  //        none, so the 0177 pair and the `task_completion_criterion` labels are out of its reach.
  //        Its one function and trigger, `project_integration_job_terminal_guard`, is BEFORE UPDATE
  //        on its own new table and refuses rewrites of a finished job: it writes nothing, names none
  //        of the six preserved triggers or functions, and is not a second writer of the DONE fence.
  //        Nothing it creates uses the `project_acceptance_` prefix or the word `judgment`.
  //   0282 added `project_task_status_count` and the three `project_task_status_count_sync` triggers
  //        that maintain it, so that `GET /projects/:id` stops recounting one project's rows — the
  //        same shape as 0280, on the statement beside it. Read against every claim above: it is
  //        the second later migration whose triggers sit ON `task`, and like 0280's they write
  //        nothing on `task` — all three write rows of a table 0282 creates, and `task` is only
  //        READ, through the INSERT/DELETE/UPDATE transition tables of the statement that fired
  //        them. No column of `task` is added, dropped or rewritten, so `task.acceptance_command`,
  //        `task.acceptance_expected_exit_code` and every stored task row survive untouched, and
  //        `task_executable_acceptance_pair` is not named. Its DML is the backfill plus the
  //        trigger bodies: the backfill INSERTs into its own new table from a `count(*)` of `task`,
  //        and never UPDATEs or DELETEs a preserved relation. It creates no type and carries no
  //        `ALTER TYPE`/`DROP TYPE`, so the `task_completion_criterion` labels stand with 0267's
  //        fourth. Its one `CREATE FUNCTION` is `project_task_status_count_sync` — a new name,
  //        created rather than replaced — so it is not another writer of the DONE fence, and it
  //        drops no trigger or function at all. Nothing it creates uses the `project_acceptance_`
  //        prefix or the word `judgment`.
  //   0283 added `task_project_assignee_idx`, a partial btree on `(project_id, assignee_id)`, so
  //        that `busiestAssignee` stops scanning the whole Task heap to count one project's rows.
  //        Read against every claim above: its whole text is one `CREATE INDEX ... IF NOT EXISTS`,
  //        so it carries no DML of any kind — no `INSERT INTO`, no `UPDATE ... SET`, no `DELETE
  //        FROM`, no `TRUNCATE` — and no stored task, criterion or acceptance row moves by one byte.
  //        It does not drop or alter `task` or any other preserved relation (an index is a new
  //        relation of its own beside the table, not a rewrite of it), adds and drops no column, and
  //        creates no type and carries no `ALTER TYPE`/`DROP TYPE`, so `task.acceptance_command`,
  //        `task.acceptance_expected_exit_code`, `task_executable_acceptance_pair` and the
  //        `task_completion_criterion` labels are all out of its reach. It creates no function and
  //        no trigger and drops none, so it names none of the six preserved triggers or functions
  //        and is not a second writer of the DONE fence. Nothing it creates uses the
  //        `project_acceptance_` prefix or the word `judgment`.
  //   0284 added `project_fuse_episode` and `project_fuse_held_action` — a coordinator's spend fuse
  //        having blown, and what it held while it had — and gave `project_open_item.fuse_episode_id`
  //        the foreign key 0278 said would come with them. Read against every claim above: the two
  //        tables are its own, and the only preserved relation it touches is `project_open_item`,
  //        which it reaches by ADDing a constraint to a column that already exists and is NULL in
  //        every row ever written. It drops and retypes nothing, carries no DML of any kind, and
  //        creates no type — so no stored task, criterion or acceptance row can move by one byte, and
  //        the 0177 pair and the `task_completion_criterion` labels are out of its reach. Its one
  //        function and trigger, `project_fuse_episode_resumed_guard`, is BEFORE UPDATE on its own
  //        new table and refuses rewrites of a resumed episode: it writes nothing, names none of the
  //        six preserved triggers or functions, and is not a second writer of the DONE fence. Nothing
  //        it creates uses the `project_acceptance_` prefix or the word `judgment`.
  //   0285 rewrote one function body and nothing else: `task_dependency_tail_id`, which resolves a
  //        prerequisite through its supersession chain, now reads the head row once instead of
  //        twice and is labelled PARALLEL SAFE. It matters here because a CREATE OR REPLACE is how
  //        one migration silently reverts another, so: it is NOT a writer of the DONE fence or of
  //        any of the six preserved triggers/functions above — the only name it replaces is its
  //        own, which 0212 created and 0226 last rewrote. It carries no DDL besides that body, no
  //        DML of any kind, no DROP and no ALTER, so neither 0177 relation, no
  //        `task_completion_criterion` label, no task row and no `project_acceptance_*` object can
  //        move by one byte. Its return value is unchanged for every input, checked over all
  //        111,752 task ids, all 110,866 edge heads and 200 ids belonging to no task.
  //   0286 added `project_promotion` — one candidate for merging a project's finished work into its
  //        upstream, with what the owner confirmed and what it became — and gave
  //        `project_integration_job.promotion_id` and `project_open_item.promotion_id` the foreign
  //        keys 0281 and 0278 said would come with it. Read against every claim above: the table is
  //        its own, and the only preserved relations it touches are those two, each reached by ADDing
  //        a constraint to a column that already exists and is NULL in every row ever written. It
  //        drops and retypes nothing, carries no DML of any kind, and creates no type — so no stored
  //        task, criterion or acceptance row can move by one byte, and the 0177 pair and the
  //        `task_completion_criterion` labels are out of its reach. Its one function and trigger,
  //        `project_promotion_terminal_guard`, is BEFORE UPDATE on its own new table and refuses
  //        rewrites of a merged, declined, cancelled or superseded candidate: it writes nothing,
  //        names none of the six preserved triggers or functions, and is not a second writer of the
  //        DONE fence. Nothing it creates uses the `project_acceptance_` prefix or the word
  //        `judgment`.
  //   0287 added `task_list.task_done_count` and rewrote `task_list_task_count_sync` to maintain it
  //        in the same statement, so that `GET /task-lists` stops asking `task` for a second grouped
  //        count on every poll. Read against every claim above: it installs NO new trigger — the
  //        three that fire are 0280's, unchanged in name, table and event — and they write nothing
  //        on `task`; the one thing 0287 adds to what they write is a second column of `task_list`,
  //        which is not a preserved relation and not reachable from one. `task` is only READ,
  //        through the INSERT/DELETE/UPDATE transition tables of the statement that fired them. No
  //        column of `task` is added, dropped or rewritten, so `task.acceptance_command`,
  //        `task.acceptance_expected_exit_code` and every stored task row survive untouched, and
  //        `task_executable_acceptance_pair` is not named. Its DML is the backfill, which UPDATEs
  //        `task_list` from a `count(*)` of `task` filtered on `status = 'DONE'`, plus the bodies it
  //        installs: no INSERT INTO, UPDATE or DELETE on a preserved relation, and the `task` rows
  //        it counts are not rewritten by being counted. It creates no type and carries no
  //        `ALTER TYPE`/`DROP TYPE`, so the `task_completion_criterion` labels stand with 0267's
  //        fourth — it adds no label and the fence keeps its four lanes. Its `CREATE OR REPLACE
  //        FUNCTION` is the one statement here that could revert a later migration, so, on the
  //        question the 0285 paragraph states: the name it replaces is `task_list_task_count_sync`,
  //        which 0280 created and nothing else has ever rewritten, so no later body is reverted. It
  //        is not another writer of the DONE fence — it never assigns `task.status`, it only counts
  //        rows that already have it — and it names none of the six preserved triggers or functions
  //        and drops no trigger or function at all. Nothing it creates uses the `project_acceptance_`
  //        prefix or the word `judgment`.
  //   0288 added `session.running_bg_jobs`, the subset of `running_bg_shells` that is a
  //        runner-hosted job with an end (a `bg_run` of kind `job` or `watch`, never a `service`,
  //        which is a dev server or watcher the workspace deliberately left up). Read against every
  //        claim above: like 0253 and 0254 it is one `ALTER TABLE "session" ADD COLUMN ... NOT NULL
  //        DEFAULT ARRAY[]::text[]` and nothing else. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, index, enum, type, function or trigger — so it is not another writer
  //        of the DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. The default is a constant, so PG writes only
  //        `pg_attribute.attmissingval` and never rewrites the heap: there is no backfill here and
  //        none is owed. Nothing reads the new column to allow or refuse a status — the event
  //        ingestion transaction maintains it and the session payload counts it.
  //   0289 added `session.running_bg_job_activity`: for each job in `running_bg_jobs`, the instant
  //        its output last moved, so that a `bg_run` whose process is up but has produced nothing
  //        for ten minutes stops counting as work in flight while staying in `running_bg_shells`
  //        (it is still a process; it is just no longer moving). Read against every claim above:
  //        like 0288 and 0253/0254 it is one `ALTER TABLE "session" ADD COLUMN ... NOT NULL DEFAULT
  //        '{}'::jsonb` and nothing else. It does not touch `task`, `project` or
  //        `project_acceptance_criterion_definition`, so the 0177 pair,
  //        `task_executable_acceptance_pair` and every stored row are out of its reach, and no
  //        criterion's `text` or `verification_method` can move by one byte. It names no
  //        `project_acceptance_*` object and none of the six preserved triggers/functions; it
  //        creates no table, index, enum, type, function or trigger — so it is not another writer
  //        of the DONE fence — carries no `ALTER TYPE` and no `DROP TYPE`, so all three
  //        `task_completion_criterion` labels survive, and it has no INSERT/UPDATE/DELETE, so no
  //        preserved row is read or written. The default is a constant, so PG writes only
  //        `pg_attribute.attmissingval` and never rewrites the heap: there is no backfill here and
  //        none is owed. Nothing reads the new column to allow or refuse a status — the event
  //        ingestion transaction maintains it, and the session payload and the counts endpoint
  //        decide freshness against it when they read.
  //   0290 dropped `project_dispatch_authority_fanout` — the 0122 AFTER trigger on `project` that
  //        rewrote `dispatch_authority` on every task of a project whose `coordinator_enabled` had
  //        just flipped, in the caller's transaction. Read against every claim above: it is two
  //        `DROP`s, one trigger and one function, and it carries no DML at all — so no task row is
  //        read, locked or written by it, and the 0177 pair, `task_executable_acceptance_pair`,
  //        `task.completion_criterion`'s labels and every `project_acceptance_*` object are out of
  //        its reach. It names none of the six preserved triggers/functions and creates no function,
  //        so it is not another writer of the DONE fence. The column itself — `task.dispatch_authority`
  //        — is deliberately NOT dropped (that would discard 109,875 stored values and needs the
  //        account owner, as 0272 did); so are `task_dispatch_authority_derive` and the
  //        `task_dispatch_authority` enum, which keep stamping a task at birth. What the migration
  //        does carry is a closing gate: it RAISEs if any function in `public` other than the derive
  //        trigger still names the column, so the premise "nothing reads it" is enforced on the
  //        deployment rather than asserted here.
  //   0292 dropped `project.automation_policy` and `task_scope_revision.automation_policy`, the
  //        enum `project_automation_policy`, the check `task_scope_revision_policy_chk`, and
  //        rewrote the two objects that still read the column. Read against every claim above: it
  //        is the first later migration that ALTERs a preserved relation — `project` — so that has
  //        to be answered rather than waved at. It drops exactly one column from it, and that
  //        column is neither of the 0177 pair, nor `task_executable_acceptance_pair`, nor any
  //        `task_completion_criterion` label: no task row is read, locked or written, and `task`
  //        is not named by any statement here at all. The TYPE it drops is
  //        `project_automation_policy`, which is not the criterion enum — all of that type's labels
  //        and both of `task_completion_criterion`'s surviving lanes stand. It names none of the
  //        six preserved triggers/functions and none of the `project_acceptance_*` objects; its two
  //        `CREATE OR REPLACE FUNCTION`s are `project_completion_contract_snapshot` and
  //        `task_scope_revision_authority_guard`, neither of which any later migration has
  //        rewritten, so no later body is reverted. It DOES carry DML, which the 0291 paragraph
  //        could say it had none of: one `SELECT project_refresh_completion_contract(...)` over
  //        every row of `project_completion_contract`. That table is not preserved, and the write
  //        lands only on it — the function takes `project FOR NO KEY UPDATE` and reads its columns,
  //        so a preserved `project` row is locked but not written. The three
  //        `project_acceptance_*` tables are out of its reach entirely.
  //   0293 drops the NOT NULL from `project_promotion.source_sha`, so a candidate may be recorded
  //        before the platform has read the repository it is about — a MAIN-line project offers a
  //        task branch, and where that branch points is a fact only the runner that fetches it has
  //        (contract §3.4 M-F2, 0286's column widened rather than replaced). Read against every
  //        claim above: it is one `ALTER TABLE ... ALTER COLUMN ... DROP NOT NULL` on a table this
  //        migration's own predecessor created, and it is the ONLY statement it carries. No column
  //        is added, dropped, retyped or backfilled; `task`, `project` and
  //        `project_acceptance_criterion_definition` are not named by any statement here, so the
  //        0177 pair, `task_executable_acceptance_pair`, every `task_completion_criterion` label
  //        and every stored row are out of its reach — nothing is read, locked or written. It
  //        creates no type, function, trigger or index and drops none, so it is not another writer
  //        of the DONE fence, it names none of the six preserved triggers/functions and none of the
  //        `project_acceptance_*` objects, and it reverts no later body — 0286's
  //        `project_promotion_terminal_guard` standing exactly as it was, still refusing a rewrite
  //        of a candidate that reached a terminal state. Dropping NOT NULL widens what the table
  //        accepts and cannot make an existing value disagree with the column's type.
  //   0294 added `project_promotion.upstream_moved_by`, how far the upstream had moved when a
  //        confirmed promotion's landing found it had, as the runner counted it (contract §3.3
  //        M-T7, read back as §3.6's `recheck`). Read against every claim above: it ALTERs exactly
  //        one table, `project_promotion`, which 0286 created for the merge-into-main state machine
  //        and which is neither a preserved relation nor reachable from one, by exactly one
  //        `ADD COLUMN` — nullable, with no default, so the ADD is catalog-only and no stored row
  //        is rewritten. No column is dropped anywhere. The only other statement is a
  //        `COMMENT ON COLUMN` on that same new column, which is catalog prose and touches no row.
  //        It names no `task`, `project` or `project_acceptance_criterion_definition` object, so
  //        the 0177 pair, `task_executable_acceptance_pair` and every stored task and criterion row
  //        are out of its reach, and it creates no table, enum, type, function or trigger — the six
  //        preserved objects and `project_promotion_terminal_guard`, already standing from 0286,
  //        are untouched. It carries no INSERT, UPDATE or DELETE, so no preserved row is read,
  //        locked or backfilled, and it is not another writer of the DONE fence.
  assert.deepEqual(dirs.slice(dirs.indexOf(REMOVAL_DIR)),
    [REMOVAL_DIR, '0229_project_acceptance_judgment_removal',
      '0230_executable_exit_code_judgment', '0231_project_codebase_session_source',
      '0232_task_criterion_declaration',
      '0233_project_acceptance_criterion_wiring_removal',
      '0234_project_acceptance_evaluation_plan_lane_removal',
      '0236_executable_acceptance_budget',
      '0237_task_completion_criterion_explicit_declaration',
      '0238_task_evidence_decision',
      '0239_evidence_judgment_confirm_lane',
      '0240_runner_model_catalog_refresh_request',
      '0241_task_attachments',
      '0242_criterion_unlanded_wake',
      '0243_coordinator_wake_delivered',
      '0244_session_engine_phase',
      '0245_project_standard_set_confirmation',
      '0246_project_acceptance_landed_wake',
      '0249_project_criteria_decision',
      '0250_criteria_decision_pending_wake',
      '0251_project_criteria_authorship',
      '0252_approval_opening_turn',
      '0253_session_fast_mode',
      '0254_session_wait_anchors',
      '0255_codex_rate_limit_reset_operation',
      '0256_session_commit_result_message',
      '0258_approval_pre_opening_turn_abandoned',
      '0259_watch_persistence',
      '0260_watch_delivery_lease_expiry_idx',
      '0261_watch_expiry_delivery',
      '0262_background_job_wake',
      '0263_watch_revoked_unresolvable_delivery',
      '0264_session_scheduled_wakeup',
      '0265_provider_pool',
      '0266_coordinator_no_progress_retirement',
      '0267_task_owner_confirmation',
      '0268_session_pool_member',
      '0269_project_blocker_resolution_note',
      '0270_project_integration_line',
      '0271_watch_progress_continuous',
      '0272_drop_project_action',
      '0273_drop_workspace_clone_provisioning',
      '0274_session_import_source',
      '0275_claude_history_import',
      '0276_task_list_pause_epoch',
      '0277_drop_run_event_duplicate_index',
      '0278_project_open_item',
      '0279_criteria_decision_diff_snapshot',
      '0280_task_list_task_count',
      '0281_project_integration_job',
      '0282_project_task_status_count',
      '0283_task_project_assignee_idx',
      '0284_project_fuse_pause',
      '0285_task_dependency_tail_id_single_read',
      '0286_project_promotion',
      '0287_task_list_done_count',
      '0288_session_running_bg_jobs',
      '0289_session_running_bg_job_activity',
      '0290_retire_dispatch_authority_fanout',
      // `approval.background_job_id`: one nullable column, no function, no trigger, and nothing it
      // touches is one of the six preserved objects — the row it lives on was never in the
      // judgment tables this file guards.
      '0291_approval_background_job',
      // `project.automation_policy` and `task_scope_revision.automation_policy`, the enum
      // `project_automation_policy`, and the check `task_scope_revision_policy_chk` all go; the
      // two live readers are rewritten (`project_completion_contract_snapshot` loses one key from
      // each of risk_material and risk_boundary; `task_scope_revision_authority_guard` loses the
      // arm that let `policy = 'AUTO'` widen a COORDINATOR to a scope revision). The first of
      // those moves two stored digests, so the migration recomputes every completion contract at
      // the end with reason AUTOMATION_POLICY_REMOVED — the one statement in it that writes
      // anything, and it writes only `project_completion_contract`. `zz_project_completion_
      // contract_project` is rebuilt without the column in its `UPDATE OF` list, which it has to
      // be: PostgreSQL refuses the `DROP COLUMN` with 2BP01 while that list still names it.
      '0292_drop_project_automation_policy',
      // `project_promotion.source_sha` loses NOT NULL and nothing else moves: no column is added,
      // dropped or retyped, no relation this file preserves is named, there is no trigger and no
      // function, and the migration carries no DML.
      '0293_project_promotion_source_sha_nullable',
      // `project_promotion.upstream_moved_by`: one nullable column, no function, no trigger, and
      // `project_promotion` was never in the judgment tables this file guards — 0286 created it.
      '0294_project_promotion_upstream_moved_by',
      // `task_owner_confirmation_claim`, one new table, plus one nullable column on
      // `task_owner_confirmation_request` (`claim_id`) with its composite foreign key and its
      // unique index, three indexes and two `COMMENT ON`s. Read against every claim above: it is
      // pure ADDITION and purely catalog-shaped — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF
      // NOT EXISTS`, one `DO` block that adds a constraint through an `EXCEPTION WHEN
      // duplicate_object` guard, four `CREATE … INDEX IF NOT EXISTS` — and it carries no
      // `CREATE OR REPLACE FUNCTION` at all, so it is not another writer of the DONE fence. It
      // names none of the six preserved triggers/functions, neither 0177 relation and no
      // `project_acceptance_*` object, and it adds, drops or retypes no column of `task`: the only
      // place `task` appears is the composite foreign key from the new table's own columns, which
      // references rows rather than changing them. It has no INSERT, UPDATE or DELETE, so no
      // preserved row is read, locked or backfilled — the new table is empty and nothing in it is
      // derived from what this file guards. `task_owner_confirmation_request`, the table it
      // ALTERs, was created by 0267 and is not one of the preserved relations.
      '0295_task_owner_confirmation_claim',
      // `runner.login_account` and `runner.login_account_name`: two nullable TEXT columns, no
      // default, on `runner`, the machine row the sign-in relay's state already lives on. Read
      // against every claim above: two `ADD COLUMN` statements and nothing else — no function,
      // trigger, type, index or constraint is created or dropped, so it is not another writer of
      // the DONE fence and names none of the six preserved objects; `runner` is not a preserved
      // relation, and no `task`, `project` or `project_acceptance_*` object is named, so the 0177
      // pair and every stored task and criterion row are out of its reach. No INSERT, UPDATE or
      // DELETE: no stored row is read, locked, backfilled or rewritten.
      '0296_runner_login_account',
      // `workspace.codex_account`: one nullable TEXT column, no default, on `workspace`, the row
      // the workspace's other dispatch settings (`env`, `work_dir`) already live on. Read against
      // every claim above: one `ADD COLUMN` statement and nothing else — no function, trigger,
      // type, index or constraint is created or dropped, so it is not another writer of the DONE
      // fence and names none of the six preserved objects; `workspace` is not a preserved
      // relation, and no `task`, `session`, `project` or `project_acceptance_*` object is named,
      // so the 0177 pair and every stored task and criterion row are out of its reach. No INSERT,
      // UPDATE or DELETE: no stored row is read, locked, backfilled or rewritten.
      '0297_workspace_codex_account',
      // `task.dispatch_refusal` and one more accepted spelling of `project_coordinator_wake.event`.
      // Read against every claim above: one nullable JSONB column added to `task` with no default,
      // no NOT NULL and no constraint — so, like 0236, it ALTERs the table the 0177 pair lives on
      // and reaches no stored row: every existing task reads NULL, nothing is backfilled, and
      // `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named. The other
      // statement restates `project_coordinator_wake_event_chk` in full, as 0250 did, with
      // TASK_DISPATCH_REFUSED added and every retired spelling kept. No function, trigger, type or
      // index is created or dropped — no `CREATE OR REPLACE FUNCTION`, so it is not another writer
      // of the DONE fence and names none of the six preserved objects — and it has no INSERT,
      // UPDATE or DELETE.
      '0298_task_dispatch_refusal',
      // 0250 again, statement for statement: `project_coordinator_wake`'s event CHECK, as 0298 left
      // it, restated with one more spelling — `DEPENDENT_READY`, a task a landing made startable
      // that will not start by itself. Read against every claim above: one `ALTER TABLE
      // "project_coordinator_wake" DROP CONSTRAINT / ADD CONSTRAINT` over a table this file does not
      // preserve and cannot reach one from; the event names a task but the string appears only
      // inside the CHECK's list of permitted values, so no `task` row, neither 0177 relation,
      // `task_executable_acceptance_pair` and no `project_acceptance_*` object is read, written or
      // constrained. It creates no table, column, index, enum, type, function or trigger — so it is
      // not another writer of the DONE fence and names none of the six preserved objects — carries
      // no `ALTER TYPE` and no `DROP TYPE`, and has no INSERT, UPDATE or DELETE. The set only grows,
      // so no stored event is refused by it and it needs no backfill.
      '0299_dependent_ready_wake',
      // 0281's state CHECK again, statement for statement, with one more spelling —
      // `NOTHING_TO_LAND`, the line answering that the branch it was handed carried nothing of the
      // task's own (contract §2.4 J-S3). Read against every claim above: one `ALTER TABLE
      // "project_integration_job" DROP CONSTRAINT / ADD CONSTRAINT` over a table this file does not
      // preserve and cannot reach one from; the state names a task in its own column, but the string
      // appears only inside the CHECK's list of permitted values, so no `task` row, neither 0177
      // relation, `task_executable_acceptance_pair` and no `project_acceptance_*` object is read,
      // written or constrained. It creates no table, column, index, enum, type, function or trigger
      // — so it is not another writer of the DONE fence and names none of the six preserved objects
      // — carries no `ALTER TYPE` and no `DROP TYPE`, and has no INSERT, UPDATE or DELETE. The set
      // only grows, so no stored state is refused by it and it needs no backfill.
      '0300_integration_job_nothing_to_land',
      // `project_promotion.confirmed_automatically` and `project_integration_job.
      // confirmed_automatically`: two BOOLEAN NOT NULL DEFAULT false columns (a constant default,
      // so catalog-only — no row is rewritten), `project_promotion_confirmed_by_chk` dropped and
      // re-added with one more OR arm, two new CHECKs, two `COMMENT ON`s. Read against every claim
      // above: no function, trigger, type or index is created, replaced or dropped, so it is not
      // another writer of the DONE fence and names none of the six preserved objects; both tables
      // it ALTERs were created by 0281 and 0286 and neither is a preserved relation, and no `task`,
      // `session`, `project`, `session_merge_receipt` or `project_acceptance_*` object is named, so
      // the 0177 pair and every stored task and criterion row are out of its reach. No INSERT,
      // UPDATE or DELETE: no stored row is read beyond the scans that validate the CHECKs, and
      // none is locked for longer, backfilled or rewritten.
      '0301_project_promotion_automatic_merge',
      // `runner.codex_account_remove_account`, `_status`, `_message` and `_at`: four nullable
      // columns (one TEXT pair, one TEXT, one TIMESTAMP(3)) with no default and no NOT NULL, added
      // to the removal relay — the request that takes a Codex account slot away from a machine,
      // beside the sign-in relay's own columns (0296). Read against every claim above: four
      // `ADD COLUMN`s and nothing else — no function, trigger, type, index or constraint is created
      // or dropped, so it is not another writer of the DONE fence and names none of the six
      // preserved objects; `runner` is not a preserved relation, and no `task`, `session`,
      // `project` or `project_acceptance_*` object is named, so the 0177 pair and every stored task
      // and criterion row are out of its reach. No INSERT, UPDATE or DELETE: no stored row is read,
      // locked, backfilled or rewritten.
      '0302_runner_codex_account_remove',
      // The second accepted spelling of `project_coordinator_wake.event`, and the producer of the
      // fact about it. Read against every claim above: one statement, `ALTER TABLE
      // project_coordinator_wake DROP CONSTRAINT … ADD CONSTRAINT … CHECK`, so — like 0250, 0298 and
      // 0299 — it names a table none of the six preserved triggers and functions lives on and
      // reaches no stored row: an event this CHECK did not previously accept has never been written,
      // so nothing is backfilled and nothing already stored can be refused. No function, trigger,
      // type, index or enum is created, altered or dropped — no `CREATE OR REPLACE FUNCTION`, so it
      // is not another writer of the DONE fence and names none of the six preserved objects — and it
      // has no INSERT, UPDATE or DELETE. The `project_acceptance_*` tables are not named, and
      // neither is the 0177 pair.
      '0303_project_settled_unmerged',
      // `task.priority`: one INTEGER NOT NULL DEFAULT 0 column (a constant default, so catalog-only —
      // no row is rewritten) and one partial index over it, `task_list_priority_idx` on
      // (list_id, priority) WHERE priority > 0 AND status = 'OPEN' — `ADD COLUMN IF NOT EXISTS` and
      // `CREATE INDEX IF NOT EXISTS`, so a deployment may run both by hand first. Read against every
      // claim above: like 0236 and 0298 it ALTERs the table the 0177 pair lives on and reaches no
      // stored row — every existing task reads 0, nothing is backfilled, and
      // `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named. The index
      // holds no data of its own and its build reads rows without changing any. No function,
      // trigger, type or constraint is created, altered or dropped — no `CREATE OR REPLACE
      // FUNCTION`, so it is not another writer of the DONE fence and names none of the six
      // preserved objects — and it has no INSERT, UPDATE or DELETE. No `project_acceptance_*`
      // object is named.
      '0304_task_priority',
      // `task_creator_session_idx`: one btree index on `task.creator_session_id`, a column that
      // already existed. Read against every claim above: one `CREATE INDEX IF NOT EXISTS` and
      // nothing else — no function, trigger, type, column or constraint is created, altered or
      // dropped, so it is not another writer of the DONE fence and names none of the six preserved
      // objects. `task` is named only as the table the index is built on: no column of it is
      // added, dropped or retyped, `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named, and no
      // `project_acceptance_*` object is. No INSERT, UPDATE or DELETE: the build reads every task
      // row once and writes none.
      '0305_task_creator_session_idx',
      // `share_link`: one new table (a public link = one root + its layers), four CHECKs, four
      // foreign keys, five indexes and one backfill. Read against every claim above: no function,
      // trigger, type or enum is created, replaced or dropped — no `CREATE OR REPLACE FUNCTION` —
      // so it is not another writer of the DONE fence and names none of the six preserved objects;
      // its `DO` blocks only wrap `ALTER TABLE "share_link" ADD CONSTRAINT` in a duplicate guard,
      // and `share_link` is the only table any statement alters. `task`, `project`, `session` and
      // `user` are named only as the tables the foreign keys reference (ON DELETE CASCADE, so a
      // root's deletion takes its links — no preserved row is changed by a link), and `session` as
      // the table the backfill reads: like 0239's fence body, reading a preserved relation is not
      // among what this file forbids. The one INSERT writes `share_link` alone — one row per session
      // holding a `share_token`, with that token unchanged — and `session.share_token` and
      // `session.shared_at` are left exactly as they were; no UPDATE and no DELETE anywhere. The 0177
      // pair, `task_executable_acceptance_pair`, `task_completion_criterion` and every
      // `project_acceptance_*` object are not named.
      '0306_share_link',
      // Orbit Wiki: nine new `wiki_*` tables with their CHECKs, foreign keys and indexes, two new
      // functions and one new index outside them. Read against every claim above: its two
      // `CREATE OR REPLACE FUNCTION`s are `wiki_anchors_valid` and `wiki_entry_search_text`, the
      // wiki's own and created here for the first time (a CHECK's helper and a search index's
      // expression), so it is not another writer of the DONE fence and names none of the six
      // preserved objects; no trigger, type or enum is created, replaced or dropped. The index is
      // `workspace_id_owner_id_key` on `workspace` (id, owner_id) — the key a binding's composite
      // foreign key names; `id` alone is already unique, so it adds no column and refuses no stored
      // row. `user` and `workspace` are otherwise named only as the tables foreign keys reference,
      // and no `task`, `session`, `project` or `project_acceptance_*` object is named at all: the
      // wiki's history ids (session, tool call, author, source ref) are deliberately not foreign
      // keys. No INSERT, UPDATE or DELETE: no stored row is read, locked, backfilled or rewritten.
      '0307_wiki',
      // `workspace.enable_orchestration` dropped: session orchestration is one switch per account
      // now, kept in `user.preferences`, so the per-workspace grant has no reader left. Read
      // against every claim above: one `ALTER TABLE "workspace" DROP COLUMN` and nothing else — no
      // function, trigger, type, index or constraint is created, replaced or dropped, so it is not
      // another writer of the DONE fence and names none of the six preserved objects; `workspace`
      // is not a preserved relation, and no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and
      // criterion row are out of its reach. No INSERT, UPDATE or DELETE: the dropped column held
      // nothing any preserved row refers to.
      '0308_orchestration_account_switch',
      //   0309 landed the Claude account a workspace's sessions run on: one
      //        `ALTER TABLE "workspace" ADD COLUMN` and nothing else. It names no preserved object,
      //        creates no function or trigger, and holds DML of no kind.
      //   0310 tagged the account removal a runner is handed with the engine whose store it is in:
      //        one `ALTER TABLE "runner" ADD COLUMN` and nothing else, on the same terms.
      '0309_workspace_claude_account',
      '0310_runner_account_remove_engine',
      // Orbit Wiki review modes: `wiki_entry_trust_chk` dropped and re-added with two more values
      // (`auto`, `unreviewed`), and two columns on `wiki_changeset_op` (`applied_by_mode`, a nullable
      // TEXT, and `spot_check`, a BOOLEAN NOT NULL DEFAULT false — constant defaults, so catalog-only)
      // with three CHECKs over them. Read against every claim above: only the two wiki tables are
      // named, and neither is a preserved relation; no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion
      // row are out of its reach. No function, trigger, type or index is created, replaced or dropped
      // — no `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names
      // none of the six preserved objects. No INSERT, UPDATE or DELETE: every stored entry and op
      // already satisfies the widened and the new CHECKs, so none is read or rewritten.
      '0311_wiki_review_modes',
      // Orbit Wiki verification (Automatic verifies before it applies): `wiki_changeset_op`'s decision
      // and decided CHECKs dropped and re-added, each widened by the one value `verifying`; five
      // nullable columns with no default (the verdict's trail — catalog-only) and four new CHECKs over
      // them; one partial index over the ops that wait for a verdict. Read against every claim above:
      // only `wiki_changeset_op` is named, which is not a preserved relation, and no `task`,
      // `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair and every
      // stored task and criterion row are out of its reach. No function, trigger or type is created,
      // replaced or dropped — no `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE
      // fence and names none of the six preserved objects. No INSERT, UPDATE or DELETE: no stored op is
      // verifying or carries a verdict, so every row satisfies every new CHECK as it stands.
      '0312_wiki_verification',
      // The wiki's search text priced for the planner: one `ALTER FUNCTION "wiki_entry_search_text"
      // ... COST 10000` and nothing else. Read against every claim above: the function is the wiki's
      // own (0307 created it) and its body, arguments and volatility are left as they are — there is
      // no `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none
      // of the six preserved objects. No table, column, constraint, index, trigger or type is created,
      // altered or dropped, and no `task`, `session`, `project` or `project_acceptance_*` object is
      // named. No INSERT, UPDATE or DELETE: no row is read, locked or rewritten.
      '0313_wiki_search_text_cost',
      // Orbit Wiki verification evidence (a verdict has to be able to read its sources): two columns
      // on `wiki_changeset_op` — one nullable with no default, one NOT NULL with a constant default
      // ('[]'), both catalog-only — and two CHECKs over them. Read against every claim above: only
      // `wiki_changeset_op` is named, which is not a preserved relation, and no `task`, `session`,
      // `project` or `project_acceptance_*` object is named. No function, trigger or type is created,
      // replaced or dropped — no `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE
      // fence. No INSERT, UPDATE or DELETE: every stored op has no evidence mark and an empty history,
      // so every row satisfies both CHECKs as it stands.
      '0314_wiki_verification_evidence',
      // The Wiki maintenance run's cursor and what it keeps of a dossier: two new tables,
      // `wiki_cursor` and `wiki_dossier`, each reaching `wiki_space` through (space_id, owner_id) and
      // carrying its own CHECKs, with a unique index each; and `task_list` gains one BOOLEAN NOT NULL
      // DEFAULT false column, `hidden` (a constant default, so catalog-only). Read against every claim
      // above: `task_list` is not a preserved relation, and no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion
      // row are out of its reach. No function, trigger or type is created, replaced or dropped — no
      // `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of
      // the six preserved objects. No INSERT, UPDATE or DELETE: every existing list reads false, and
      // nothing is backfilled.
      '0315_wiki_cursor',
      // Orbit Wiki import's notes: one new table, `wiki_note` (the redacted text of an imported file
      // and its hash), reaching `wiki_space` through (space_id, owner_id) with its own CHECKs, and one
      // unique index over it. Read against every claim above: no existing table is named but
      // `wiki_space`, as the parent its foreign key references, and no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion
      // row are out of its reach. No function, trigger or type is created, replaced or dropped — no
      // `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of
      // the six preserved objects. No INSERT, UPDATE or DELETE: the table starts empty.
      '0316_wiki_note',
      // The wiki's articles: `wiki_topic` gains one nullable TEXT column, `category`, with its CHECK
      // (catalog-only, and every existing row satisfies it), and a unique index over (id, owner_id)
      // that its primary key already makes unique; and one new table, `wiki_topic_summary`, reaching
      // `wiki_topic` through (topic_id, owner_id) and itself through (parent_id, owner_id), with its
      // own CHECKs and two indexes. Read against every claim above: no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion row
      // are out of its reach. No function, trigger or type is created, replaced or dropped — no
      // `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of the
      // six preserved objects. No INSERT, UPDATE or DELETE: nothing is read, locked or backfilled.
      '0317_wiki_topic_articles',
      // The wiki's maintenance job: one new table, `wiki_maintenance_run` (a maintenance task the
      // trigger made, the cursor position its check expects, and what its run reported), reaching
      // `wiki_space` through (space_id, owner_id) with its own CHECKs, a unique index and two plain
      // ones; its task_id and session_id are history references with no foreign key. And
      // `wiki_cursor` gains two nullable columns with no default (catalog-only) and one CHECK that
      // every row satisfies as it stands. Read against every claim above: no `task`, `session`,
      // `project` or `project_acceptance_*` object is named, so the 0177 pair and every stored task
      // and criterion row are out of its reach. No function, trigger or type is created, replaced or
      // dropped — no `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and
      // names none of the six preserved objects. No INSERT, UPDATE or DELETE: the table starts empty.
      '0320_wiki_maintenance_run',
      // Shared Codex pools: four `ADD COLUMN`s on `provider_pool` (constant defaults, so catalog-only)
      // and one CHECK over two of them, which every stored pool — `claude`, not shared — satisfies; one
      // nullable `ADD COLUMN` on `session` (`pool_key_id`, no default, no index, no CHECK, no foreign
      // key, so no stored session row is rewritten or constrained); and four new tables —
      // `provider_pool_person`, `pool_api_key`, `pool_gateway_token`, `pool_usage` — with their CHECKs,
      // indexes and foreign keys, which constrain only their own new rows. Read against every claim
      // above: `task`, `project` and `project_acceptance_criterion_definition` are not named, so the 0177
      // pair and every stored task and criterion row are out of its reach; `session` and `user` are
      // named otherwise only as the tables foreign keys reference, and the keys' `ON DELETE CASCADE` is a
      // referential action on the new tables' rows. It names no `project_acceptance_*` object and none
      // of the six preserved triggers/functions, creates no function, trigger, enum or type — so it is
      // not another writer of the DONE fence — and carries no `ALTER TYPE` and no `DROP TYPE`. No
      // INSERT, UPDATE or DELETE: every new table starts empty and nothing is backfilled. Written as
      // 0320_shared_provider_pool on the pool project's line and renumbered 0321 before it reached main,
      // whose 0320_wiki_maintenance_run had taken the number; it was never deployed under the old name.
      '0321_shared_provider_pool',
      // When a shared pool's key is out of budget: one nullable `ADD COLUMN` on `pool_api_key`
      // (`spent_until`, no default, no index, no CHECK), a table 0321 created, so no stored row is
      // rewritten or constrained. Read against every claim above: no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion row
      // are out of its reach. No function, trigger or type is created, replaced or dropped — no
      // `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of the
      // six preserved objects. No INSERT, UPDATE or DELETE: every key reads NULL, and nothing is
      // backfilled.
      '0322_pool_key_spent_until',
      // A pool of one person's own that runs on their ChatGPT login, held by this server (0323): one
      // `DROP CONSTRAINT` and one `ADD CONSTRAINT` of `provider_pool_engine_check`, whose new form admits
      // `codex` to a pool that is not shared — every stored pool is a 0265 personal Claude one or a 0321
      // shared Codex one, and each still satisfies it, so no row is rewritten or refused — and one new
      // table, `pool_codex_login`, with its primary key, its two CHECKs and its composite foreign key
      // (pool_id, user_id) → provider_pool(id, owner_id). Read against every claim above: no `task`,
      // `session`, `project` or `project_acceptance_*` object is named — `provider_pool` is, as the table
      // the CHECK is replaced on and the parent the new foreign key references, and neither is a preserved
      // relation. No function, trigger, type or enum is created, replaced or dropped — no `CREATE OR
      // REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of the six
      // preserved objects — and no `ALTER TYPE` or `DROP TYPE`. No INSERT, UPDATE or DELETE: the new table
      // starts empty and nothing is backfilled.
      '0323_pool_codex_login',
      // The gateway of a login pool (0324): three nullable `ADD COLUMN`s with no default on
      // `pool_codex_login` (catalog-only); one nullable `ADD COLUMN` on `session` (`pool_codex_account_id`,
      // no default, no index, no CHECK, no foreign key — 0321's `pool_key_id` exactly — so no stored
      // session row is rewritten or constrained); and two new tables, `pool_login_token` and
      // `pool_login_usage`, with their indexes and foreign keys, which constrain only their own new rows.
      // Read against every claim above: `task`, `project` and `project_acceptance_criterion_definition`
      // are not named, so the 0177 pair and every stored task and criterion row are out of its reach;
      // `session` is named otherwise only as the table two foreign keys reference, and their `ON DELETE
      // CASCADE` is a referential action on the new tables' rows. It names no `project_acceptance_*`
      // object and none of the six preserved triggers/functions, creates no function, trigger, enum or
      // type — so it is not another writer of the DONE fence — and carries no `ALTER TYPE` and no `DROP
      // TYPE`. No INSERT, UPDATE or DELETE: both new tables start empty and nothing is backfilled.
      '0324_pool_login_gateway',
      // The wiki's plan: four new tables — `wiki_plan` (a version of a space's plan), `wiki_plan_doc`,
      // `wiki_plan_section` and `wiki_plan_proposal` — the first and the last reaching `wiki_space`
      // through (space_id, owner_id), a document its version and a section its document the same way,
      // each with its own CHECKs, unique indexes (two of them partial) and one plain index. Read against
      // every claim above: no `task`, `session`, `project` or `project_acceptance_*` object is named, so
      // the 0177 pair and every stored task and criterion row are out of its reach. No function, trigger
      // or type is created, replaced or dropped — no `CREATE OR REPLACE FUNCTION`, so it is not another
      // writer of the DONE fence and names none of the six preserved objects. No INSERT, UPDATE or
      // DELETE: every new table starts empty.
      '0325_wiki_plan',
      // The wiki's documents: four new tables — `wiki_doc` (a document of a space, by its plan slug),
      // `wiki_doc_section`, `wiki_doc_sentence` and `wiki_doc_footnote` — the first reaching `wiki_space`
      // through (space_id, owner_id), a section its document, a sentence its section and a footnote its
      // sentence the same way, each with its own CHECKs and unique indexes, and one partial index on a
      // footnote's via entry. Read against every claim above: no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion row
      // are out of its reach. No function, trigger or type is created, replaced or dropped — no `CREATE OR
      // REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of the six
      // preserved objects. No INSERT, UPDATE or DELETE: every new table starts empty.
      '0326_wiki_docs',
      //   0329 dropped the rest of the machinery 0290 left standing: the column
      //        `task.dispatch_authority`, its enum and 0122's `task_dispatch_authority_derive`, which
      //        stamped it at birth. It is the first migration in this list that drops a column of
      //        `task` — `ALTER TABLE "task" DROP COLUMN IF EXISTS "dispatch_authority"`; 0298 and
      //        0304 each added one — so read it against the claims above rather than past them. The
      //        column it removes is none of the data kept here: not `acceptance_command`, not
      //        `acceptance_expected_exit_code`, not `completion_criterion`, which leaves the 0177
      //        pair, `task_executable_acceptance_pair` and all three `task_completion_criterion`
      //        labels exactly where they were. `DROP TYPE "task_dispatch_authority"` drops the
      //        column's own enum, not the `task_completion_criterion` type it shares a prefix with —
      //        that one keeps all three labels — and nothing here is dropped by pattern: each object
      //        is named exactly, as 0272 named the six it removed. The trigger and function it drops
      //        write `dispatch_authority` and nothing else, so they are not writers of the DONE
      //        fence, and no `project_acceptance_*` object or preserved trigger/function is named. It
      //        carries no INSERT, UPDATE, DELETE or ALTER TYPE: dropping a column is catalog-only —
      //        PostgreSQL marks the attribute dropped and reclaims the dead values at vacuum — so no
      //        task row is read, locked or rewritten, and no backfill is owed. Its closing gate
      //        re-asserts on the deployment that no function in `public` still names the column and
      //        that `task` carries none, the way 0290's gate did. The 111,774 stored values were
      //        archived off the git tree before this file was written
      //        (`/root/orbit/data/archive/task_dispatch_authority-2026-09-19/`, restorability
      //        verified against the source fingerprint), and the drop is the account owner's decision
      //        on task 34RNERPaIu0ZzyhbQuOJ0, as 0272's was. Written as
      //        0291_drop_task_dispatch_authority on that task's branch and renumbered 0329 before it
      //        reached this line, whose 0291 is `approval_background_job` (0326–0328 were already
      //        claimed by branches not yet landed); it was never deployed under the old name.
      '0329_drop_task_dispatch_authority',
      // The Codex account one session was started on (0330): one nullable `ADD COLUMN` on `session`
      // (`codex_account`, TEXT, no default, no index, no CHECK, no foreign key — 0324's
      // `pool_codex_account_id` exactly — so the ALTER is catalog-only and no stored session row is
      // rewritten or constrained) and nothing else. Read against every claim above: `task`, `project`
      // and `project_acceptance_criterion_definition` are not named, so the 0177 pair and every stored
      // task and criterion row are out of its reach. It names no `project_acceptance_*` object and none
      // of the six preserved triggers/functions, and creates no function, trigger, enum or type — so it
      // is not another writer of the DONE fence. No INSERT, UPDATE or DELETE: nothing is backfilled.
      '0330_session_codex_account',
      // A project's start as a fact of its own (0331): one nullable `ADD COLUMN` with no default on
      // `project` (`started_at`, catalog-only), one nullable `ADD COLUMN` with no default on
      // `project_standard_set_confirmation` (`started_with`) with one CHECK every stored row satisfies
      // as it reads NULL, and one UPDATE that backfills `started_at` — and writes nothing else — on the
      // projects that were already started. Read against every claim above: `project` is named, as
      // the table the column is added to and the one the UPDATE writes, and only that new column is
      // assigned; no trigger on `project` fires on it, and none is created. `task` and `session` are
      // named only as the tables that UPDATE reads, and `project_standard_set_confirmation` is not a
      // preserved relation. It names no `project_acceptance_*` object and none of the six preserved
      // triggers/functions, creates or replaces no function, trigger, enum or type — so it is not
      // another writer of the DONE fence — and carries no `ALTER TYPE` and no `DROP`. No INSERT or
      // DELETE, and no task, criterion or confirmation row is rewritten.
      '0331_project_started_at',
      // A coordinator's request to start its project (0333): `project_open_item_kind_chk` and
      // `project_open_item_owner_only_chk` are dropped and added back admitting `START_REQUEST`, which
      // every stored item satisfies — none holds the new kind — so no row is rewritten or refused.
      // Read against every claim above: `project_open_item` is the only relation named, and it is not
      // a preserved one; no `task`, `session`, `project` or `project_acceptance_*` object is named, so
      // the 0177 pair and every stored task and criterion row are out of its reach. No function,
      // trigger, enum or type is created, replaced or dropped — no `CREATE OR REPLACE FUNCTION`, so it
      // is not another writer of the DONE fence and names none of the six preserved objects. No
      // INSERT, UPDATE or DELETE.
      '0333_project_start_request',
      // A project's pause as a fact of its own (0334): two nullable `ADD COLUMN`s with no default on
      // `project` (`paused_at`, `paused_reason`, catalog-only) with one CHECK every stored row
      // satisfies as both read NULL, and one UPDATE that pauses the started projects whose Automatic
      // is off — writing those two columns and nothing else. Read against every claim above:
      // `project` is named, as the table the columns are added to and the one the UPDATE writes; no
      // trigger on `project` fires on either column, and none is created. It names no `task`,
      // `session` or `project_acceptance_*` object and none of the six preserved triggers/functions,
      // creates or replaces no function, trigger, enum or type — so it is not another writer of the
      // DONE fence — and carries no `ALTER TYPE` and no `DROP`. No INSERT or DELETE.
      '0334_project_paused',
      // A profile photo of one's own (0335): one new table, `user_avatar`, keyed by the user it belongs
      // to, with two CHECKs (the three image types, and a non-empty photo) and a foreign key to `user`
      // whose `ON DELETE CASCADE` is a referential action on the new table's rows. Read against every
      // claim above: no `task`, `session`, `project` or `project_acceptance_*` object is named, so the
      // 0177 pair and every stored task and criterion row are out of its reach. No function, trigger or
      // type is created, replaced or dropped — so it is not another writer of the DONE fence and names
      // none of the six preserved objects. No INSERT, UPDATE or DELETE: the new table starts empty.
      '0335_user_avatar',
      // Which account a session runs on, and whether it was picked by hand (0336): three `ADD COLUMN`s on
      // `session` — two BOOLEAN NOT NULL DEFAULT false (`codex_account_pinned`, `claude_account_pinned`),
      // catalog-only as a constant default is, and one nullable TEXT with no default (`claude_account`,
      // 0330's `codex_account` exactly) — with no index, no CHECK and no foreign key, and nothing else.
      // Read against every claim above: `task`, `project` and `project_acceptance_criterion_definition`
      // are not named, so the 0177 pair and every stored task and criterion row are out of its reach. It
      // names no `project_acceptance_*` object and none of the six preserved triggers/functions, and
      // creates no function, trigger, enum or type — so it is not another writer of the DONE fence. No
      // INSERT, UPDATE or DELETE: nothing is backfilled.
      '0336_session_account_choice',
      // What became of a document section's material: one JSONB column, `dispositions`, added to
      // `wiki_doc_section` with a default and a CHECK that it is an array. Read against every claim above:
      // no `task`, `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair and
      // every stored task and criterion row are out of its reach. No function, trigger or type is created,
      // replaced or dropped — its one DO block only adds the CHECK when it is missing — so it is not another
      // writer of the DONE fence and names none of the six preserved objects. No INSERT, UPDATE or DELETE.
      '0337_wiki_doc_dispositions',
      // The wiki plan's jobs: one new table, `wiki_plan_job` (a draft, revision or build of a space's plan,
      // run as a task of the space's maintenance list), reaching `wiki_space` through (space_id, owner_id),
      // with its own CHECKs, one unique index, one partial unique index and two indexes. Its task_id and
      // session_id are history references with no foreign key. Read against every claim above: no `task`,
      // `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair and every stored
      // task and criterion row are out of its reach. No function, trigger or type is created, replaced or
      // dropped — no `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names
      // none of the six preserved objects. No INSERT, UPDATE or DELETE: the new table starts empty.
      '0338_wiki_plan_job',
      // A plan draft's idempotency key: two nullable `ADD COLUMN`s with no default on `wiki_plan`
      // (`idempotency_key`, `request_sha256`, catalog-only), one CHECK every stored version satisfies as
      // both read NULL, and one unique index on (owner_id, idempotency_key). Read against every claim
      // above: no `task`, `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair
      // and every stored task and criterion row are out of its reach. No function, trigger or type is
      // created, replaced or dropped — so it is not another writer of the DONE fence and names none of the
      // six preserved objects. No INSERT, UPDATE or DELETE: nothing is backfilled.
      '0339_wiki_plan_idempotency',
      // The documents follow what changed (criterion 3 revision 3, criterion 11): one nullable JSONB
      // column, `progress`, added to `wiki_plan_job` with no default, two CHECKs on it that every stored
      // row satisfies (no build job is stored before this ships), and one partial unique index; one
      // nullable TEXT column, `withdrawn_path`, added to `wiki_doc_sentence` with no default, its
      // withdrawal CHECK dropped and added back widened to admit a path in place of an entry, one CHECK
      // on the new column, and one partial index on `wiki_doc_footnote`. Read against every claim above:
      // no `task`, `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair and
      // every stored task and criterion row are out of its reach. No function, trigger or type is created,
      // replaced or dropped — the only DROPs are its own CHECKs restated in the same file — so it is not
      // another writer of the DONE fence and names none of the six preserved objects. No INSERT, UPDATE or
      // DELETE: nothing is backfilled.
      '0340_wiki_maintenance_docs',
      // Two nullable columns with no default on `session`, `merge_recovery` (JSONB) and
      // `merge_recovery_action` (TEXT). Pure addition: no stored row is backfilled, no column,
      // constraint, type, trigger or function is dropped or replaced. The preserved task data,
      // criterion labels, project acceptance objects and DONE writer fence are untouched.
      '0341_session_merge_recovery',
      // One more accepted `project_coordinator_wake.event` spelling. The CHECK is widened to admit
      // the blocker notification, but no wake row is backfilled or rewritten, and none of the
      // preserved task, session or acceptance relations is named.
      '0342_project_blocker_coordinator_wake',
      // A landing run again on purpose (`integration_retry`): four nullable columns with no default
      // on `project_integration_job` (`retry_of_job_id`, `retry_failure_class`, `retry_reason`,
      // `retry_requested_by_session_id`, catalog-only) and four CHECKs every stored row satisfies
      // because all four read NULL in it. Read against every claim above: no `task`, `session`,
      // `project` or `project_acceptance_*` object is named, so the 0177 pair and every stored task
      // and criterion row are out of its reach. No function, trigger or type is created, replaced or
      // dropped — so it is not another writer of the DONE fence and names none of the six preserved
      // objects. No INSERT, UPDATE or DELETE: nothing is backfilled. (0343 remains unused in this
      // line; the delivery-review migration is 0375 because the current production/branch ledger
      // already occupies the intervening numbers.)
      '0344_integration_job_retry',
      // The owner DONE record (0345): four columns on `project` plus CHECKs for its provenance,
      // digest and accepted-gap array. Existing DONE rows are backfilled only in those new columns
      // as DERIVED; no task, criterion, confirmation or judgment row is rewritten. The two
      // `project_open_item` CHECKs are widened for DONE_REQUEST and every existing item satisfies
      // them. No trigger, function or type is created, replaced or dropped, so the preserved DONE
      // writer fence and all task/acceptance data remain untouched.
      '0345_project_owner_done',
      // `task.codeless_reason` and `project_integration_job.source_on_upstream` (0346): one nullable
      // TEXT column on `task` and one nullable BOOLEAN on `project_integration_job`, both with no
      // default, no NOT NULL and no constraint — so, like 0236 and 0298, it ALTERs the table the
      // 0177 pair lives on and reaches no stored row: every existing task and job reads NULL,
      // nothing is backfilled, and `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named. No
      // function, trigger, type, index or constraint is created, replaced or dropped — no `CREATE
      // OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none of the
      // six preserved objects — and it has no INSERT, UPDATE or DELETE. No `project_acceptance_*`
      // object is named.
      '0346_codeless_and_source_on_upstream',
      // The four lifetime token sums leave `session` (0347): `sum_input_tokens`,
      // `sum_output_tokens`, `sum_cache_read` and `sum_cache_write` are dropped, catalog-only, after
      // an anonymous DO gate that RAISEs while any function body still reads one. Read against every
      // claim above: it ALTERs only `session`, so no `task` or `project_acceptance_*` object is
      // named and the 0177 pair and every stored task and criterion row are out of its reach. No
      // function, trigger or type is created, replaced or dropped — the gate is a DO block, not a
      // `CREATE OR REPLACE FUNCTION`, so it is not another writer of the DONE fence and names none
      // of the six preserved objects. No INSERT, UPDATE or DELETE.
      '0347_drop_session_token_sums',
      // Session folders (0348, docs/session-folders-move-design.md §3.1): one new table,
      // `session_folder` (foreign keys to `user` and `workspace`, both ON DELETE CASCADE, a unique
      // index on (workspace_id, name) and an index on owner_id), and one nullable UUID column with
      // no default on `session`, `folder_id`, catalog-only, with its index and a foreign key into
      // the new table ON DELETE SET NULL. Read against every claim above: no `task`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and
      // criterion row are out of its reach. No function, trigger or type is created, replaced or
      // dropped — so it is not another writer of the DONE fence and names none of the six preserved
      // objects. No INSERT, UPDATE or DELETE: the new table starts empty and every session reads
      // NULL. (0375 is the delivery review's, and 0347 is the token-sum drop just above, so this
      // took the next number nobody used in its sequence.)
      '0348_session_folder',
      // Who sent a turn: one nullable UUID column with no default on `conversation_turn`
      // (`sender_session_id`, deliberately no foreign key) and one partial index on it. Read against
      // every claim above: `conversation_turn` is not among the preserved relations and nothing else
      // is named — no `task`, `session`, `project` or `project_acceptance_*` object, no function,
      // trigger or type created, replaced or dropped, and no INSERT, UPDATE or DELETE. (Written as
      // Written as 0343 on its own branch and renumbered before it landed: this line keeps 0343
      // unoccupied, while 0348 is spelled by the unlanded session-folders branch.)
      '0349_conversation_turn_sender_session',
      // Session requests (0350): one new table, `session_request`, whose one foreign key is to the
      // recipient `session` row (ON DELETE CASCADE), with CHECKs and partial indexes of its own; a
      // BEFORE UPDATE guard on that table that keeps an outcome from being rewritten; and an AFTER
      // UPDATE trigger on `session` that closes the OPEN requests naming an ended session as their
      // recipient. Read against every claim above: no `task`, `project` or `project_acceptance_*`
      // object is named, so the 0177 pair and every stored task and criterion row are out of its
      // reach; the session trigger writes only `session_request`, which starts empty, and is not
      // another writer of the DONE fence nor any of the six preserved objects. No INSERT, UPDATE or
      // DELETE of an existing row: nothing is backfilled. (Written as 0347 on its own branch and
      // renumbered before it landed: 0347 is main's token-sum drop above, 0348 is spelled by the
      // unlanded session-folders branch, and 0349 is the sender column just above.)
      '0350_session_request',
      // What one session sent another, kept as it was sent (0351): one new table,
      // `session_message_charge`, whose one foreign key is to the recipient `session` row (ON DELETE
      // CASCADE), and one index on it. Its one INSERT fills that new table from the last hour of
      // `conversation_turn` rows, which it only reads. Read against every claim above: no `task`,
      // `project` or `project_acceptance_*` object is named, so the 0177 pair and every stored task and
      // criterion row are out of its reach; no function, trigger or type is created, replaced or
      // dropped, so it is not another writer of the DONE fence and names none of the six preserved
      // objects; and no existing row is updated or deleted.
      '0351_session_message_charge',
      // An outcome held for an asker that stopped for good (0352): one nullable column with no default
      // on `session_request` (`reply_comment_due_at`), one CHECK every stored row satisfies because the
      // column reads NULL in it, one partial index, and an AFTER UPDATE trigger on `session` whose
      // function writes only `session_request`. Read against every claim above: no `task`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion
      // row are out of its reach; the new function is not another writer of the DONE fence and names
      // none of the six preserved objects. No INSERT, UPDATE or DELETE of an existing row: nothing is
      // backfilled.
      '0352_session_request_asker_stopped',
      // `project_open_item_promotion_open_idx` (0353): one partial btree index on
      // `project_open_item.promotion_id`, a column that already existed, over OPEN rows. Read
      // against every claim above: one `CREATE INDEX IF NOT EXISTS` and nothing else — no function,
      // trigger, type, column or constraint is created, altered or dropped, so it is not another
      // writer of the DONE fence and names none of the six preserved objects. `project_open_item`
      // is named only as the table the index is built on, and it is not a preserved relation; no
      // `task`, `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair and
      // every stored task and criterion row are out of its reach. No INSERT, UPDATE or DELETE: the
      // build reads every item row once and writes none. (Written as 0350 on its own branch and
      // renumbered before it landed: 0349 to 0352 are the four just above.)
      '0353_project_open_item_promotion_open_idx',
      // A retry the sweeper has claimed and not yet re-sent (0354): one nullable column with no
      // default on `session` (`retry_claimed_at`), which every stored row reads NULL for. Read
      // against every claim above: one `ALTER TABLE "session" ADD COLUMN` and nothing else — no
      // function, trigger, type, constraint or index is created, replaced or dropped, so it is not
      // another writer of the DONE fence and names none of the six preserved objects. `session` is
      // named only as the table the column is added to, and it is not a preserved relation; no
      // `task`, `project` or `project_acceptance_*` object is named, so the 0177 pair and every
      // stored task and criterion row are out of its reach. No INSERT, UPDATE or DELETE: the column
      // is added, and the code that fills it writes the session row it already writes.
      '0354_session_retry_claimed',
      // A login pool's session token stops naming a ChatGPT account (0355): `pool_login_token` loses
      // `account_id`, with the (pool_id, account_id) → pool_codex_login foreign key and the index over
      // that pair. Read against every claim above: it ALTERs one table, 0324's `pool_login_token`, which
      // is none of the preserved relations, so no `task`, `session`, `project` or `project_acceptance_*`
      // object is named and the 0177 pair and every stored task and criterion row are out of its reach.
      // The pool-owner fence on that same table — (pool_id, user_id) → provider_pool(id, owner_id) — is
      // not named, and the dropped column is no part of it. No function, trigger, type or enum is
      // created, replaced or dropped, so it is not another writer of the DONE fence and names none of
      // the six preserved objects. No INSERT, UPDATE or DELETE. (Written as 0348 on its own branch and
      // renumbered before it landed: 0348 to 0353 are the six just above.)
      '0355_pool_login_token_unbind_account',
      // A maintenance run's attempts, its platform rerun and whose its failure was: five `ADD COLUMN`s on
      // `wiki_maintenance_run` (two INTEGER NOT NULL DEFAULT 0, catalog-only; three nullable, no default),
      // and two CHECKs added after the backfill makes every stored row satisfy them. Its UPDATEs write
      // `wiki_maintenance_run` alone: `task` is read for its status and `session` for its created_at, and
      // neither is written, locked beyond the read, altered or dropped — so the 0177 pair, every stored
      // task and criterion row and the six preserved objects are out of its reach. No function, trigger
      // or type is created, replaced or dropped, so it is not another writer of the DONE fence. (Written
      // as 0354 on its own branch and renumbered before it landed: 0354 is spelled by another branch not
      // yet landed, and 0355 is the one just above.)
      '0356_wiki_maintenance_run_attempts',
      // How a maintenance run was made, for the day's count while its space catches up (0357): two `ADD
      // COLUMN`s on `wiki_maintenance_run` — `catch_up` TEXT, nullable with no default, and `local_endpoint`
      // BOOLEAN NOT NULL DEFAULT false, catalog-only — and one CHECK every stored row satisfies because its
      // `catch_up` reads NULL. Read against every claim above: `wiki_maintenance_run` is the only table named, and
      // it is none of the preserved relations, so no `task`, `session`, `project` or `project_acceptance_*`
      // object is named and the 0177 pair and every stored task and criterion row are out of its reach. No
      // function, trigger or type is created, replaced or dropped, so it is not another writer of the DONE fence
      // and names none of the six preserved objects. No INSERT, UPDATE or DELETE: nothing is backfilled.
      '0357_wiki_maintenance_catch_up',
      // Every Codex pool has its owner among its people (0358): one INSERT … SELECT … ON CONFLICT DO
      // NOTHING into `provider_pool_person`, an ADMIN row for the owner of each pool of one's own on Codex,
      // reading `provider_pool` and writing nothing else. Read against every claim above: neither table is
      // a preserved relation, and no `task`, `session`, `project` or `project_acceptance_*` object is
      // named, so the 0177 pair and every stored task and criterion row are out of its reach. No table,
      // column, constraint, index, function, trigger or type is created, altered or dropped, so it is not
      // another writer of the DONE fence and names none of the six preserved objects; no row is updated
      // or deleted. (0357 is the wiki maintenance catch-up's, so this took the next number.)
      '0358_codex_pool_owner_person',
      // `task_project_activity_idx`: one partial btree on `task (owner_id, project_id, updated_at)`
      // `WHERE project_id IS NOT NULL`, three columns that already existed, so that the sidebar's
      // `max(updated_at)` per open project is one backward probe instead of a read of every task.
      // Read against every claim above: one `CREATE INDEX IF NOT EXISTS` and nothing else — no
      // function, trigger, type, column or constraint is created, altered or dropped, so it is not
      // another writer of the DONE fence and names none of the six preserved objects. `task` IS one
      // of the preserved relations, and it is named only as the table the index is built on, as in
      // 0283 and 0305: an index is a new relation beside the table, not a rewrite of it, so no
      // column of `task` is added, dropped or retyped and no stored row moves by one byte.
      // `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named, and no
      // `project_acceptance_*` object is. No INSERT, UPDATE or DELETE: the build reads every task
      // row once and writes none. (It is in place of a maintained column on `project`, another
      // preserved relation, whose backfill would have been an UPDATE of every project row.)
      '0361_task_project_activity_idx',
      // What the user calls each account a runner reports (0362): one `ADD COLUMN` on `runner` —
      // `account_names` JSONB, nullable with no default, catalog-only. Read against every claim above:
      // `runner` is none of the preserved relations, so no `task`, `session`, `project` or
      // `project_acceptance_*` object is named and the 0177 pair and every stored task and criterion row
      // are out of its reach. No function, trigger, type or constraint is created, replaced or dropped,
      // so it is not another writer of the DONE fence and names none of the six preserved objects. No
      // INSERT, UPDATE or DELETE: nothing is backfilled. (Written as 0359 on its own branch and
      // renumbered before it landed: 0359 and 0360 are spelled by other branches not yet landed, and
      // 0361 is the one just above.)
      '0362_runner_account_names',
      // Model-routing storage (0364): two nullable task suggestion columns and their CHECK,
      // two workspace settings with constant defaults, and a new task_route_decision table
      // with its own indexes and foreign keys. Read against the claims above: no existing column
      // is dropped or retyped, no DML or function/trigger replacement appears, and neither the
      // 0177 pair, criterion enum nor any project_acceptance_* object is named.
      '0364_task_model_routing',
      // `task_owner_creator_session_status_created_id_idx` (0365): one btree on `task
      // (owner_id, creator_session_id, status, created_at DESC, id DESC)`, five columns that already
      // existed, so that a session's "Tasks created here" row is counted and its first rows read off
      // the index instead of a read — and a 4.6 MB tuplestore — of every task the session created.
      // Read against every claim above: one `CREATE INDEX IF NOT EXISTS` and nothing else — no
      // function, trigger, type, column or constraint is created, altered or dropped, so it is not
      // another writer of the DONE fence and names none of the six preserved objects. `task` IS one
      // of the preserved relations, and it is named only as the table the index is built on, as in
      // 0283, 0305 and 0361: no column of `task` is added, dropped or retyped and no stored row moves.
      // `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named, and no
      // `project_acceptance_*` object is. No INSERT, UPDATE or DELETE: the build reads every task
      // row once and writes none.
      '0365_task_owner_creator_session_status_created_id_idx',
      // A retry claim taken back without its turn is a retry given up (0366): 0352's AFTER UPDATE
      // trigger on `session`, `session_request_asker_stopped`, dropped and created again over the same
      // function — one more column in its list (`retry_claimed_at`) and one more branch in its WHEN —
      // and one partial index on `session.retry_claimed_at`. Read against every claim above: no
      // function is created or replaced, and the trigger's function still writes only
      // `session_request`, so it is not another writer of the DONE fence and names none of the six
      // preserved objects; `session` is named only as the table the trigger and the index are on, and
      // it is not a preserved relation; no `task`, `project` or `project_acceptance_*` object is named,
      // so the 0177 pair and every stored task and criterion row are out of its reach. No INSERT,
      // UPDATE or DELETE. (Written as 0360 on its own branch and renumbered before it landed: 0359 is
      // spelled by a branch not yet landed, and 0361, 0362, 0364 and 0365 landed first.)
      '0366_session_retry_claim_lease',
      // `antigravity` becomes a built-in runtime keyword (0367), the way 0080 made `opencode` one:
      // whatever configured provider or account pool held the slug is renamed to a free
      // `antigravity-N`, every stored reference to the slug is rewritten to it, a compatibility row
      // is inserted into `model_provider` with one CHECK, and two new functions back three new
      // triggers (two on `model_provider`, one BEFORE UPDATE OF "status" on `session`). Read
      // against every claim above: it is DML on two preserved relations, and only on one column
      // of each — `session.provider` and `task.provider`, rewritten from `antigravity` to the new
      // slug on the rows that name it, and nothing else assigned. No row is inserted into or
      // deleted from either, so no count moves; no status, criterion, verdict or acceptance column
      // is written, and `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named. The
      // triggers that UPDATE fires are the statement-level AFTER UPDATE ones on `task`, which act
      // on run_at/status/project/list differences this write cannot produce; no row-level trigger
      // on either table lists `provider`, so the DONE writer fence (status and
      // completion_fence_revision only) does not fire. Its other writes land on relations this
      // file does not preserve — `model_provider`, `provider_pool`, `task_route_decision`,
      // `task_run_request`, `workspace`, `agent`, `user` and `wiki_space`. Its two `CREATE OR
      // REPLACE FUNCTION`s are its own new guards, so it is not another writer of the DONE fence
      // and names none of the six preserved objects; no table, column, type or enum is created,
      // altered or dropped besides that CHECK, and no `project_acceptance_*` object is named.
      // (0366 is the retry-claim lease just above, which landed first, so this took 0367; 0369,
      // below, landed before this did and left 0367 to it.)
      '0367_antigravity_runtime',
      // An exception item the coordinator is handling (0368): five nullable columns with no default
      // on `project_open_item` (`handling_job_id`, `handling_session_id`, `handling_reason`,
      // `handling_started_at`, `resolved_by_job_id`, catalog-only), four CHECKs every stored item
      // satisfies because all five read NULL in it, one partial index over OPEN rows, and
      // `project_integration_job_retry_kind_chk` dropped and added back admitting CHECK_PROMOTION — a
      // superset every stored job satisfies. Read against every claim above: `project_open_item` and
      // `project_integration_job` are the only relations named and neither is a preserved one; no
      // `task`, `session`, `project` or `project_acceptance_*` object is named, so the 0177 pair and
      // every stored task and criterion row are out of its reach. No function, trigger or type is
      // created, replaced or dropped — the only DROP is a CHECK restated in the same statement — so it
      // is not another writer of the DONE fence and names none of the six preserved objects. No
      // INSERT, UPDATE or DELETE: nothing is backfilled. (Written as 0364 on its own branch and
      // renumbered before it landed: 0364, 0365 and 0366 landed first, 0369 just below left 0367 and
      // 0368 to two branches not yet landed, and 0367 is the other one's.)
      '0368_open_item_coordinator_handling',
      // Every live workspace's place in the sidebar, written down (0369): one UPDATE … FROM of
      // `workspace.position`, computed from `workspace` and `runner` rows and nothing else. Read
      // against every claim above: neither table is a preserved relation, and no `task`, `session`,
      // `project` or `project_acceptance_*` object is named, so the 0177 pair and every stored task
      // and criterion row are out of its reach. No table, column, constraint, index, function,
      // trigger or type is created, altered or dropped, so it is not another writer of the DONE
      // fence and names none of the six preserved objects; no row is inserted or deleted. (Written
      // as 0366 on its own branch and renumbered before it landed: 0366 is the retry claim lease
      // above, and 0367 and 0368 were spelled by branches not yet landed.)
      '0369_workspace_position_backfill',
      // A confirmation request's review (0370, docs/owner-confirmation-review-contract.md §3): three new
      // enums, two new tables (`task_owner_confirmation_review` and its records), one nullable CHAR(40)
      // column on `task_owner_confirmation_request` and one on `session`, three nullable columns on
      // `task_owner_decision` with a foreign key and a CHECK on the new values only, and one new
      // trigger with its own new function on `session`. Read against every claim above: `task` is
      // named only as the target of the new tables' foreign keys — no column of it is added, dropped or
      // retyped, and no stored row moves; `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named. Its one
      // `CREATE OR REPLACE FUNCTION` is the new trigger's own, so it is not another writer of the DONE
      // fence and names none of the six preserved objects; 0267's CHECKs are left as they were. No
      // INSERT, UPDATE or DELETE: no request or decision is backfilled. (Written as 0365 on its own
      // branch and renumbered before it landed: 0365, 0366, 0367 and 0369 landed first, just above,
      // and 0368 is spelled by another project's branch not yet landed.)
      '0370_owner_confirmation_review',
      // Accounts belong to a person of the pool (0371): `pool_codex_login`'s composite foreign key is
      // dropped and added again over `provider_pool_person(pool_id, user_id)` — the fence
      // `pool_api_key`'s contributor already has — so a person a pool is shared with may sign a
      // ChatGPT account of their own in, instead of only the pool's owner holding one; and
      // `provider_pool` gains `members_can_add_accounts` (BOOLEAN NOT NULL DEFAULT true), the rule
      // that lets them, with the constant default that makes the ADD COLUMN catalog-only. Read
      // against every claim above: no function, trigger, type or enum is created, replaced or
      // dropped, so it is not another writer of the DONE fence; `provider_pool_person` is not one of
      // the preserved relations and no `task`, `project` or `project_acceptance_*` object is named,
      // so the 0177 pair and every stored task and criterion row are out of its reach. `pool_codex_login`
      // and `provider_pool` are not preserved either: the ADD CONSTRAINT validates every stored login
      // once, without rewriting one, and every one of them names its pool's owner — who since 0358 has
      // the person row the new key points at — so validation passes as the rows stand. The CASCADE now
      // hangs off a person rather than the pool's owner, which deletes a person's logins with the
      // person; this migration deletes no person, and no other row of any table moves. No INSERT,
      // UPDATE or DELETE.
      // (Written as 0367 on its own branch and renumbered before it landed: 0367 is the antigravity
      // runtime above, and 0369 and 0370 landed first.)
      '0371_pool_login_person',
      // The Gemini preset's rows move onto the Antigravity runtime (0372): one UPDATE of
      // `model_provider.runtime` and `base_url` on the rows whose `preset_slug` is `gemini`, one
      // UPDATE that sets `session.runtime_session_id` to NULL on the sessions whose provider is one of
      // those rows' slugs, and one CREATE OR REPLACE FUNCTION: 0367's own claim guard
      // `guard_antigravity_runner_claim`, which now also reads `model_provider` (a plain SELECT, no
      // lock) to tell a borrowed Antigravity slug. Read against every claim above: `session` is not a
      // preserved relation, and no `task`, `project` or `project_acceptance_*` object is named, so
      // the 0177 pair and every stored task and criterion row are out of its reach; no row is
      // inserted or deleted. The function it replaces is 0367's, not the DONE writer fence, and no
      // table, column, constraint, index, trigger or type is created, altered or dropped, so it names
      // none of the six preserved objects. (0370 and 0371 landed first; 0373, below,
      // landed before this did and left 0372 to it.)
      '0372_gemini_antigravity_runtime',
      // Why only the owner can settle an agent's OWNER_CONFIRMED task (0373,
      // tasks/owner-confirmation-reason.ts): one new enum and two nullable columns on `task` with a
      // CHECK over those two columns only. Read against every claim above: no existing column of
      // `task` is dropped, retyped or written — `task.acceptance_command`,
      // `task.acceptance_expected_exit_code`, `task_executable_acceptance_pair` and
      // `task_completion_criterion` are not named — and no stored row moves. It carries no `CREATE OR
      // REPLACE FUNCTION` and no trigger, so it is not another writer of the DONE fence and names none
      // of the six preserved objects; no `project_acceptance_*` object is named. No INSERT, UPDATE or
      // DELETE. (Written as 0371 on its own branch and renumbered before it landed: 0371 is the pool
      // login person above, and 0372 is spelled by another branch not yet landed.)
      '0373_owner_confirmation_reason',
      // An account paused by hand (0374, common/account-pause.ts): one nullable JSONB column on
      // `runner` (`account_pauses`) and two nullable TIMESTAMPTZ(3) columns (`paused_at`,
      // `paused_until`) on each of `provider_pool_member`, `pool_api_key` and `pool_codex_login`,
      // none with a default, so every ADD COLUMN is catalog-only. Read against every claim above:
      // none of those four relations is a preserved one, and no `task`, `session`, `project` or
      // `project_acceptance_*` object is named, so the 0177 pair and every stored task and criterion
      // row are out of its reach. No function, trigger, type, enum, constraint or index is created,
      // replaced or dropped, so it is not another writer of the DONE fence and names none of the six
      // preserved objects. No INSERT, UPDATE or DELETE: nothing is backfilled — every stored account
      // reads as not paused, and a pause is written only when somebody asks for one.
      '0374_account_pause',
      // Delivery landing questions (0375): widen only project_open_item_kind_chk with
      // DELIVERY_REVIEW. Existing rows satisfy the replacement constraint; no task, project,
      // acceptance, DONE fence, trigger or function is rewritten and nothing is backfilled.
      '0375_delivery_review_item',
      // Android push registration (0376) adds one nullable TEXT column and one unique index to
      // device_token only. No existing token, user FK, task, project, acceptance row, fence,
      // function or trigger is changed, and there is no DML or preserved object in its scope.
      // Renumbered before landing because the delivery-review migration already occupies 0375.
      '0376_android_push_installation',
      // DeepSeek Harness runner admission (0377): one new session acquisition trigger and its
      // function, plus a replacement of 0367/0372's Antigravity claim function that excludes
      // discriminator-marked native dsh sessions from a colliding configured provider lookup.
      // The new function reads model_provider and locks the authorized runner FOR SHARE NOWAIT;
      // neither function writes another relation or touches a preserved ledger, task, project,
      // criterion, enum, acceptance object or DONE fence. No stored row is rewritten, and no
      // existing trigger, table, column, constraint, index or type is dropped or altered.
      '0377_dsh_runner_gate',
      // Open-item hand-over history (0378): three nullable columns and two checks on
      // project_open_item only. No existing rows are rewritten, and the session id deliberately
      // has no foreign key so purging a conversation cannot erase the owner's explanation.
      '0378_open_item_hand_over',
      // A task's concrete fix for an exception item (0379): one nullable task FK to
      // project_open_item, SET NULL on item deletion and an index for the read/escalation paths.
      // No existing row is backfilled, and no preserved completion/fence object is touched.
      '0379_open_item_fix_link',
      // Owner integration retry attribution (0380): one nullable requester column on
      // project_integration_job and one nullable owner-attribution column on project_open_item;
      // the two existing all-or-none CHECKs are replaced with XOR checks. Existing coordinator
      // retries satisfy the widened constraints, and no task, project, acceptance, DONE fence,
      // trigger or function is rewritten; nothing is backfilled.
      '0380_owner_integration_retry',
      // Reopen landing intent (0381): one task-keyed marker row records the explicit task_reopen
      // door until the next DONE queues its LAND_TASK generation. It is consumed transactionally;
      // no existing task, project, acceptance, DONE fence, trigger or function is rewritten.
      '0381_task_reopen_landing_intent',
      // Credential throttle (0382): one nullable `throttled_until` on pool_codex_login and one on
      // pool_api_key, written by the pool gateways when a 429 outlasts the wait they may hold open.
      // Two ADD COLUMN of a nullable timestamp and nothing else — no task, project, acceptance, DONE
      // fence, trigger or function is touched, and no existing row is backfilled.
      '0382_pool_credential_throttle',
      // Personal access tokens (0383): one new table, personal_access_token, with its own CHECKs,
      // indexes and one foreign key to `user` (ON DELETE CASCADE). No existing table, column,
      // constraint, function, trigger or type is altered or dropped; no task, project, acceptance
      // or DONE fence object is named, and no row is written.
      '0383_personal_access_token',
      // Activity credential (0384): two nullable columns on `activity` — credential_kind and
      // credential_id — and one CHECK pairing them, which every existing row (both NULL) satisfies.
      // `activity` is not a preserved relation; no task, project, acceptance or DONE fence object,
      // trigger, function or type is named, and no row is written or backfilled.
      '0384_activity_credential',
      // Runner self-update state (0385): one nullable JSONB `self_update` and one nullable
      // TIMESTAMP(3) `self_update_requested_at` on `runner`, neither with a default, so both ADD
      // COLUMNs are catalog-only. `runner` is not a preserved relation nor reachable from one, and
      // neither column is in the UPDATE OF list of 0118's runner availability trigger. No table,
      // index, constraint, enum, type, function or trigger is created, replaced or dropped; no
      // task, project, acceptance or DONE fence object is named; no INSERT, UPDATE or DELETE —
      // every runner reads NULL, "not reported" and "nobody asked", until its next heartbeat.
      '0385_runner_self_update',
      // Move requests (0386): one nullable `requested_criterion_definition_id` on
      // project_handoff_approval with a CHECK keeping it to MOVE_TASK rows, one partial unique index
      // (one PENDING move per owner, task and pair of projects) and one new function + BEFORE UPDATE
      // trigger freezing the new column. 0155's guard is not replaced; no task, project,
      // acceptance or DONE fence object is named, and no row is written or backfilled.
      '0386_project_handoff_move_request',
      // Antigravity accounts (0387): one nullable TEXT with no default on `workspace`
      // (`antigravity_account`, 0309's `claude_account` exactly), and on `session` one nullable TEXT
      // with no default (`antigravity_account`) and one BOOLEAN NOT NULL DEFAULT false
      // (`antigravity_account_pinned`) — 0336's pair exactly, catalog-only as a constant default is —
      // with no index, no CHECK and no foreign key, and nothing else. `task`, `project` and
      // `project_acceptance_criterion_definition` are not named, no `project_acceptance_*` object nor
      // any of the six preserved triggers/functions is, and no function, trigger, enum or type is
      // created — so it is not another writer of the DONE fence. No INSERT, UPDATE or DELETE: nothing
      // is backfilled.
      '0387_antigravity_account',
      // `orbit login` through the browser (0388): one new table, pat_device_login, with its own
      // CHECKs, indexes and one foreign key to `user` (ON DELETE CASCADE). No existing table,
      // column, constraint, function, trigger or type is altered or dropped; no task, project,
      // acceptance or DONE fence object is named, and no row is written.
      '0388_pat_device_login',
      // Confirmed moves (0389): one CREATE OR REPLACE of `task_claimed_project_move_guard` (0122,
      // widened by 0130); its trigger, event and refusal are unchanged. The body still refuses a
      // project change on a task with a live claim, except in the transaction that applies the
      // account owner's confirmation of a MOVE_TASK for that task and those two projects — named by
      // a transaction-local setting and an unspent, USER-approved project_handoff_approval row the
      // function only reads. It is none of the six preserved triggers/functions and not the DONE
      // fence; no table, column, constraint, index or type is touched, and no row is written.
      '0389_move_task_confirmation_live_claim',
      // Sign-in providers (0390): one new table, sign_in_provider, with its primary key and two
      // CHECKs of its own, and no other index, foreign key, function or trigger. No existing table,
      // column, constraint, function, trigger or type is altered or dropped; no task, project,
      // acceptance or DONE fence object is named, and no row is written. Written as 0387 and
      // renumbered before landing, unchanged otherwise, when main's 0387_antigravity_account took
      // that number first.
      '0390_sign_in_provider',
      // Signing in with Google (0391): two new tables. user_identity, with its primary key, two
      // CHECKs, two unique indexes and a foreign key to `user` (ON DELETE CASCADE); and
      // oauth_login_flow, with its primary key, four CHECKs, two unique indexes, two indexes and a
      // foreign key to `user` (ON DELETE CASCADE). No function or trigger. No existing table, column,
      // constraint, function, trigger or type is altered or dropped; no task, project, acceptance or
      // DONE fence object is named, and no row is written.
      '0391_google_login_flow',
      // Accounts without a password (0392): one ALTER COLUMN … DROP NOT NULL of `user.password_hash`,
      // and nothing else. `user` is not a preserved relation; its email's unique index, every other
      // column and every constraint stay as they were; no task, project, acceptance or DONE fence
      // object, function, trigger or type is named, and no row is written or backfilled.
      '0392_user_password_hash_nullable',
      // Skipping one landing's merge check (0393): four `ADD COLUMN`s on `project_integration_job`
      // (one BOOLEAN NOT NULL DEFAULT false, one TEXT, two UUID) and three CHECKs, one of them the
      // all-or-none rule that keeps a skip from being written without its reason and its approver.
      // No function, trigger, type, index or foreign key is created, replaced or dropped, so it is
      // not another writer of the DONE fence and names none of the six preserved objects;
      // `project_integration_job` was created by 0281 and is not a preserved relation, and no
      // `task`, `session`, `project`, `session_merge_receipt` or `project_acceptance_*` object is
      // named. No INSERT, UPDATE or DELETE: no stored row is read, locked, backfilled or rewritten —
      // the columns are catalog-only, and every existing row keeps the flag false.
      '0393_integration_job_skip_merge_check',
      // Closing the shells a SOURCE refusal left RUNNING (0394, docs/project-source-contract.md
      // §10.3 / SR50): pure DML, and the first later migration that writes a preserved relation —
      // three statements over one row set, a session that is `source_state = 'REFUSED' AND
      // status = 'RUNNING'` with `run_claimed_at` still set. It UPDATEs those `session` rows
      // (terminal status, the `<code>: <reason>` error line, the claim markers, the running-work
      // sets), UPDATEs the `inbox_lease_generation` tombstone each held, and INSERTs the project's
      // `SOURCE_UNRESOLVED` `project_blocker` item for the ones whose task is in a project. No DDL
      // of any kind: no table, column, constraint, index, type, function or trigger is created,
      // replaced, altered or dropped, so it is not another writer of the DONE fence (0230's body
      // remains the only one this file accounts for) and it names none of the six preserved
      // objects. `task` is READ — its `project_id`, to find the project to file the item against —
      // and never written; no `session_merge_receipt`, `project_acceptance_*` or 0177 relation is
      // touched, and `task.acceptance_command`, `task.acceptance_expected_exit_code`,
      // `task_executable_acceptance_pair` and `task_completion_criterion` are not named, so the
      // preserved pair and the criterion labels cannot move. One indirect write, and it is 0122's:
      // a session leaving the live set fires `session_project_capacity_serialize`, which bumps
      // `project.updated_at` — a display column no criterion reads. Every statement is scoped to a
      // row set that stops matching the moment it has run, so re-applying the file is a no-op: the
      // repair is idempotent, not a job.
      '0394_close_refused_running_shells',
      // `task_project_rollup_covering_idx`, rebuilt (0395): 0178's five key columns and its
      // predicate kept exactly, and the six columns the rollup's classifier reads
      // (`completion_policy`, `verifies_task_id`, `assignee_id`, `dispatch_hold`, `terminal_reason`,
      // `superseded_by_task_id`) added as INCLUDE payload, so `GET /projects` classifies a project's
      // tasks from the index instead of fetching a heap row per task. Read against every claim
      // above: one `DROP INDEX` and one `CREATE INDEX` and nothing else — no function, trigger,
      // type, column or constraint is created, altered or dropped, so it is not another writer of
      // the DONE fence and names none of the six preserved objects. `task` IS one of the preserved
      // relations, and it is named only as the table the index is rebuilt on, as in 0283, 0305 and
      // 0361: an index is a relation beside the table, and with the key columns unchanged no column
      // of `task` is added, dropped or retyped — `task.acceptance_command`,
      // `task.acceptance_expected_exit_code`, `task_executable_acceptance_pair` and
      // `task_completion_criterion` are not named, and no `project_acceptance_*` object is. No
      // INSERT, UPDATE or DELETE: the build reads every task row once and writes none, and the DROP
      // takes the index away inside the migration's own transaction, so no reader sees it missing.
      '0395_project_rollup_covering_idx_columns',
      // Disabled accounts (0396): one ADD COLUMN of a nullable TIMESTAMP(3) `disabled_at` on `user`,
      // with no default, so the ALTER is catalog-only, and nothing else — no index, constraint,
      // function, trigger or type. `user` is not a preserved relation; no task, project, acceptance
      // or DONE fence object is named, and no row is written or backfilled: every account reads NULL,
      // enabled. 0394 was held by a branch not yet on main when it was numbered.
      '0396_user_disabled_at',
      // `runner.login_region` (0397): one nullable TEXT column, no default, on `runner`, beside the
      // sign-in relay's `login_account` (0296) — which of Kimi Code's two sites the relay signs in
      // on. Read against every claim above: one `ADD COLUMN` statement and nothing else — no
      // function, trigger, type, index or constraint is created or dropped, so it is not another
      // writer of the DONE fence and names none of the six preserved objects; `runner` is not a
      // preserved relation, and no `task`, `project` or `project_acceptance_*` object is named. No
      // INSERT, UPDATE or DELETE: no stored row is read, locked, backfilled or rewritten.
      '0397_runner_login_region',
      // Managed runners (0399): two new enum types and one new table, managed_runner, with its own
      // unique indexes, CHECKs and three ON DELETE RESTRICT foreign keys — to `user`, and composite
      // with owner_id to `runner` (0231's runner_id_owner_id_key) and `workspace` (0307's
      // workspace_id_owner_id_key). No existing table, column, constraint, function, trigger or type
      // is altered or dropped; no task, project, acceptance or DONE fence object is named, and no
      // row is written.
      '0399_managed_runner',
      // The System model's state (0400): one new table, `wiki_model_status`, of exactly one row,
      // with its primary key and four CHECKs (the single row, the closed set of states, a model
      // named whenever one is configured, a reason exactly when the state is not up). Pure
      // addition: no column, constraint, index, function, trigger or type of any table that
      // exists is created, altered or dropped, so it is not another writer of the DONE fence and
      // names none of the six preserved objects, neither 0177 relation, no `task`, `session` or
      // `project` object and no `project_acceptance_*` one. No INSERT, UPDATE or DELETE: the
      // wiki-worker writes the row on its first probe.
      '0400_wiki_model_status',
      // The server-executed wiki (0401): two new tables, `wiki_job` (a unit of server work, claimed
      // like watch_delivery: a lease generation per claim, a compare-and-set per settle, one running
      // job per space through a partial unique index) and `wiki_model_request` (the persisted model
      // call queue: the unique `(job_id, step, unit, attempt)` identity, its own lease columns and a
      // partial claim index), each with its CHECKs, foreign keys and indexes; `wiki_maintenance_run`
      // loses NOT NULL on `task_id` and gains a nullable `job_id` with a CHECK that exactly one of
      // the two is set, and `wiki_plan_job` gains the same nullable `job_id` with a CHECK that holds
      // it to one maker once it is past queued/held. Read against every claim above: no function,
      // trigger, type or enum is created, replaced or dropped — no CREATE OR REPLACE FUNCTION — so
      // it is not another writer of the DONE fence and names none of the six preserved objects; no
      // 0177 relation is altered (the DROP NOT NULL is on `wiki_maintenance_run`, which is not one,
      // and it rewrites no stored row), and no `task`, `session`, `project` or `project_acceptance_*`
      // object is named. No INSERT, UPDATE or DELETE: every statement is DDL, and the two CHECKs hold
      // for every stored row as it stands.
      '0401_wiki_job',
      // The runner's repository operations (0402): four new tables and no change to anything that
      // exists. `wiki_repo_op` is one repository question a job asks the machine its space's
      // workspace runs on — its kind, its input, its state and the claim (lease_owner,
      // claim_generation, claimed_at, heartbeat_at) a runner holds while it reads; `wiki_repo_op_fragment`
      // stages the pieces of a snapshot too large for one request body under the operation that is
      // uploading them; `wiki_repo_snapshot` is the space's index header (one row per space, replaced
      // whole) and `wiki_repo_snapshot_fragment` its bytes. Read against every claim above: no
      // function, trigger, type or enum is created, replaced or dropped — no CREATE OR REPLACE
      // FUNCTION — so it is not another writer of the DONE fence and names none of the six preserved
      // objects; no 0177 relation is altered and no `task`, `session`, `project` or
      // `project_acceptance_*` object is named. No INSERT, UPDATE or DELETE: every statement is DDL,
      // and the four tables carry no stored row to hold a CHECK to.
      '0402_wiki_repo_op',
      // Wiki links (0403): one nullable `wiki_space_id` on share_link, 0306's one-root CHECK replaced
      // by the same CHECK over four columns, one composite foreign key to `wiki_space (id, owner_id)`
      // (ON DELETE CASCADE) and one partial unique index. `share_link` is the only table altered and
      // `wiki_space` is named only as the table the key references; no task, project, acceptance or
      // DONE fence object, function, trigger or type is named, and no row is written or backfilled.
      '0403_share_link_wiki_space',
      // The plan drafted by the wiki-worker (0404): one nullable `author_job_id` on `wiki_plan` with 0325's
      // `wiki_plan_author_chk` replaced by the same rule over one more column (a maintenance version names its
      // session or its job, exactly one), one nullable JSONB `materials` on `wiki_plan_job` with its object CHECK,
      // and 0338's `wiki_plan_job_made_chk` replaced by the same rule over the job a server-made one names. Only
      // `wiki_plan` and `wiki_plan_job` are altered; no function, trigger, type, index or foreign key is created,
      // replaced or dropped, so it is not another writer of the DONE fence and names none of the six preserved
      // objects; no 0177 relation is altered and no `task`, `session`, `project` or `project_acceptance_*` object
      // is named. No INSERT, UPDATE or DELETE: every stored row holds the new CHECKs as it held the old ones.
      '0404_wiki_plan_server_draft',
      // A plan job made by the wiki-worker's job (0405): 0338's `wiki_plan_job_made_chk` restated as the same CHECK
      // over both of the row's makers, task_id and 0401's job_id, inside a DO block that replaces it only while it
      // still reads the old way — after 0404, which restates it identically, it changes nothing. `wiki_plan_job` is
      // the only table it can alter; no task, project, acceptance or DONE fence object, function, trigger or type is
      // named, and no row is written.
      '0405_wiki_plan_job_server_maker',
      // The read cache (0406, owner 2026-10-08): one new table, `wiki_repo_file` — one file's whole text at
      // (space, sha, path), so the same text is never read from the runner twice; `state` says what the answer
      // was (found | cut | missing | too_large) and the composite foreign key to `wiki_space` deletes the rows
      // with the space. No existing table is altered, and `wiki_repo_op_fragment`, which stages a read whose
      // answer is too large for one request body, already exists (0402). Read against every claim above: no
      // function, trigger, type or enum is created, replaced or dropped, so it is not another writer of the
      // DONE fence and names none of the six preserved objects; no 0177 relation is altered and no `task`,
      // `session`, `project` or `project_acceptance_*` object is named. No INSERT, UPDATE or DELETE: every
      // statement is DDL, and the new table carries no stored row to hold a CHECK to.
      '0406_wiki_repo_file',
      // A maintenance run the wiki-worker's job executes (0407): one nullable `job_id` on `wiki_changeset` with a
      // partial index over the rows that name one, and one nullable `author_job_id` on `wiki_plan_proposal` beside
      // 0338's `author_session_id` — which loses NOT NULL — with a CHECK holding a proposal to exactly one author.
      // Pure addition plus DROP NOT NULL on a column every stored row fills: every existing changeset and proposal
      // keeps its session, no row is written or backfilled, no function, trigger or type is created or replaced,
      // and none of the six preserved objects, the 0177 relations or `project_acceptance_*` is named.
      '0407_wiki_maintain_job',
      // Kimi Code accounts (0408): one nullable TEXT with no default on `workspace` (`kimi_account`,
      // 0387's `antigravity_account` exactly), and on `session` one nullable TEXT with no default
      // (`kimi_account`) and one BOOLEAN NOT NULL DEFAULT false (`kimi_account_pinned`) — 0387's pair
      // exactly, catalog-only as a constant default is — with no index, no CHECK and no foreign key, and
      // nothing else. `task`, `project` and `project_acceptance_criterion_definition` are not named, no
      // `project_acceptance_*` object nor any of the six preserved triggers/functions is, and no function,
      // trigger, enum or type is created — so it is not another writer of the DONE fence. No INSERT,
      // UPDATE or DELETE: nothing is backfilled.
      '0408_kimi_account',
      // Why a promotion candidate is BLOCKED (0409): one nullable TEXT with no default on
      // `project_promotion` (`blocked_reason`) and one CHECK holding it to ALREADY_LANDED, CHECK_FAILED,
      // CONFLICT or ERROR, which every stored row satisfies because the column reads NULL in it. Only
      // `project_promotion` is altered: `task`, `project` and `project_acceptance_*` are not named, none
      // of the six preserved triggers/functions is, and no function, trigger, enum, type or index is
      // created, replaced or dropped — so it is not another writer of the DONE fence. No INSERT, UPDATE
      // or DELETE: nothing is backfilled.
      '0409_promotion_blocked_reason',
      // A landing that pushed nothing because the target already had the work (0410): one nullable
      // BOOLEAN with no default and no constraint on `project_integration_job`
      // (`source_fully_applied`), 0346's `source_on_upstream` exactly. Only that table is altered: no
      // `task`, `project` or `project_acceptance_*` object nor any of the six preserved
      // triggers/functions is named, and no function, trigger, enum, type, index or constraint is
      // created, replaced or dropped — so it is not another writer of the DONE fence. No INSERT,
      // UPDATE or DELETE: every stored job reads NULL.
      '0410_integration_job_source_fully_applied',
      // The merge candidates a recorded merge had already answered (0411, contract §3.3 M-T13):
      // historical-row repair, the shape 0394 has. Three UPDATEs over one predicate — a TASK_BRANCH
      // `project_promotion` still CHECKING, READY or BLOCKED whose task has a MERGED or ALREADY_MERGED
      // receipt for the same branch onto the candidate's upstream, recorded after the candidate — in
      // this order: its QUEUED check job cancelled or its RUNNING one asked to stop
      // (`project_integration_job`), the OPEN card and failures about it closed as PROMOTION_MOVED_ON
      // by the PLATFORM (`project_open_item`), and the candidate written SUPERSEDED. No DDL of any
      // kind: no table, column, constraint, index, type, function or trigger is created, replaced,
      // altered or dropped, so it is not another writer of the DONE fence and names none of the six
      // preserved objects. `session_merge_receipt` is READ, never written; `task`, `session`,
      // `project`, the 0177 relations and every `project_acceptance_*` object are not named, so the
      // preserved pair, the criterion labels and the receipts a criterion lands on cannot move. The
      // last write is the only one that changes what the predicate sees, so re-applying the file is a
      // no-op.
      '0411_retire_candidates_landed_by_receipt',
      // A text with a U+0000 in it is kept as its bytes (0412): one TEXT NOT NULL DEFAULT 'text' on `wiki_repo_file`
      // (`content_encoding`) and two on `wiki_model_request` (`answer_encoding`, `partial_encoding`), each `text` or
      // `base64`, catalog-only as a constant default is, and one CHECK per table holding them to the two — `base64`
      // only on a file row with a text — each added only when absent. No row is written, backfilled or deleted; no
      // other column, and no function, trigger, type or index, is created, replaced or dropped; `task`, `project`
      // and the six preserved objects are named nowhere.
      '0412_wiki_stored_text_encoding',
      // A session's engine, recorded (0414, docs/provider-engine-contract.md §1, §5, §7.1): one nullable TEXT
      // with no default on `session` and one on `task` (`engine`), each held by a CHECK to the six engines,
      // which every stored row satisfies because the column reads NULL in it; then a backfill that writes
      // `engine` and nothing else, and only where it is NULL — two UPDATEs of `session`, and one of `task` over
      // the rows with a provider pin. That `task` UPDATE fires no row trigger of `task`'s: each is `UPDATE OF`
      // columns it does not write, the DONE fence's (`status`, `completion_fence_revision`) among them, so it
      // is not another writer of the DONE fence. The three statement-level AFTER UPDATE triggers it does fire
      // (`project_task_status_count_move`, `task_dispatch_epoch_update`, `task_list_task_count_relist`) act on
      // a change of `status`, `run_at`, `project_id` or `list_id`, which no row of it has. On `session`: an
      // immutability trigger for the column, an acquisition guard, an engine-from-task-pin insert trigger, and
      // 0080's, 0372/0377's and 0377's runtime claim guards replaced by bodies that read the column first. No
      // `project` or `project_acceptance_*` object, none of the six preserved triggers/functions and neither
      // half of the 0177 pair is named, and no row is inserted or deleted.
      '0414_session_engine'],
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

test('after 0246, no migration number is used twice: a duplicate reorders the ledger by string, not by intent', () => {
  const dirs = readdirSync(MIGRATIONS).filter((dir) => /^\d{4}_/.test(dir)).sort();
  // Prisma identifies a migration by its WHOLE directory name, so two branches can each add a
  // `0249_*` under a different name and each `migrate deploy` stays green on its own; the
  // collision only surfaces once they are merged, and from then on which of the two runs first is
  // decided by the rest of the name rather than by the order their authors meant. The deepEqual
  // above notices such a pair only by accident — it fails because the list GREW — and would go
  // green again the moment both halves were dutifully added to it. This says the thing itself.
  //
  // Holes are expected and fine (0247 and 0248 were spent renumbering the pair this came from),
  // so what is asserted is "no number twice", never "the numbers are consecutive".
  //
  // Everything at or below this number predates the rule and is exempt; the failure message says
  // why that floor cannot be lowered.
  const EXEMPT_THROUGH = '0246';
  const byNumber = new Map<string, string[]>();
  for (const dir of dirs) {
    const number = dir.slice(0, 4);
    if (number <= EXEMPT_THROUGH) continue;
    byNumber.set(number, [...(byNumber.get(number) ?? []), dir]);
  }
  const shared = [...byNumber].filter(([, group]) => group.length > 1);
  assert.deepEqual(shared.map(([number]) => number), [],
    `${shared.map(([number, group]) => `${number} is claimed by ${group.join(' and ')}`).join('; ')}`
    + ' — two migrations after 0246 share a number, so the ledger is no longer totally ordered.'
    + ' Renumber the later one to the next free number. Do NOT lower the 0246 floor to make this'
    + ' pass: main carries 28 shared numbers below it (0064_session_last_user_text /'
    + ' 0064_session_tags, on up to 0226) that cannot be fixed, because `_prisma_migrations`'
    + ' records an applied migration by its directory name — renaming one makes `migrate deploy`'
    + ' on a live deployment run it again as a migration it has never seen.'
    + ' 0246_project_acceptance_landed_wake is the highest number below which that holds, which is'
    + ' the only reason the floor sits there.');
});
