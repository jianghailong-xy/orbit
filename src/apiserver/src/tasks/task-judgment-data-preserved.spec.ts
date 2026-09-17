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
      '0266_coordinator_no_progress_retirement',
      '0267_task_owner_confirmation',
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
      '0284_project_fuse_pause'],
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
