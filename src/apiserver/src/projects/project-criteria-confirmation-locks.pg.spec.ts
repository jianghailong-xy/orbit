import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  ProjectStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskCompletionCriterion,
} from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';

/**
 * N22's two locks, deliberately landed before the automatic evaluator.
 *
 * These specs exercise a disposable, fully migrated PostgreSQL rather than a service double: the
 * digest is the identity-independent lock, and the dispatch origin is the one role the server can
 * actually distinguish. Keep this file earlier in history than the evaluator implementation.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

type ConfirmationActor = {
  actorType: 'USER' | 'RUNNER';
  actorId: string;
  actingSessionId?: string;
};

interface ConfirmationApi {
  confirmCriteriaSet(
    ownerId: string,
    projectId: string,
    actor: ConfirmationActor,
  ): Promise<{ id: string; criteriaDigest: string; current: boolean }>;
  criteriaConfirmation(
    ownerId: string,
    projectId: string,
  ): Promise<{ confirmed: boolean; criteriaDigest: string; confirmation: unknown | null }>;
}

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
  const projects = new ProjectsService(db as unknown as PrismaService, acceptance);
  return {
    db,
    acceptance: acceptance as ProjectAcceptanceService & ConfirmationApi,
    projects,
    runnerProjects: new RunnerProjectsController(projects, acceptance, {} as never),
  };
}

async function fixture(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@criteria-confirmation.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  const runner = await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      acceptanceCriteria: 'The standard set is fit for its goal',
    },
  });
  const definition = await db.projectAcceptanceCriterionDefinition.findFirstOrThrow({
    where: { projectId },
    orderBy: { ordinal: 'asc' },
  });
  return { ownerId, runnerId, runner, projectId, definition };
}

test('a no-acting-session runner edit changes the digest and immediately invalidates the prior set confirmation',
  { skip }, async () => {
    const { db, acceptance, runnerProjects } = await connect();
    try {
      const target = await fixture(db, 'digest-lock');
      const confirmed = await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
        actorType: 'USER',
        actorId: target.ownerId,
      });
      assert.equal(confirmed.current, true);

      // This is the runner credential's intentional headless path: no acting-session id is sent.
      // The system cannot call it human. The digest lock must therefore do all of the safety work.
      await runnerProjects.updateProject(
        target.runner,
        target.projectId,
        undefined,
        {
          acceptanceCriteriaItems: [{
            id: target.definition.id,
            text: 'The edited standard set is fit for its goal',
            verificationMethod: target.definition.verificationMethod,
            completionCriterion: TaskCompletionCriterion.HUMAN_SIGNOFF,
          }],
        } as never,
      );

      const state = await acceptance.criteriaConfirmation(target.ownerId, target.projectId);
      assert.equal(state.confirmed, false);
      assert.notEqual(state.criteriaDigest, confirmed.criteriaDigest);
      assert.equal(state.confirmation, null, 'a confirmation for an old digest is not current');

      const project = await db.project.findUniqueOrThrow({
        where: { id: target.projectId },
        select: { status: true },
      });
      assert.equal(project.status, ProjectStatus.OPEN,
        'an edit cannot carry the project into DONE on a stale confirmation');
      const gated = await acceptance.reconcile(target.ownerId, target.projectId);
      assert.equal(gated.done, false);
      assert.equal(gated.code, 'CRITERIA_CONFIRMATION_REQUIRED',
        'the evaluator must stop on the identity-independent digest lock before DONE');

      const reconfirmed = await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
        actorType: 'RUNNER',
        actorId: target.runnerId,
      });
      assert.equal(reconfirmed.current, true);
      assert.equal(reconfirmed.criteriaDigest, state.criteriaDigest);
      assert.notEqual(reconfirmed.criteriaDigest, confirmed.criteriaDigest);
    } finally {
      await db.$disconnect();
    }
  });

test('a PROJECT_COORDINATOR judgment session is refused when it tries to confirm the criteria set',
  { skip }, async () => {
    const { db, acceptance } = await connect();
    try {
      const target = await fixture(db, 'judgment-refusal');
      const sessionId = randomUUID();
      await db.session.create({
        data: {
          id: sessionId,
          ownerId: target.ownerId,
          creatorId: target.ownerId,
          title: 'one-shot project judgment',
          prompt: 'judge this project once',
          dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
        },
      });

      try {
        await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
          actorType: 'RUNNER',
          actorId: target.runnerId,
          actingSessionId: sessionId,
        });
        assert.fail('the judgment session wrote a criteria-set confirmation');
      } catch (error) {
        assert.ok(error instanceof ForbiddenException, `expected a refusal, got ${error}`);
        const body = error.getResponse() as Record<string, unknown>;
        assert.equal(body.code, 'PROJECT_CRITERIA_CONFIRMATION_HUMAN_ONLY');
        assert.equal(body.tier, 'HUMAN_ONLY');
        assert.equal(body.requiredAction, 'ASK_A_PERSON');
      }

      assert.equal(await db.projectAcceptanceCriteriaConfirmation.count({
        where: { projectId: target.projectId },
      }), 0);

      // Negative control: the same runner, without a one-shot acting session, is admitted and is
      // stored as machine provenance. This is audit visibility, deliberately not proof of a human.
      const confirmation = await acceptance.confirmCriteriaSet(target.ownerId, target.projectId, {
        actorType: 'RUNNER',
        actorId: target.runnerId,
      });
      const row = await db.projectAcceptanceCriteriaConfirmation.findUniqueOrThrow({
        where: { id: confirmation.id },
      });
      assert.equal(row.confirmedByType, 'RUNNER');
      assert.equal(row.confirmedById, target.runnerId);
      assert.equal(row.actingSessionId, null);
      assert.equal(row.criteriaDigest, confirmation.criteriaDigest);
    } finally {
      await db.$disconnect();
    }
  });

test('the PostgreSQL target is a disposable database', { skip }, verifyDisposableDatabase);
