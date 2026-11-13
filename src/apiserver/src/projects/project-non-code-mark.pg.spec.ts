/**
 * The explicit non-code mark (migration 0535) over a real database: written by the coordinator
 * through `project_update`'s runner door and by the owner through `ProjectsService.update`, read back
 * on the project document with who and when; for a marked project with branchless work, the
 * document's `derivedDone`, the done check and Record as done read no landing; clearing the mark
 * brings the NO_BRANCH finding back.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-non-code-mark.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

test('a project marked non-code reads no landing, and clearing the mark brings NO_BRANCH back', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const tasks = new TasksService(db, sessions, realtime);
  const door = new RunnerProjectsController(
    projects, acceptance, {} as never,
    { assert: async () => assert.fail('the mark spends no orchestration credential') } as never,
    new ProjectOpenItemService(db, sessions),
  );

  const ownerId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `non-code-${ownerId}@project.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'non-code-runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  const runner = { id: runnerId, ownerId } as never;
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: 'non-code-workspace', enabled: true,
      repoUrl: 'ssh://git@example.invalid/orbit/non-code', workDir: '/srv/non-code',
    },
  });
  const coordinatorSessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: 'coordinator', prompt: 'coordinate', provider: 'claude', status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), runtimeSessionId: randomUUID(),
    },
  });
  const projectId = randomUUID();
  await prisma.project.create({
    data: {
      id: projectId, ownerId, title: 'ICP filing', coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [{ text: 'The ICP filing is approved', verificationMethod: 'VERIFICATION' }],
  } as never);
  const { rows: [definition] } = await sql.query<{ id: string }>(
    `SELECT "id" FROM "project_acceptance_criterion_definition" WHERE "project_id" = $1::uuid`, [projectId]);
  // Work that ran without a branch: no work session, no landing job, no receipt.
  const created = await tasks.create(ownerId, {
    title: 'File for ICP', projectId, criterionKey: criterionKeyOf(definition.id),
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    autoRunWhenReady: false,
  } as never) as unknown as { id: string };
  const settled = await sql.query(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" = 'OPEN'`, [created.id]);
  assert.equal(settled.rowCount, 1);

  const unlanded = async () => (await acceptance.readProjectDoneCheck(ownerId, projectId)).findings
    .filter((finding) => finding.code === 'DONE_CRITERION_UNLANDED')
    .map((finding) => finding.reason);

  await t.test('unmarked: the branchless work is NO_BRANCH', async () => {
    const document = await projects.get(ownerId, projectId);
    assert.equal(document.nonCode, false);
    assert.equal(document.nonCodeSetBy, null);
    assert.equal(document.derivedDone.criteria[0].landingReason, 'NO_BRANCH');
    assert.deepEqual(await unlanded(), ['NO_BRANCH']);
  });

  await t.test('the coordinator marks it through project_update: no landing anywhere', async () => {
    await door.updateProject(runner, projectId, coordinatorSessionId, {
      nonCode: true, nonCodeReason: '  All work is documents and vendor accounts; no repository.  ',
    } as never);
    const document = await projects.get(ownerId, projectId);
    assert.equal(document.nonCode, true);
    assert.equal(document.nonCodeSetBy, 'COORDINATOR');
    // The mark's reason (0555), stored trimmed with who/when and served on the project document.
    assert.equal(document.nonCodeReason, 'All work is documents and vendor accounts; no repository.');
    assert.equal(document.nonCodeSetBySessionId, coordinatorSessionId);
    assert.ok(document.nonCodeSetAt instanceof Date);
    assert.equal(document.derivedDone.nonCode, true);
    assert.equal(document.derivedDone.criteria[0].landingReason, null);
    assert.equal(document.derivedDone.criteria[0].satisfied, true);
    assert.ok(!document.derivedDone.withheld.includes('CRITERION_UNLANDED'));
    assert.equal(document.derivedDone.counts.onMain, 0);
    assert.deepEqual(await unlanded(), []);
  });

  await t.test('the owner clears it: NO_BRANCH comes back, recorded as the owner’s', async () => {
    await projects.update(ownerId, projectId, { nonCode: false } as never);
    const document = await projects.get(ownerId, projectId);
    assert.equal(document.nonCode, false);
    assert.equal(document.nonCodeSetBy, 'OWNER');
    assert.equal(document.nonCodeSetBySessionId, null);
    assert.equal(document.nonCodeReason, null, 'a write with no reason stores none, replacing the old one');
    assert.ok(document.derivedDone.withheld.includes('CRITERION_UNLANDED'));
    assert.deepEqual(await unlanded(), ['NO_BRANCH']);
  });

  await t.test('the owner marks it again and records it done: no landing gap is stored', async () => {
    await projects.update(ownerId, projectId, { nonCode: true, nonCodeReason: 'Filings only.' } as never);
    const marked = await projects.get(ownerId, projectId);
    assert.equal(marked.nonCodeReason, 'Filings only.', 'the owner may give a reason too');
    assert.equal(marked.nonCodeSetBy, 'OWNER');
    const check = await acceptance.readProjectDoneCheck(ownerId, projectId);
    assert.deepEqual(check.findings, []);
    await acceptance.recordProjectDone(ownerId, projectId, {
      criteriaDigest: check.criteriaDigest, acceptedGaps: [],
    });
    const { rows: [row] } = await sql.query<{ status: string; accepted_gaps: unknown[] }>(
      `SELECT "status"::text AS "status", "accepted_gaps" FROM "project" WHERE "id" = $1::uuid`, [projectId]);
    assert.equal(row.status, 'DONE');
    assert.deepEqual(row.accepted_gaps, []);
  });
});
