import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { doneReadiness, readDoneState } from './project-done-request';
import { enqueueForDoneTask, settleDeliveredIdentityAfterFinish } from './project-integration-job';

const url = process.env.COORDINATOR_PG_URL;

test('done readiness refuses a deferred landing until the work session finishes an empty branch',
  { skip: !url, timeout: 120_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(url!);
    const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    t.after(() => sql.end());
    await verifyCoordinatorPgIdentity(sql);
    const db = prismaClientFor(url!);
    t.after(() => db.$disconnect());

    const ownerId = randomUUID();
    const repoUrl = 'https://git.invalid/orbit/deferred-done-request';
    const owner = await db.user.create({
      data: { id: ownerId, email: `${ownerId}@example.invalid`, name: 'Owner', passwordHash: 'x' },
    });
    const runner = await db.runner.create({
      data: { ownerId, name: 'Runner', tokenHash: owner.id, status: 'ONLINE' },
    });
    const workspace = await db.workspace.create({
      data: { ownerId, runnerId: runner.id, name: 'Workspace', repoUrl, workDir: '/srv/deferred-done-request' },
    });
    const project = await db.project.create({
      data: { ownerId, title: 'Project with deferred landing', coordinatorWorkspaceId: workspace.id },
    });
    await db.projectRuntime.upsert({
      where: { projectId: project.id }, create: { projectId: project.id }, update: {},
    });
    await db.projectCodebase.create({
      data: {
        ownerId, projectId: project.id, canonicalRepoUrl: repoUrl,
        upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/project/deferred-done-request',
        refAuthority: 'REMOTE', integrationRefSource: 'EXPLICIT', integrationStartedAt: new Date(),
      },
    });
    const criterion = await db.projectAcceptanceCriterionDefinition.create({
      data: {
        projectId: project.id, ordinal: 1, text: 'The work is complete',
        verificationMethod: 'Run the acceptance check', contentHash: '0'.repeat(64),
      },
    });
    const task = await db.task.create({
      data: {
        ownerId, creatorType: 'USER', creatorId: ownerId, projectId: project.id,
        title: 'Work whose landing is deferred', criterionDefinitionId: criterion.id, criterionRevision: 1,
        status: 'IN_PROGRESS', completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
      },
    });
    const sha = 'a'.repeat(40);
    const session = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, workspaceId: workspace.id, taskId: task.id, assignedRunnerId: runner.id,
        title: 'Work session', prompt: 'Do the work', turnState: null, startsTaskWork: true,
        isolationStatus: 'worktree', branch: 'orbit/deferred-done-request', branchSha: sha, baseSha: sha,
        changedFiles: [], startedAt: new Date(), numTurns: 1,
      },
    });

    const queued = await db.$transaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { status: 'DONE' } });
      return enqueueForDoneTask(tx, ownerId, task.id);
    });
    assert.equal(queued.enqueued, false);
    assert.equal(await db.projectIntegrationJob.count({ where: { projectId: project.id } }), 0);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).deliveredAt, null);

    const readiness = async () => doneReadiness(await readDoneState(db, ownerId, project.id, null), [])
      .filter((finding) => finding.severity === 'REFUSE');
    assert.deepEqual((await readiness()).map(({ code, tasks }) => ({ code, tasks })), [
      { code: 'DONE_LANDING_DEFERRED', tasks: [{ taskId: task.id, title: task.title }] },
    ]);

    const settlement = await db.$transaction(async (tx) => {
      const finished = await tx.session.update({
        where: { id: session.id }, data: { turnState: null, finishedAt: new Date() },
      });
      return settleDeliveredIdentityAfterFinish(tx, finished);
    });
    assert.equal(settlement, 'FROZEN');
    const frozen = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.ok(frozen.deliveredAt);
    assert.equal(frozen.deliveredSha, frozen.deliveredBaseSha);
    assert.equal(await db.projectIntegrationJob.count({ where: { projectId: project.id } }), 0);
    assert.deepEqual(await readiness(), []);
  });
