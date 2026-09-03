import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TaskCompletionCriterion } from '@prisma/client';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { sha256 } from './project-acceptance';

// What is left of ProjectAcceptanceService after migration 0229 removed the project acceptance
// JUDGMENT: reading the authored criteria, refreshing the completion-contract digests, and
// recording what a target branch was observed to contain. Nothing here concludes anything.

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-000000000101';
const CRITERION_A_ID = '00000000-0000-7000-8000-000000000301';
const CRITERION_B_ID = '00000000-0000-7000-8000-000000000302';

function definition(id: string, ordinal: number, text: string, revision = 1) {
  return {
    id,
    ordinal,
    text,
    verificationMethod: `Verify exactly: ${text}`,
    completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    evidenceTaskId: null,
    completionCriterionOverrideReason: null,
    revision,
    contentHash: sha256(text),
  };
}

test('criteriaSummary reports the authored criteria in stated order, and no verdict', async () => {
  const definitions = [
    definition(CRITERION_B_ID, 2, 'The image boots'),
    definition(CRITERION_A_ID, 1, 'Build succeeds'),
  ];
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => definitions },
  };

  const summary = await new ProjectAcceptanceService(prisma as never).criteriaSummary(PROJECT_ID);

  assert.equal(summary.total, 2);
  assert.deepEqual(summary.criteria.map((c) => c.text), ['Build succeeds', 'The image boots']);
  assert.deepEqual(summary.criteria.map((c) => c.ordinal), [1, 2]);
  assert.deepEqual(summary.criteria.map((c) => c.id), [CRITERION_A_ID, CRITERION_B_ID]);
  // The shape carries no verdict, no pass count and no last-judged time. A field that would read
  // the same thing forever is a projection of nothing, and 0229's whole point is that nothing
  // evaluates these.
  for (const criterion of summary.criteria as unknown as Array<Record<string, unknown>>) {
    for (const gone of ['verdict', 'summary', 'decidedAt', 'evidenceTaskId']) {
      assert.equal(gone in criterion, false, `${gone} survives on a criterion standing`);
    }
  }
  assert.equal('passed' in summary, false);
  assert.equal('lastRunAt' in summary, false);
});

// A test double with no definition delegate is a unit fixture, not a project with no criteria;
// answering "none stated" for it is the honest reading either way, and it must not throw.
test('criteriaSummary answers an empty set when the definition delegate is absent', async () => {
  const summary = await new ProjectAcceptanceService({} as never).criteriaSummary(PROJECT_ID);
  assert.deepEqual(summary, { total: 0, criteria: [] });
});

test('recordMergeEvidence refuses a commit SHA where a content digest belongs', async () => {
  const service = new ProjectAcceptanceService({
    $transaction: async () => assert.fail('a malformed observation must not open a transaction'),
  } as never);
  await assert.rejects(
    () => service.recordMergeEvidence(OWNER_ID, PROJECT_ID, {
      requirementId: 'r1',
      targetBranch: 'main',
      contentHash: 'abc1234',
    }),
    /sha256 hex digest of the observed CONTENT/,
  );
  await assert.rejects(
    () => service.recordMergeEvidence(OWNER_ID, PROJECT_ID, {
      requirementId: '  ',
      targetBranch: 'main',
      contentHash: 'a'.repeat(64),
    }),
    /requirementId and targetBranch are required/,
  );
});

// The removal, asserted against the file: a method that came back under the same name would be
// caught by the type checker, and one that came back under a new name would not.
test('the judging half of the acceptance service is gone', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../src/projects/project-acceptance.service.ts'), 'utf8');
  for (const gone of [
    'openRun', 'finalizeRun', 'reconcile', 'ensureEvidenceVersion', 'ensureCurrentEvidenceVersion',
    'assertDoneAllowed', 'evaluateGate', 'pendingInbox', 'overview', 'runRow', 'writeAudit',
    'AcceptanceRefusal', 'ACCEPTANCE_MISSING', 'ACCEPTANCE_BLOCKED', 'runIdempotencyKey',
    'projectAcceptanceRun', 'projectAcceptanceCriterion.', 'projectAcceptanceConclusion',
    'projectAcceptanceAudit', 'acceptanceEpoch', 'acceptedRunId', 'legacyAcceptedAt',
  ]) {
    assert.equal(source.includes(gone), false, `${gone} survives in project-acceptance.service.ts`);
  }
  // And the one relation it still reads is the declaration table, whose name differs from the
  // dropped per-run verdict table by one word.
  assert.ok(source.includes('projectAcceptanceCriterionDefinition'));
});
