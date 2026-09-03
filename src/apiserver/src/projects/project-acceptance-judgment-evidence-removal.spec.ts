import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Consequence 2 of the 2026-09-02 removal, followed to where it ended a day later.
 *
 * 0150's project acceptance gate took EXECUTABLE evidence from two places: 0200's typed attempt,
 * and — when there was no attempt — `task_executable_judgment_result`, the row the judgment
 * machinery wrote from a shell exit code. 0227 removed the first and 0228 the second, which left
 * the gate standing with an EXECUTABLE criterion it could no longer conclude.
 *
 * On 2026-09-03 the account owner removed the gate itself. Migration 0229 dropped the acceptance
 * runs, the per-run criterion verdicts, the conclusion events, the audit ledger, the four triggers
 * on `project` and the six columns they read. So the honest statement of this consequence is no
 * longer "one read path is gone": it is that nothing evaluates a project criterion of any kind.
 *
 * What was NOT removed is the declaration, and that distinction is the whole point — so it is
 * asserted on both sides, in this file, against the tree.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

const SERVICE = read('src/apiserver/src/projects/project-acceptance.service.ts');
const REMOVAL = readFileSync(
  path.join(API, 'prisma/migrations/0229_project_acceptance_judgment_removal/migration.sql'),
  'utf8',
);

test('no evidence source came back, and no replacement evaluator was smuggled in', () => {
  for (const gone of [
    'taskExecutableJudgmentResult',
    'EXECUTABLE_RESULT_RECORDED',
    'canonicalExecutableAttempt',
    'ProjectAcceptanceVerdict',
    'assertDoneAllowed',
    'evaluateGate',
    'reconcileForEvidenceTask',
  ]) {
    assert.equal(SERVICE.includes(gone), false, `${gone} came back into the acceptance service`);
  }
  // No raw SQL against a dropped relation either — `$queryRaw` is not type-checked, so the type
  // checker would not have caught one.
  for (const relation of ['project_acceptance_run', 'project_acceptance_conclusion',
    'project_acceptance_audit']) {
    assert.equal(SERVICE.includes(relation), false, `${relation} is still named in raw SQL`);
  }
});

test('the declaration is what survived, in the service and in the migration', () => {
  // The service still reads the one preserved relation, and reads it by the longer name.
  assert.match(SERVICE, /projectAcceptanceCriterionDefinition/u);
  assert.match(SERVICE, /criteriaSummary/u);

  // 0229 drops the four judgment relations and NOT the declaration. Checked over statements, since
  // the migration's comments name the declaration repeatedly to say what it is not touching.
  const statements = REMOVAL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  const dropped = [...statements.matchAll(/DROP TABLE "([a-z_0-9]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(dropped, [
    'project_acceptance_audit',
    'project_acceptance_conclusion',
    'project_acceptance_criterion',
    'project_acceptance_run',
  ]);
  assert.equal(statements.includes('project_acceptance_criterion_definition'), false,
    'the removal names the declaration table in a statement');
  // And it names no `..._definition_*` function either: those six serve the declaration.
  assert.equal(/DROP FUNCTION "project_acceptance_definition/.test(statements), false);
});

test('0150 and 0172 are immutable, and still say what they installed', () => {
  // The migrations that PUT the gate on the schema are append-only history: 0229 removes the
  // objects, and cannot remove the record of them having existed.
  const gate = readFileSync(
    path.join(API, 'prisma/migrations/0150_task_provenance_project_acceptance_epoch/migration.sql'),
    'utf8',
  );
  for (const trigger of ['project_acceptance_done_gate', 'project_acceptance_advance_epoch',
    'project_acceptance_epoch_audit']) {
    assert.match(gate, new RegExp(`CREATE TRIGGER "${trigger}"`));
    assert.match(REMOVAL, new RegExp(`DROP TRIGGER "${trigger}" ON "project"`),
      `${trigger} was installed by 0150 and must be dropped by name`);
  }
  const structured = readFileSync(
    path.join(API, 'prisma/migrations/0172_structured_project_acceptance_criteria/migration.sql'),
    'utf8',
  );
  assert.match(structured, /project_acceptance_criteria_fact/u,
    '0172 is where the criteria fact trigger got its structured body');
  assert.match(REMOVAL, /DROP TRIGGER "project_acceptance_criteria_fact" ON "project"/u);
});

test('the blocker count the gate used to make is gone with the gate', () => {
  assert.equal(SERVICE.includes('openBlockers'), false);
  assert.equal(SERVICE.includes('project_judgment_blocker'), false);
  assert.equal(SERVICE.includes('project_blocker'), false);
});
