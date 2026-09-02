import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Consequence 2 of the 2026-09-02 removal, stated where somebody will read it.
 *
 * 0150's project acceptance gate took EXECUTABLE evidence from two places: 0200's typed attempt,
 * and — when there was no attempt — `task_executable_judgment_result`, the row the judgment
 * machinery wrote from a shell exit code. The second is gone. The gate is not: its four triggers,
 * its three tables and their rows are all outside this change, and what broke is exactly one read
 * path, which now returns INCONCLUSIVE and says why.
 *
 * The distinction is the whole point, so it is asserted on both sides.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

const SERVICE = read('src/apiserver/src/projects/project-acceptance.service.ts');

test('the removed read path is gone and was not repointed at another evidence source', () => {
  assert.doesNotMatch(SERVICE, /taskExecutableJudgmentResult/u);
  assert.doesNotMatch(SERVICE, /EXECUTABLE_RESULT_RECORDED/u);

  const start = SERVICE.indexOf(
    'criterion.completionCriterion === TaskCompletionCriterion.EXECUTABLE',
  );
  assert.ok(start > 0, 'the EXECUTABLE branch must still exist to be checked');
  const branch = SERVICE.slice(start, SERVICE.indexOf('const verifier =', start));
  // One evidence source, named once.
  assert.equal((branch.match(/canonicalExecutableAttempt/gu) ?? []).length, 1);
  // And no second one smuggled in: no other model accessor, no raw SQL, no service call.
  assert.doesNotMatch(branch, /\$queryRaw|\$executeRaw|Unsafe/u);
  assert.doesNotMatch(branch, /(?:tx|this\.prisma)\.[a-z]/u);
  assert.match(branch, /ProjectAcceptanceVerdict\.INCONCLUSIVE/u);
  assert.match(branch, /No matching recorded command result exists yet/u);
});

test('the gate itself, its triggers and its data are untouched', () => {
  // The service still reads and writes the three preserved tables.
  for (const relation of ['projectAcceptanceCriterionDefinition', 'projectAcceptanceCriterion',
    'projectAcceptanceConclusion', 'projectAcceptanceRun']) {
    assert.match(SERVICE, new RegExp(relation), `the gate stopped using ${relation}`);
  }
  // And the removal migration names none of them.
  const removal = readFileSync(
    path.join(API, 'prisma/migrations/0227_task_judgment_removal/migration.sql'), 'utf8',
  );
  const statements = removal.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  assert.doesNotMatch(statements, /project_acceptance/u,
    'no statement in the removal may name a project acceptance object');

  // 0150's and 0172's own migrations are immutable and still install the four triggers.
  const gate = readFileSync(
    path.join(API, 'prisma/migrations/0150_task_provenance_project_acceptance_epoch/migration.sql'),
    'utf8',
  );
  for (const trigger of ['project_acceptance_done_gate', 'project_acceptance_advance_epoch',
    'project_acceptance_epoch_audit']) {
    assert.match(gate, new RegExp(`CREATE TRIGGER "${trigger}"`));
  }
  const criteriaFact = readFileSync(
    path.join(API, 'prisma/migrations/0127_project_acceptance_run/migration.sql'), 'utf8',
  );
  assert.match(criteriaFact, /project_acceptance_criteria_fact/u);
  const structured = readFileSync(
    path.join(API, 'prisma/migrations/0172_structured_project_acceptance_criteria/migration.sql'),
    'utf8',
  );
  assert.match(structured, /project_acceptance_criteria_fact/u,
    '0172 is where the criteria fact trigger got its structured body');
});

test('the blocker count at the gate lost its judgment view and gained nothing', () => {
  const gate = SERVICE.slice(SERVICE.indexOf('assertDoneAllowedForDigest'));
  const query = gate.slice(gate.indexOf('const [{ count: openBlockers }]'));
  const statement = query.slice(0, query.indexOf('`);'));
  assert.doesNotMatch(statement, /project_judgment_blocker/u);
  assert.match(statement, /FROM "project_blocker" blocker/u);
  // Exactly one source, so nothing was substituted for the view.
  assert.equal((statement.match(/FROM "/gu) ?? []).length, 1);
});
