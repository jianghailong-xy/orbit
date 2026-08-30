import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  ExecutableAcceptanceAdmissionDecision,
  ExecutableAcceptanceTerminationKind,
  PrismaClient,
  ProjectAcceptanceVerdict,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  TaskCompletionCriterion,
  TaskJudgmentDecision,
  TaskJudgmentRecipientType,
  TaskJudgmentRequestStatus,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { establishCanonicalClosedEvaluationForPgTest } from '../outcome-reconciler/outcome-closed-test-helper';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { EXECUTABLE_ATTEMPT_COLLECTOR_VERSION } from './project-acceptance';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
async function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

async function connect() {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
  return {
    db,
    acceptance,
    projects: new ProjectsService(db as unknown as PrismaService, acceptance),
  };
}

async function base(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@project-criterion.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: `Prove the ${label} criterion automation boundary`,
    },
  });
  return { ownerId, projectId };
}

async function task(
  db: PrismaClient,
  target: { ownerId: string; projectId: string },
  title: string,
  data: Record<string, unknown> = {},
) {
  return db.task.create({
    data: {
      id: randomUUID(),
      ownerId: target.ownerId,
      projectId: target.projectId,
      title,
      creatorType: CreatorType.USER,
      creatorId: target.ownerId,
      status: TaskStatus.OPEN,
      ...data,
    },
  });
}

async function recordExecutableResult(
  db: PrismaClient,
  target: { ownerId: string },
  taskId: string,
  command: string,
  expectedExitCode: number,
  actualExitCode: number,
  sequence: number,
) {
  const sourceSessionId = randomUUID();
  const evidence = await db.taskCompletionEvidence.create({
    data: {
      id: randomUUID(),
      taskId,
      ownerId: target.ownerId,
      actorType: CreatorType.USER,
      actorId: target.ownerId,
      sourceSessionId,
      criterionRevision: sequence.toString(16).padStart(64, 'a').slice(-64),
      criterion: {
        schemaVersion: 1,
        completionCriterion: TaskCompletionCriterion.EXECUTABLE,
        acceptanceCommand: command,
        acceptanceExpectedExitCode: expectedExitCode,
      },
      evidence: { command, actualExitCode },
      evidenceDigest: sequence.toString(16).padStart(64, 'b').slice(-64),
      revision: BigInt(sequence),
      submittedAt: new Date(`2026-08-27T10:00:0${sequence}.000Z`),
    },
  });
  const decidedAt = new Date(`2026-08-27T10:00:1${sequence}.000Z`);
  const request = await db.taskJudgmentRequest.create({
    data: {
      id: randomUUID(),
      taskId,
      ownerId: target.ownerId,
      evidenceId: evidence.id,
      criterionRevision: evidence.criterionRevision,
      evidenceDigest: evidence.evidenceDigest,
      kind: TaskCompletionCriterion.EXECUTABLE,
      recipientType: TaskJudgmentRecipientType.SYSTEM_EXECUTABLE_EVALUATOR,
      recipientId: sourceSessionId,
      status: TaskJudgmentRequestStatus.OPEN,
      createdAt: new Date(`2026-08-27T10:00:0${sequence}.500Z`),
    },
  });
  const result = await db.taskExecutableJudgmentResult.create({
    data: {
      id: randomUUID(),
      requestId: request.id,
      command,
      expectedExitCode,
      actualExitCode,
      rawOutput: `raw output ${sequence}: exit ${actualExitCode}`,
      recordedById: randomUUID(),
      recordedAt: decidedAt,
    },
  });
  await db.taskJudgmentRequest.update({
    where: { id: request.id },
    data: {
      status: TaskJudgmentRequestStatus.DECIDED,
      decidedAt,
      decidedByType: 'SYSTEM',
      decidedById: randomUUID(),
      decision: actualExitCode === expectedExitCode
        ? TaskJudgmentDecision.PASS
        : TaskJudgmentDecision.FAIL,
    },
  });
  return result;
}

async function declare(
  projects: ProjectsService,
  target: { ownerId: string; projectId: string },
  item: Record<string, unknown>,
) {
  return projects.update(target.ownerId, target.projectId, {
    acceptanceCriteriaItems: [item],
  } as never);
}

async function recordTypedExecutableSuccess(
  db: PrismaClient,
  target: { ownerId: string },
  runnerId: string,
  taskId: string,
  sequence: number,
) {
  const executable = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: {
      acceptanceTimeoutSeconds: true,
      acceptanceOwnerTimeoutCeilingSeconds: true,
      acceptancePolicyTimeoutCeilingSeconds: true,
      acceptanceSchemaRevision: true,
      acceptanceCapabilityRevision: true,
      acceptanceCommandDigest: true,
      acceptanceEvaluationPlanDigest: true,
      acceptanceExpectedExitCode: true,
    },
  });
  assert.ok(executable.acceptanceTimeoutSeconds);
  assert.ok(executable.acceptanceOwnerTimeoutCeilingSeconds);
  assert.ok(executable.acceptancePolicyTimeoutCeilingSeconds);
  assert.ok(executable.acceptanceSchemaRevision);
  assert.ok(executable.acceptanceCapabilityRevision);
  assert.ok(executable.acceptanceCommandDigest);
  assert.ok(executable.acceptanceEvaluationPlanDigest);
  assert.notEqual(executable.acceptanceExpectedExitCode, null);

  const sessionId = randomUUID();
  const turnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: target.ownerId,
      creatorId: target.ownerId,
      taskId,
      assignedRunnerId: runnerId,
      title: `late executable evidence ${sequence}`,
      prompt: 'Record the declared acceptance command result.',
      provider: 'codex',
      status: RunStatus.AWAITING_INPUT,
    },
  });
  const deadline = new Date(`2026-08-29T20:0${sequence}:00.000Z`);
  const admission = await db.taskExecutableAdmission.create({
    data: {
      id: randomUUID(),
      taskId,
      sessionId,
      turnId,
      runnerId,
      evaluationPlanDigest: executable.acceptanceEvaluationPlanDigest,
      commandDigest: executable.acceptanceCommandDigest,
      expectedExitCode: executable.acceptanceExpectedExitCode!,
      requestedTimeoutSeconds: executable.acceptanceTimeoutSeconds,
      ownerTimeoutCeilingSeconds: executable.acceptanceOwnerTimeoutCeilingSeconds,
      policyTimeoutCeilingSeconds: executable.acceptancePolicyTimeoutCeilingSeconds,
      requiredSchemaRevision: executable.acceptanceSchemaRevision,
      requiredCapabilityRevision: executable.acceptanceCapabilityRevision,
      runnerSchemaRevision: executable.acceptanceSchemaRevision,
      runnerCapabilityRevision: executable.acceptanceCapabilityRevision,
      runnerHardMaxSeconds: executable.acceptanceOwnerTimeoutCeilingSeconds,
      runnerSha: sequence.toString(16).repeat(40).slice(0, 40),
      decision: ExecutableAcceptanceAdmissionDecision.ADMITTED,
      effectiveTimeoutSeconds: executable.acceptanceTimeoutSeconds,
      effectiveDeadline: deadline,
      decidedAt: new Date(`2026-08-29T19:0${sequence}:00.000Z`),
    },
  });
  const attempt = await db.taskExecutableAttempt.create({
    data: {
      id: randomUUID(),
      admissionId: admission.id,
      taskId,
      sessionId,
      turnId,
      evaluationPlanDigest: executable.acceptanceEvaluationPlanDigest,
      expectedExitCode: executable.acceptanceExpectedExitCode,
      deadlineAt: deadline,
      startedAt: new Date(`2026-08-29T19:1${sequence}:00.000Z`),
    },
  });
  const terminated = await db.taskExecutableAttempt.update({
    where: { id: attempt.id },
    data: {
      terminatedAt: new Date(`2026-08-29T19:2${sequence}:00.000Z`),
      terminationKind: ExecutableAcceptanceTerminationKind.EXITED,
      actualExitCode: executable.acceptanceExpectedExitCode,
      rawOutput: `typed attempt ${sequence}: all assertions passed`,
    },
  });
  await db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  return terminated;
}

test('late typed attempts advance the evidence version and back all four wired EXECUTABLE criteria',
  { skip }, async () => {
    const { db, acceptance, projects } = await connect();
    try {
      const target = await base(db, 'late-typed-attempts');
      const runner = await db.runner.create({
        data: {
          id: randomUUID(),
          ownerId: target.ownerId,
          name: 'late-typed-attempts-runner',
          tokenHash: randomUUID(),
          status: RunnerStatus.ONLINE,
          acceptanceRuntimeSchemaRevision: 2,
          acceptanceRuntimeCapabilityRevision: 2,
          acceptanceRuntimeHardMaxSeconds: 300,
          acceptanceRuntimeReportedAt: new Date('2026-08-29T19:00:00.000Z'),
        },
      });
      const declarations = [
        ['npm test -w @orbit/shared', 0],
        ['npm test -w @orbit/apiserver', 0],
        ['cd src/runner-go && go test ./...', 0],
        ['cd src/macos/OrbitKit && swift test', 0],
      ] as const;
      const sources = [];
      for (const [index, [command, expectedExitCode]] of declarations.entries()) {
        sources.push(await task(db, target, `evidence task ${index + 1}`, {
          completionCriterion: TaskCompletionCriterion.EXECUTABLE,
          acceptanceCommand: command,
          acceptanceExpectedExitCode: expectedExitCode,
          acceptanceTimeoutSeconds: 120,
          acceptanceOwnerTimeoutCeilingSeconds: 300,
          acceptancePolicyTimeoutCeilingSeconds: 300,
          acceptanceSchemaRevision: 2,
          acceptanceCapabilityRevision: 2,
        }));
      }
      await projects.update(target.ownerId, target.projectId, {
        acceptanceCriteriaItems: sources.map((source, index) => ({
          text: `Executable criterion ${index + 1} is satisfied`,
          verificationMethod: 'Read the exact typed attempt termination and raw output.',
          completionCriterion: TaskCompletionCriterion.EXECUTABLE,
          acceptanceCommand: declarations[index]![0],
          acceptanceExpectedExitCode: declarations[index]![1],
          evidenceTaskId: source.id,
        })),
      } as never);
      await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
        actorType: 'USER', actorId: target.ownerId,
      });

      const openedBeforeEvidence = await acceptance.openRun(
        target.ownerId,
        target.projectId,
        { decidedBy: 'USER' },
      );
      assert.equal(openedBeforeEvidence.evidenceVersion, '0');
      await acceptance.reconcile(target.ownerId, target.projectId);
      let overview = await acceptance.overview(target.ownerId, target.projectId);
      assert.deepEqual(
        overview.runs[0]?.criteria.map((criterion) => criterion.verdict),
        Array(4).fill(ProjectAcceptanceVerdict.INCONCLUSIVE),
      );
      assert.deepEqual(
        (overview.ownerRatification.evaluationPlan as { collectorVersions?: string[] })
          .collectorVersions,
        [EXECUTABLE_ATTEMPT_COLLECTOR_VERSION],
      );
      const criteriaRevision = overview.runs[0]!.criteriaRevision;
      const criteriaDigest = overview.criteriaDigest;
      const initialConclusionIds = new Set(overview.runs[0]!.conclusions.map((event) => event.id));

      const attempts = [];
      for (const [index, source] of sources.entries()) {
        attempts.push(await recordTypedExecutableSuccess(
          db, target, runner.id, source.id, index + 1,
        ));
        assert.equal(
          await db.taskExecutableJudgmentResult.count({
            where: { request: { taskId: source.id } },
          }),
          0,
          'the typed attempt is canonical without manufacturing a legacy judgment result',
        );
        await acceptance.reconcileForEvidenceTask(source.id);
        overview = await acceptance.overview(target.ownerId, target.projectId);
        assert.equal(overview.runs[0]?.evidenceVersion, String(index + 1));
        assert.equal(overview.runs[0]?.criteriaRevision, criteriaRevision);
        assert.equal(
          overview.runs[0]?.criteria.filter(
            (criterion) => criterion.verdict === ProjectAcceptanceVerdict.PASS,
          ).length,
          index + 1,
        );
      }

      const latest = overview.runs[0]!;
      assert.deepEqual(
        latest.criteria.map((criterion) => criterion.verdict),
        Array(4).fill(ProjectAcceptanceVerdict.PASS),
      );
      assert.deepEqual(
        latest.criteria.map((criterion) => {
          const evidence = criterion.evidence as {
            kind?: string; collectorVersion?: string; attemptId?: string;
          };
          return [evidence.kind, evidence.collectorVersion, evidence.attemptId];
        }),
        attempts.map((attempt) => [
          'EXECUTABLE_ATTEMPT', EXECUTABLE_ATTEMPT_COLLECTOR_VERSION, attempt.id,
        ]),
      );
      assert.equal(overview.criteriaDigest, criteriaDigest, 'attempt facts do not rewrite criteria');
      assert.equal(overview.runs.length, 5, 'version 0 plus one immutable version per later fact');
      assert.ok(overview.runs.slice(1).every((run) => run.supersededAt instanceof Date));
      assert.ok(
        [...initialConclusionIds].every((id) => latest.conclusions.some((event) => event.id === id)),
        'the version-0 INCONCLUSIVE events remain in the append-only ledger',
      );
      assert.equal(overview.status, ProjectStatus.OPEN, 'canonical DONE proof remains fail-closed');
    } finally {
      await db.$disconnect();
    }
  });

test('EXECUTABLE is declared explicitly and follows the matching command exit code', { skip }, async () => {
  const { db, acceptance, projects } = await connect();
  try {
    const target = await base(db, 'executable');
    const source = await task(db, target, 'run the release command', {
      completionCriterion: TaskCompletionCriterion.EXECUTABLE,
      acceptanceCommand: 'npm test',
      acceptanceExpectedExitCode: 0,
    });
    await declare(projects, target, {
      text: '验收命令退出码与预期一致',
      verificationMethod: 'Read the exact durable command result and raw output',
      completionCriterion: TaskCompletionCriterion.EXECUTABLE,
      acceptanceCommand: 'npm test',
      acceptanceExpectedExitCode: 0,
      evidenceTaskId: source.id,
    });
    await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
      actorType: 'USER', actorId: target.ownerId,
    });
    await establishCanonicalClosedEvaluationForPgTest(
      db, target.ownerId, target.projectId, 'executable criterion passes', 'executable',
    );

    const run = await acceptance.openRun(
      target.ownerId,
      target.projectId,
      { decidedBy: 'USER' },
    );
    await assert.rejects(
      acceptance.finalizeRun(target.ownerId, target.projectId, run.id, [{
        criterionId: run.criteria[0]!.criterionId!,
        verdict: ProjectAcceptanceVerdict.PASS,
      }]),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(error.message, /evaluated automatically.*cannot submit a fallback human verdict/);
        return true;
      },
      'EXECUTABLE has no HUMAN_SIGNOFF fallback path',
    );

    await recordExecutableResult(db, target, source.id, 'npm test', 0, 7, 1);
    const failed = await acceptance.reconcileForEvidenceTask(source.id);
    assert.equal(failed, undefined);
    let overview = await acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs[0]?.criteria[0]?.verdict, ProjectAcceptanceVerdict.FAIL);
    assert.equal((overview.runs[0]?.criteria[0]?.evidence as { actualExitCode: number }).actualExitCode, 7);
    assert.equal(overview.status, ProjectStatus.OPEN);

    await recordExecutableResult(db, target, source.id, 'npm test', 0, 0, 2);
    await acceptance.reconcileForEvidenceTask(source.id);
    overview = await acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs[0]?.criteria[0]?.verdict, ProjectAcceptanceVerdict.PASS);
    assert.equal(overview.status, ProjectStatus.DONE);
    const doneAudit = overview.audit.find((entry) => entry.kind === 'done_bound');
    assert.equal((doneAudit?.detail as { source?: string }).source, 'AUTOMATIC_CRITERIA_EVALUATOR');
    assert.equal((doneAudit?.detail as { actorStatusWrite?: boolean }).actorStatusWrite, false);

    await assert.rejects(
      projects.update(
        target.ownerId,
        target.projectId,
        { status: ProjectStatus.DONE } as never,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal(
          (error.getResponse() as { code?: string }).code,
          'PROJECT_DONE_AUTOMATIC_ONLY',
        );
        return true;
      },
      'a credentialed subject cannot supply project.status=DONE',
    );
  } finally {
    await db.$disconnect();
  }
});

test('VERIFICATION follows only the independent verifier Task verdict', { skip }, async () => {
  const { db, acceptance, projects } = await connect();
  try {
    const target = await base(db, 'verification');
    const subject = await task(db, target, 'implementation under review');
    const verifier = await task(db, target, 'independent review', {
      verifiesTaskId: subject.id,
      completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
    });
    await declare(projects, target, {
      text: '独立复核确认实现符合意图',
      verificationMethod: 'Consume the independent verifier Task verdict',
      completionCriterion: TaskCompletionCriterion.VERIFICATION,
      evidenceTaskId: verifier.id,
    });
    await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
      actorType: 'USER', actorId: target.ownerId,
    });
    await establishCanonicalClosedEvaluationForPgTest(
      db, target.ownerId, target.projectId, 'verification criterion passes', 'verification',
    );
    let overview = await acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs[0]?.criteria[0]?.verdict, ProjectAcceptanceVerdict.INCONCLUSIVE);
    assert.equal(overview.status, ProjectStatus.OPEN);

    await db.task.update({ where: { id: verifier.id }, data: { verdict: TaskVerdict.FAIL } });
    await acceptance.reconcileForEvidenceTask(verifier.id);
    overview = await acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs[0]?.criteria[0]?.verdict, ProjectAcceptanceVerdict.FAIL);
    assert.equal(overview.status, ProjectStatus.OPEN);

    await db.task.update({ where: { id: verifier.id }, data: { verdict: TaskVerdict.PASS } });
    await acceptance.reconcileForEvidenceTask(verifier.id);
    overview = await acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs[0]?.criteria[0]?.verdict, ProjectAcceptanceVerdict.PASS);
    assert.equal(overview.status, ProjectStatus.DONE);
  } finally {
    await db.$disconnect();
  }
});

test('HUMAN_SIGNOFF waits for the human criterion conclusion after one set confirmation', { skip }, async () => {
  const { db, acceptance, projects } = await connect();
  try {
    const target = await base(db, 'human');
    await declare(projects, target, {
      text: '由 owner 判断发布取舍是否值得',
      verificationMethod: 'Owner reviews the release tradeoff',
      completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
    });
    const confirmation = await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
      actorType: 'USER', actorId: target.ownerId,
    });
    const ratification = await db.projectOwnerRatification.findUniqueOrThrow({
      where: { id: confirmation.id },
    });
    assert.equal(ratification.contractDigest, confirmation.criteriaDigest);
    assert.equal(
      await db.projectOwnerRatification.count({
        where: { projectId: target.projectId },
      }),
      1,
      'one contract ratification, not one approval per criterion',
    );
    await establishCanonicalClosedEvaluationForPgTest(
      db, target.ownerId, target.projectId, 'owner accepts the release tradeoff', 'human',
    );
    assert.equal(
      await db.project.findUniqueOrThrow({ where: { id: target.projectId } }).then((p) => p.status),
      ProjectStatus.OPEN,
    );

    const run = await acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    await acceptance.finalizeRun(target.ownerId, target.projectId, run.id, [{
      criterionId: run.criteria[0]!.criterionId!,
      verdict: ProjectAcceptanceVerdict.PASS,
      summary: 'Owner accepts this release tradeoff',
      evidence: { reviewedDigest: confirmation.criteriaDigest },
    }]);
    assert.equal(
      await db.project.findUniqueOrThrow({ where: { id: target.projectId } }).then((p) => p.status),
      ProjectStatus.DONE,
    );
  } finally {
    await db.$disconnect();
  }
});

test('structured project criteria reject a missing declaration instead of defaulting', { skip }, async () => {
  const { db, projects } = await connect();
  try {
    const target = await base(db, 'missing-declaration');
    await assert.rejects(
      declare(projects, target, {
        text: 'A declaration is mandatory',
        verificationMethod: 'No implicit fallback is allowed',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(error.message, /requires completionCriterion/);
        return true;
      },
    );
    assert.equal(
      await db.projectAcceptanceCriterionDefinition.count({ where: { projectId: target.projectId } }),
      0,
    );
  } finally {
    await db.$disconnect();
  }
});

test('the PostgreSQL target is a disposable database', { skip }, verifyDisposableDatabase);
