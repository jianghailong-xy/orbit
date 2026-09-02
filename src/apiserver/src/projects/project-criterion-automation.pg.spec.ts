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
/**
 * EXECUTABLE project criteria after 2026-09-02.
 *
 * Two tests stood here: one drove four wired EXECUTABLE criteria to PASS from recorded command
 * results, the other followed one criterion FAIL then PASS. Both read
 * `task_executable_judgment_result`, which the account owner had removed with the rest of the
 * judgment machinery — and 0227 had already removed the typed attempt that used to be read in
 * front of it. An EXECUTABLE criterion therefore has no evidence source at all, which is a fact
 * about the gate worth stating rather than a gap worth hiding: the criterion is still declarable,
 * still stored, still carries its command, and cannot conclude.
 */
test('an EXECUTABLE criterion is still declarable and can no longer conclude', { skip }, async () => {
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

    // The declaration survives the round trip, command and expected code included.
    const declared = await db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
      where: { projectId: target.projectId },
    });
    assert.equal(declared.completionCriterion, TaskCompletionCriterion.EXECUTABLE);
    assert.equal(declared.acceptanceCommand, 'npm test');
    assert.equal(declared.acceptanceExpectedExitCode, 0);
    assert.equal(declared.evidenceTaskId, source.id);

    const run = await acceptance.openRun(
      target.ownerId, target.projectId, { decidedBy: 'USER' },
    );
    // It is still refused a fallback human verdict: EXECUTABLE is evaluated automatically or not
    // at all, and "not at all" does not turn it into a criterion somebody may answer by hand.
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
    );

    // And with no evidence source left it stays INCONCLUSIVE, and says why, however the task ends.
    await db.task.update({ where: { id: source.id }, data: { status: TaskStatus.DONE } });
    assert.equal(await acceptance.reconcileForEvidenceTask(source.id), undefined);
    const overview = await acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs[0]?.criteria[0]?.verdict, ProjectAcceptanceVerdict.INCONCLUSIVE);
    assert.equal(
      (overview.runs[0]?.criteria[0]?.evidence as { resultId: string | null }).resultId,
      null,
    );
    assert.equal(overview.runs[0]?.criteria[0]?.summary,
      'No matching recorded command result exists yet');
    assert.equal(overview.status, ProjectStatus.OPEN,
      'a project whose only criterion cannot conclude does not close');
    assert.equal(overview.doneGate.allowed, false);

    // The hand-written DONE is refused for the same reason it always was.
    await assert.rejects(
      projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        assert.equal(
          (error.getResponse() as { code?: string }).code, 'PROJECT_DONE_AUTOMATIC_ONLY',
        );
        return true;
      },
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
