import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
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
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
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

// 0227 removed the typed attempt this used to record. The four criteria are now backed by the
// recorded command result of each evidence task, which was already the collector beside it — and
// that collector was never part of the acceptance input digest, so a later result no longer mints
// a new evidence version. It accumulates conclusions on the one live version instead, which is
// exactly the shape this project had before 0209 wired the attempt in. What is still checked: the
// criteria digest is untouched by result facts, the version-0 INCONCLUSIVE events stay in the
// append-only ledger, and four PASSes reach DONE.
test('late executable results back all four wired criteria on the one live evidence version',
  { skip }, async () => {
    const { db, acceptance, projects } = await connect();
    try {
      const target = await base(db, 'late-executable-results');
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
        }));
      }
      await projects.update(target.ownerId, target.projectId, {
        acceptanceCriteriaItems: sources.map((source, index) => ({
          text: `Executable criterion ${index + 1} is satisfied`,
          verificationMethod: 'Read the exact recorded command result and raw output.',
          completionCriterion: TaskCompletionCriterion.EXECUTABLE,
          acceptanceCommand: declarations[index]![0],
          acceptanceExpectedExitCode: declarations[index]![1],
          evidenceTaskId: source.id,
        })),
      } as never);
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
      const criteriaRevision = overview.runs[0]!.criteriaRevision;
      const criteriaDigest = overview.criteriaDigest;
      const initialConclusionIds = new Set(overview.runs[0]!.conclusions.map((event) => event.id));

      const results = [];
      for (const [index, source] of sources.entries()) {
        results.push(await recordExecutableResult(
          db, target, source.id, declarations[index]![0], 0, 0, index + 1,
        ));
        await db.task.update({ where: { id: source.id }, data: { status: TaskStatus.DONE } });
        await acceptance.reconcileForEvidenceTask(source.id);
        overview = await acceptance.overview(target.ownerId, target.projectId);
        assert.equal(overview.runs[0]?.evidenceVersion, '0',
          'a recorded command result is not part of the acceptance input digest');
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
          const evidence = criterion.evidence as { kind?: string; resultId?: string };
          return [evidence.kind, evidence.resultId];
        }),
        results.map((result) => ['EXECUTABLE_RESULT', result.id]),
      );
      assert.equal(overview.criteriaDigest, criteriaDigest, 'result facts do not rewrite criteria');
      assert.equal(overview.runs.length, 1, 'the one live evidence version, never superseded');
      assert.equal(overview.runs[0]?.supersededAt, null);
      assert.ok(
        [...initialConclusionIds].every((id) => latest.conclusions.some((event) => event.id === id)),
        'the version-0 INCONCLUSIVE events remain in the append-only ledger',
      );
      assert.equal(overview.status, ProjectStatus.DONE,
        'four matching recorded command results are the acceptance evidence for DONE');
      assert.equal(overview.doneGate.allowed, true);
      assert.equal(overview.doneGate.refusalCode, null);
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
      'EXECUTABLE has no EVIDENCE_JUDGMENT fallback path',
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
      completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    });
    await declare(projects, target, {
      text: '独立复核确认实现符合意图',
      verificationMethod: 'Consume the independent verifier Task verdict',
      completionCriterion: TaskCompletionCriterion.VERIFICATION,
      evidenceTaskId: verifier.id,
    });
    // The same trigger the two verdict steps below use, and the one the runner API and
    // tasks.service call whenever an evidence Task moves. It is what makes the first assertion
    // "an undecided verifier projects INCONCLUSIVE" rather than the far weaker "nothing has
    // evaluated this criterion yet", which is all a bare overview can say.
    await acceptance.reconcileForEvidenceTask(verifier.id);
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

test('EVIDENCE_JUDGMENT waits for the human criterion conclusion', { skip }, async () => {
  const { db, acceptance, projects } = await connect();
  try {
    const target = await base(db, 'human');
    await declare(projects, target, {
      text: '由 owner 判断发布取舍是否值得',
      verificationMethod: 'Owner reviews the release tradeoff',
      completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    });
    assert.equal(
      await db.project.findUniqueOrThrow({ where: { id: target.projectId } }).then((p) => p.status),
      ProjectStatus.OPEN,
    );

    const run = await acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    await acceptance.finalizeRun(target.ownerId, target.projectId, run.id, [{
      criterionId: run.criteria[0]!.criterionId!,
      verdict: ProjectAcceptanceVerdict.PASS,
      summary: 'Owner accepts this release tradeoff',
      evidence: { reviewedDigest: (await acceptance.overview(target.ownerId, target.projectId)).criteriaDigest },
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
