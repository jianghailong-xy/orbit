import assert from 'node:assert/strict';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { test } from 'node:test';
import { ProjectAcceptanceVerdict, TaskCompletionCriterion } from '@prisma/client';
import { AcceptanceRefusal, ProjectAcceptanceService } from './project-acceptance.service';
import {
  ACCEPTANCE_DIGEST_VERSION,
  ACCEPTANCE_FINDING_ROUTING,
  ACCEPTANCE_MISSING,
  criteriaFromDefinitions,
  criteriaSemanticRevision,
  sha256,
} from './project-acceptance';

const OWNER_ID = '00000000-0000-7000-8000-000000000001';
const PROJECT_ID = '00000000-0000-7000-8000-000000000101';
const RUN_ID = '00000000-0000-7000-8000-000000000201';
const CRITERION_A_ID = '00000000-0000-7000-8000-000000000301';
const CRITERION_B_ID = '00000000-0000-7000-8000-000000000302';

function definition(id: string, ordinal: number, text: string, revision = 1) {
  return {
    id,
    ordinal,
    text,
    verificationMethod: `Verify exactly: ${text}`,
    completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
    acceptanceCommand: null,
    acceptanceExpectedExitCode: null,
    evidenceTaskId: null,
    completionCriterionOverrideReason: null,
    revision,
    contentHash: sha256(text),
  };
}

test('acceptance facts omit task state while retaining an empty mechanical-evidence projection', async () => {
  const definitions = [definition(CRITERION_A_ID, 1, 'Build succeeds')];
  const prisma = {
    project: { findUnique: async () => ({ acceptanceCriteria: '1. Build succeeds' }) },
    projectAcceptanceCriterionDefinition: { findMany: async () => definitions },
    $queryRaw: async () => [{
      requirementId: 'release-artifact',
      targetBranch: 'main',
      contentHash: 'a'.repeat(64),
      refGeneration: 2n,
    }],
    // No EXECUTABLE criterion means no task delegate is needed. Adding task backlog/status state
    // back to `facts()` would still make this spec fail.
  };

  const result = await new ProjectAcceptanceService(prisma as never)
    .facts(prisma as never, PROJECT_ID);

  assert.deepEqual(result, {
    criteriaRevision: criteriaSemanticRevision(definitions),
    mergeEvidence: [['release-artifact', 'main', 'a'.repeat(64), '2']],
    executableAttempts: [],
  });
});

test('a non-PASS gate refusal names the exact acceptance criterion and routing rule', async () => {
  const definitions = [
    definition(CRITERION_A_ID, 1, 'Build succeeds'),
    definition(CRITERION_B_ID, 2, 'Image boots'),
  ];
  let rawRead = 0;
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => definitions },
    projectAcceptanceConclusion: {
      findMany: async () => [
        {
          id: 'event-a', criterionKey: sha256('Build succeeds').slice(0, 32),
          definitionId: CRITERION_A_ID,
          definitionRevision: 1, verdict: ProjectAcceptanceVerdict.PASS, summary: null,
          evidence: {}, evidenceTaskId: null, evidenceSessionId: null,
          decidedAt: new Date('2026-08-24T12:00:00.000Z'), evidenceVersion: 1n,
        },
        {
          id: 'event-b', criterionKey: sha256('Image boots').slice(0, 32),
          definitionId: CRITERION_B_ID,
          definitionRevision: 1, verdict: ProjectAcceptanceVerdict.FAIL, summary: null,
          evidence: {}, evidenceTaskId: null, evidenceSessionId: null,
          decidedAt: new Date('2026-08-24T12:00:00.000Z'), evidenceVersion: 1n,
        },
      ],
      createMany: async () => ({ count: 0 }),
    },
    $queryRaw: async () => {
      rawRead += 1;
      return [{ count: 0 }];
    },
    projectAcceptanceRun: {
      findFirst: async () => ({ id: RUN_ID, attempt: 1n }),
    },
    project: {
      findUnique: async () => ({ acceptanceCriteria: 'legacy' }),
      findUniqueOrThrow: async () => ({ acceptanceCriteria: 'legacy' }),
    },
    // Intentionally no `task` delegate: task completion cannot make this refusal disappear.
  };

  await assert.rejects(
    () => new ProjectAcceptanceService(prisma as never).assertDoneAllowed(prisma as never, PROJECT_ID),
    (error: unknown) => {
      assert.ok(error instanceof AcceptanceRefusal);
      const body = error.getResponse() as Record<string, unknown>;
      assert.equal(body.code, ACCEPTANCE_MISSING);
      assert.match(String(body.message), /#2 \"Image boots\" \(FAIL\)/);
      assert.match(String(body.message), /changes an acceptance criterion/);
      assert.deepEqual(body.unmetCriteria, [{
        ordinal: 2,
        criterionKey: sha256('Image boots').slice(0, 32),
        criterionText: 'Image boots',
        verdict: 'FAIL',
      }]);
      assert.ok(rawRead >= 1, 'the blocker/verification-failure counts are read at the gate');
      return true;
    },
  );
});
test('criteriaSummary remaps a matching run by stable id after a pure reorder', async () => {
  const current = [
    definition(CRITERION_B_ID, 1, 'Image boots'),
    definition(CRITERION_A_ID, 2, 'Build succeeds'),
  ];
  const lookedAt = new Date('2026-08-24T12:00:00.000Z');
  const latest = {
    digestVersion: ACCEPTANCE_DIGEST_VERSION,
    criteriaRevision: criteriaSemanticRevision(criteriaFromDefinitions(current)),
    completedAt: lookedAt,
    startedAt: new Date('2026-08-24T11:00:00.000Z'),
    criteria: [
      {
        id: 'run-a', definitionId: CRITERION_A_ID, criterionKey: sha256('Build succeeds').slice(0, 32),
        verdict: ProjectAcceptanceVerdict.PASS, summary: 'built', decidedAt: lookedAt,
        evidenceTaskId: null,
      },
      {
        id: 'run-b', definitionId: CRITERION_B_ID, criterionKey: sha256('Image boots').slice(0, 32),
        verdict: ProjectAcceptanceVerdict.FAIL, summary: 'no prompt', decidedAt: lookedAt,
        evidenceTaskId: null,
      },
    ],
  };
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => current },
    projectAcceptanceRun: { findFirst: async () => latest },
  };

  const summary = await new ProjectAcceptanceService(prisma as never)
    .criteriaSummary(PROJECT_ID, 'legacy projection');

  assert.equal(summary.lastRunAt, lookedAt);
  assert.equal(summary.passed, 1);
  assert.deepEqual(summary.criteria.map((criterion) => ({
    id: criterion.id,
    ordinal: criterion.ordinal,
    text: criterion.text,
    verdict: criterion.verdict,
  })), [
    { id: CRITERION_B_ID, ordinal: 1, text: 'Image boots', verdict: 'FAIL' },
    { id: CRITERION_A_ID, ordinal: 2, text: 'Build succeeds', verdict: 'PASS' },
  ]);
});

test('criteriaSummary does not reuse verdicts after the criterion proposition changed', async () => {
  const current = [definition(CRITERION_A_ID, 1, 'Build succeeds with docs', 2)];
  const lookedAt = new Date('2026-08-24T12:00:00.000Z');
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => current },
    projectAcceptanceRun: {
      findFirst: async () => ({
        digestVersion: ACCEPTANCE_DIGEST_VERSION,
        criteriaRevision: criteriaSemanticRevision(criteriaFromDefinitions([
          definition(CRITERION_A_ID, 1, 'Build succeeds'),
        ])),
        completedAt: lookedAt,
        startedAt: new Date('2026-08-24T11:00:00.000Z'),
        criteria: [{
          id: 'run-a', definitionId: CRITERION_A_ID,
          criterionKey: sha256('Build succeeds').slice(0, 32),
          verdict: ProjectAcceptanceVerdict.PASS, summary: 'old wording', decidedAt: lookedAt,
          evidenceTaskId: null,
        }],
      }),
    },
  };

  const summary = await new ProjectAcceptanceService(prisma as never)
    .criteriaSummary(PROJECT_ID, 'legacy projection');

  assert.equal(summary.lastRunAt, lookedAt, 'stale history is not the same as never run');
  assert.equal(summary.passed, 0);
  assert.equal(summary.criteria[0]?.verdict, 'UNDECIDED');
  assert.equal(summary.criteria[0]?.summary, null);
});

test('criteriaSummary keeps matching pre-v4 conclusions readable without upgrading their gate', async () => {
  const current = [
    definition(CRITERION_A_ID, 1, 'Build succeeds'),
    definition(CRITERION_B_ID, 2, 'Image boots'),
  ];
  const lookedAt = new Date('2026-08-24T12:00:00.000Z');
  const prisma = {
    projectAcceptanceCriterionDefinition: { findMany: async () => current },
    projectAcceptanceRun: {
      findFirst: async () => ({
        digestVersion: 2,
        // The old shape is intentionally unrelated to the new semantic revision.
        criteriaRevision: 'f'.repeat(64),
        completedAt: lookedAt,
        startedAt: new Date('2026-08-24T11:00:00.000Z'),
        criteria: [
          {
            id: 'legacy-a', definitionId: null,
            criterionKey: sha256('Build succeeds').slice(0, 32), criterionText: 'Build succeeds',
            verdict: ProjectAcceptanceVerdict.PASS, summary: 'historical build', decidedAt: lookedAt,
            evidenceTaskId: null,
          },
          {
            id: 'legacy-b', definitionId: null,
            criterionKey: sha256('Image boots').slice(0, 32), criterionText: 'Image boots',
            verdict: ProjectAcceptanceVerdict.PASS, summary: 'historical boot', decidedAt: lookedAt,
            evidenceTaskId: null,
          },
        ],
      }),
    },
  };

  const summary = await new ProjectAcceptanceService(prisma as never)
    .criteriaSummary(PROJECT_ID, '1. Build succeeds\n2. Image boots');

  assert.equal(summary.passed, 2);
  assert.equal(summary.lastRunAt, lookedAt);
  assert.deepEqual(summary.criteria.map((criterion) => criterion.summary), [
    'historical build', 'historical boot',
  ]);
});

test('openRun freezes definition identity, revision and text into both snapshot shapes', async () => {
  const definitions = [
    definition(CRITERION_A_ID, 1, 'Build succeeds', 2),
    definition(CRITERION_B_ID, 2, 'Image boots', 1),
  ];
  let rawReads = 0;
  let createdRun: any;
  let createdCriteria: any[] = [];
  let storedRun: any;
  const prisma: any = {
    $queryRaw: async () => {
      rawReads += 1;
      if (rawReads === 1) {
        return [{
          id: PROJECT_ID,
          status: 'OPEN',
          acceptedRunId: null,
          legacyAcceptedAt: null,
          acceptanceCriteria: 'old projection',
        }];
      }
      return [];
    },
    project: {
      findUnique: async () => ({ acceptanceCriteria: 'old projection' }),
    },
    projectAcceptanceCriterionDefinition: {
      findMany: async () => definitions,
    },
    projectRuntime: {
      upsert: async () => ({ acceptanceAttempt: 4n }),
      update: async () => undefined,
    },
    projectAcceptanceRun: {
      updateMany: async () => ({ count: 0 }),
      create: async (args: any) => {
        createdRun = args.data;
        storedRun = {
          id: RUN_ID,
          ...args.data,
          acceptanceEpoch: 0n,
          resultDigest: null,
          verdict: null,
          supersededAt: null,
          supersededReason: null,
          startedAt: new Date('2026-08-24T12:00:00.000Z'),
          completedAt: null,
        };
        return storedRun;
      },
      findUniqueOrThrow: async () => ({
        ...storedRun,
        criteria: createdCriteria.map((criterion, index) => ({
          id: `run-criterion-${index}`,
          ...criterion,
          verdict: null,
          summary: null,
          evidence: {},
          evidenceTaskId: null,
          evidenceSessionId: null,
          decidedAt: null,
        })),
      }),
    },
    projectAcceptanceCriterion: {
      createMany: async (args: any) => { createdCriteria = args.data; },
    },
    projectAcceptanceAudit: { create: async () => undefined },
  };
  prisma.$transaction = async (fn: (tx: any) => unknown) => fn(prisma);

  const opened: any = await new ProjectAcceptanceService(prisma)
    .openRun(OWNER_ID, PROJECT_ID, { decidedBy: 'COORDINATOR_AGENT' });

  assert.equal(createdRun.criteriaSnapshot, '1. Build succeeds\n2. Image boots');
  assert.deepEqual(createdRun.criteriaSnapshotV2, [
    {
      id: CRITERION_A_ID, revision: 2, ordinal: 1, text: 'Build succeeds',
      verificationMethod: 'Verify exactly: Build succeeds',
      completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
      evidenceTaskId: null,
      contentHash: sha256('Build succeeds'),
    },
    {
      id: CRITERION_B_ID, revision: 1, ordinal: 2, text: 'Image boots',
      verificationMethod: 'Verify exactly: Image boots',
      completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
      acceptanceCommand: null,
      acceptanceExpectedExitCode: null,
      evidenceTaskId: null,
      contentHash: sha256('Image boots'),
    },
  ]);
  assert.deepEqual(createdCriteria.map(({ definitionId, definitionRevision, criterionText }) => ({
    definitionId, definitionRevision, criterionText,
  })), [
    { definitionId: CRITERION_A_ID, definitionRevision: 2, criterionText: 'Build succeeds' },
    { definitionId: CRITERION_B_ID, definitionRevision: 1, criterionText: 'Image boots' },
  ]);
  assert.deepEqual(opened.criteria.map((criterion: any) => ({
    criterionId: criterion.criterionId,
    definitionRevision: criterion.definitionRevision,
    verificationMethod: criterion.verificationMethod,
  })), [
    {
      criterionId: CRITERION_A_ID,
      definitionRevision: 2,
      verificationMethod: 'Verify exactly: Build succeeds',
    },
    {
      criterionId: CRITERION_B_ID,
      definitionRevision: 1,
      verificationMethod: 'Verify exactly: Image boots',
    },
  ]);
});

test('pendingInbox returns current project acceptance beside task judgments without deriving a verdict', async () => {
  const startedAt = new Date('2026-08-27T08:00:00.000Z');
  let sql = '';
  const prisma = {
    $queryRaw: async (...args: unknown[]) => {
      sql = renderRawQuery(args).text;
      return [{
        runId: RUN_ID,
        projectId: PROJECT_ID,
        projectTitle: 'Project acceptance needs a person',
        projectStatus: 'OPEN',
        attempt: 4n,
        startedAt,
      criterionCount: 10,
      humanCriterionCount: 10,
      unansweredCount: 10,
      criteriaDeclared: true,
        total: 1,
      }];
    },
  };

  const inbox = await new ProjectAcceptanceService(prisma as never).pendingInbox(OWNER_ID, 25);

  assert.deepEqual(inbox, {
    total: 1,
    items: [{
      runId: RUN_ID,
      projectId: PROJECT_ID,
      projectTitle: 'Project acceptance needs a person',
      projectStatus: 'OPEN',
      attempt: '4',
      startedAt,
      criterionCount: 10,
      humanCriterionCount: 10,
      answeredCount: 0,
      unansweredCount: 10,
      criteriaDeclared: true,
      currentVerdict: 'UNDECIDED',
    }],
  });
  assert.match(sql, /project_acceptance_conclusion/);
  assert.match(sql, /evidence_version/);
  assert.match(sql, /definition_revision/);
});

test('finalizeRun rejects a partial checklist and names every missing ordinal', async () => {
  const prisma: any = {
    $queryRaw: async () => [{
      id: PROJECT_ID,
      status: 'OPEN',
      acceptedRunId: null,
      legacyAcceptedAt: null,
      acceptanceCriteria: '1. Build succeeds\n2. Image boots',
    }],
    projectAcceptanceRun: {
      findFirst: async () => ({
        id: RUN_ID,
        projectId: PROJECT_ID,
        verdict: null,
        criteria: [
          {
            ordinal: 1, criterionKey: 'build', criterionText: 'Build succeeds',
            completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
          },
          {
            ordinal: 2, criterionKey: 'boot', criterionText: 'Image boots',
            completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
          },
        ],
      }),
    },
    projectAcceptanceCriteriaConfirmation: { findUnique: async () => ({ id: 'confirmed' }) },
  };
  prisma.$transaction = async (work: (tx: any) => unknown) => work(prisma);

  await assert.rejects(
    () => new ProjectAcceptanceService(prisma).finalizeRun(
      OWNER_ID,
      PROJECT_ID,
      RUN_ID,
      [{ ordinal: 1, verdict: ProjectAcceptanceVerdict.INCONCLUSIVE }],
    ),
    /criteria 2 have no conclusion — every stated criterion must be judged/,
  );
});

test('evaluateGate digests a large project once and gives that read explicit scale headroom', async () => {
  let digestReads = 0;
  let transactionOptions: unknown;
  const tx = {
    project: { findUniqueOrThrow: async () => ({ acceptanceCriteria: 'legacy' }) },
    projectAcceptanceRun: { findFirst: async () => null },
    $queryRaw: async () => [{ count: 0 }],
  };
  const prisma = {
    $transaction: async (work: (client: typeof tx) => unknown, options: unknown) => {
      transactionOptions = options;
      return work(tx);
    },
  };
  const service = new ProjectAcceptanceService(prisma as never);
  service.digest = async () => {
    digestReads += 1;
    return 'current-digest';
  };

  const evaluated = await service.evaluateGate(PROJECT_ID);

  assert.equal(digestReads, 1, 'the overview must not materialize and hash every task twice');
  assert.deepEqual(transactionOptions, { timeout: 30_000, maxWait: 10_000 });
  assert.deepEqual(evaluated, {
    digest: 'current-digest',
    allowed: false,
    runId: null,
    code: ACCEPTANCE_MISSING,
    reason:
      'this project has no current evidence version — evaluate the current evidence set once ' +
      'before recording DONE. ' + ACCEPTANCE_FINDING_ROUTING,
  });
});
