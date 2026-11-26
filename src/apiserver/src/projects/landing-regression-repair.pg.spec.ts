import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ModuleRef } from '@nestjs/core';
import { PrismaClient, ProjectStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionUnlandedFact } from './coordinator-wake';
import { LandingObservationBackfillAtBoot } from './landing-observation-backfill.module';
import { criteriaFromDefinitions, criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { canonicalRepoUrl } from './project-criterion-landing';
import { readDerivedProjectDone } from './project-done-derived';
import { recordDeliveryReview, recordLandingUnobserved } from './project-open-item';
import { ProjectsService } from './projects.service';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * The regression of 2026-11-20 and its repair, from the rows production holds.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-regression-repair.pg.spec.ts
 *
 * Main at d90089defa deployed at 14:08Z. Its deploy-time pass froze the empty identities of old codeless
 * verification tasks whose runs had checked out their project's line detached, P-M1's first reading took
 * the runner's diff to that commit for work somewhere else, and the observation the pass queued re-derived
 * settled projects to OPEN and put nine "changed files it didn't declare" reviews in front of a
 * coordinator. The cases start from those rows, column for column, and drive the server as it starts:
 * `LandingObservationBackfillAtBoot`, the pass and then the repair.
 *
 *  (c) a DONE project whose old codeless DONE tasks checked out the line detached: after a start it is
 *      still DONE, every criterion reads LANDED with nothing to land, the tasks are frozen, and there is
 *      no open item, no coordinator wake and no job;
 *  (d) the state production is in: identities frozen empty, the project OPEN since the flip, the reviews
 *      already accepted by hand and one still open. A start predicts and then does the same thing: the
 *      project is DONE again by derivation with nobody confirming anything (done_at is the repair's, not
 *      the original), the open items are superseded by the fact, the handled ones stay as answered, and
 *      nothing is queued or woken. An edge of the old server that takes DONE away again between the two
 *      starts of one release is undone by the second, and a third start writes nothing;
 *  (e) the other cause of that deploy: an identity nobody can name whose every work session reported an
 *      empty diff (T3) — the project is DONE again by the same start;
 *  (f) the scope review is not asked about a task with nothing of its own, whose `changed_files` is the
 *      diff to a commit it only checked out;
 *  (g) a project whose only misread task serves no criterion is not projected again: that task moves no
 *      derivation, and a projection would only store what an unrelated lag left;
 *  (h) the repair never takes a project out of DONE: a project DONE by derivation whose projection reads
 *      not done for reasons of its own (production's 01a0726d: a task filed under a criterion since the
 *      project was settled, still OPEN) stays DONE through a start, its row untouched;
 *  (i) the dry run says so in both forms: its printed line for every project — such a DONE one among
 *      them — shows the status read from the row and the status the start leaves, exactly as its JSON
 *      holds them, and its summary counts the projects it leaves unchanged.
 *
 * What this reads that the tree before the fix does not have is loaded by name, so the file compiles there
 * and every case is red for want of the behaviour rather than of a type.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);

interface PredictedProject {
  projectId: string;
  tasks: Array<{ taskId: string; clause: string; servesCriterion: boolean }>;
  supersededItemIds: string[];
  statusBefore: string | null;
  statusAfter: string | null;
  doneByBefore?: string | null;
  doneByAfter?: string | null;
  withheld?: string[];
}
interface RepairModule {
  predictLandingRegressionRepair(db: unknown): Promise<{
    passWouldFreeze: string[];
    dependents: Array<{ taskId: string; waitsOn: string; heldTodayByJ9: boolean; dispatchHold: boolean }>;
    projects: PredictedProject[];
  }>;
}
const repair: RepairModule = (() => {
  const name = './landing-regression-repair';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(name) as RepairModule;
  } catch {
    return { predictLandingRegressionRepair: (): never => assert.fail('there is no landing repair to predict') };
  }
})();

/** What the runner reported for production's V2 on 2026-11-20: the diff to the commit it checked out. */
const DETACHED_CHECKOUT_DIFF = [
  { path: '.github/workflows/pages.yml', status: 'M', additions: 2, deletions: 2 },
  ...Array.from({ length: 60 }, (_, index) => ({
    path: `scripts/install/step-${String(index).padStart(2, '0')}.sh`, status: 'M', additions: 3, deletions: 1,
  })),
];
const ORIGINAL_DONE_AT = new Date('2026-11-01T09:00:00.000Z');
const FROZEN_AT = new Date('2026-11-20T14:08:20.000Z');

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
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

async function connect(): Promise<PrismaClient> {
  await verifyDisposableDatabase();
  // The pass holds its advisory lock on a connection of its own, to the server's DATABASE_URL.
  process.env.DATABASE_URL = URL;
  return prismaClientFor(URL!);
}

/** The server starting: the deploy-time pass, then the repair. Nothing it could deliver reaches anybody. */
async function start(db: PrismaClient): Promise<void> {
  const noModules = { get: () => { throw new Error('no module in this fixture'); } } as unknown as ModuleRef;
  await new LandingObservationBackfillAtBoot(db as unknown as PrismaService, noModules).onApplicationBootstrap();
}

interface Settled {
  ownerId: string;
  projectId: string;
  runnerId: string;
  workspaceId: string;
  /** Each verification task, with its one work session and the branch it ran on. */
  tasks: Array<{ taskId: string; sessionId: string; branch: string; criterionKey: string }>;
  seal: string;
}

interface VerificationRun {
  /** The tip the runner reported; null for a session from before it reported one (T3). */
  branchSha: string | null;
  baseSha: string;
  changedFiles: unknown[];
}

/**
 * A project settled before the deploy: a line of its own, started; one criterion per verification task,
 * each task codeless, EXECUTABLE and DONE, with one finished worktree session as the runner left it; the
 * criteria confirmed by the owner; and the project stored DONE, recorded DERIVED on 2026-11-01. Nothing of
 * the deploy is in it yet: no identity is frozen.
 */
async function settledProject(db: PrismaClient, label: string, runs: VerificationRun[]): Promise<Settled> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/${label}-${projectId.slice(0, 8)}.git`;
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@regression-repair.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, repoUrl, workDir: `/srv/${label}` },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'install.sh is verified',
      coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: canonicalRepoUrl(repoUrl)!,
      upstreamRef: 'refs/heads/main', integrationRef: `refs/heads/project/${projectId.slice(0, 8)}`,
      refAuthority: 'REMOTE', remoteName: 'origin', integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date('2026-11-01T08:00:00.000Z'), deliveryMode: 'PLATFORM',
    },
  });

  const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
  const projects = new ProjectsService(db as unknown as PrismaService, acceptance);
  const criteria = criteriaFromDefinitions((await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: runs.map((_, index) => ({
      text: `verification ${index + 1} of install.sh passed`, verificationMethod: 'HUMAN',
    })),
  } as never)).acceptanceCriteriaItems);
  const definitions = await db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId }, orderBy: { ordinal: 'asc' }, select: { id: true, revision: true },
  });

  const tasks: Settled['tasks'] = [];
  for (const [index, run] of runs.entries()) {
    const definition = definitions[index]!;
    const taskId = randomUUID();
    const sessionId = randomUUID();
    const branch = `orbit/task-v${index + 2}-codex-verify-${taskId.slice(0, 6)}`;
    await db.task.create({
      data: {
        id: taskId, ownerId, creatorType: 'USER', creatorId: ownerId, title: `[codex] verify V${index + 2}`,
        description: 'Check out the project line and verify scripts/install.sh before and after a run.',
        projectId, assigneeId: workspaceId, status: 'IN_PROGRESS', autoRunWhenReady: false,
        completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
        codeless: true, codelessReason: 'a verification run reads and commits nothing',
        criterionDefinitionId: definition.id, criterionRevision: definition.revision,
      },
    });
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, taskId, workspaceId, assignedRunnerId: runnerId,
        title: `verify V${index + 2}`, prompt: 'git checkout --detach origin/project/<id>, then verify',
        provider: 'claude', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true, isolationStatus: 'worktree', branch, branchSha: run.branchSha, baseSha: run.baseSha,
        changedFiles: run.changedFiles as never, worktreeDirty: false, endReason: 'task_done',
        numTurns: 3, startedAt: new Date('2026-10-30T10:00:00.000Z'), createdAt: new Date('2026-10-30T10:00:00.000Z'),
        finishedAt: new Date('2026-10-30T10:30:00.000Z'),
      },
    });
    // Through the DONE fence, as an EXECUTABLE task whose command passed reaches it.
    await db.$executeRaw`UPDATE "task" SET "status" = 'DONE' WHERE "id" = ${taskId}::uuid AND "status" = 'IN_PROGRESS'`;
    tasks.push({ taskId, sessionId, branch, criterionKey: criteria[index]!.key });
  }

  const standing = await acceptance.standardSetConfirmation(ownerId, projectId);
  await acceptance.confirmStandardSet(ownerId, projectId, { criteriaDigest: standing.currentVersion.digest });
  await db.$executeRaw`
    UPDATE "project"
       SET "status" = 'DONE', "done_by" = 'DERIVED', "done_at" = ${ORIGINAL_DONE_AT},
           "done_criteria_digest" = ${standing.currentVersion.digest}
     WHERE "id" = ${projectId}::uuid`;
  return { ownerId, projectId, runnerId, workspaceId, tasks, seal: standing.currentVersion.digest };
}

/** What production's 14:08Z pass wrote: each task's identity frozen from its session, here empty. */
async function freezeAsTheFirstPassDid(db: PrismaClient, project: Settled): Promise<void> {
  for (const task of project.tasks) {
    const session = await db.session.findUniqueOrThrow({ where: { id: task.sessionId }, select: { branchSha: true, baseSha: true } });
    await db.task.update({
      where: { id: task.taskId },
      data: {
        deliveredSha: session.branchSha, deliveredBaseSha: session.baseSha, deliveredBranch: task.branch,
        deliveredSessionId: task.sessionId, deliveredAt: FROZEN_AT,
      },
    });
  }
}

/** What the old server's projection writes when it takes DONE away (`storeDerivedProjectStatus`). */
async function flipToOpen(db: PrismaClient, projectId: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "project"
       SET "status" = 'OPEN', "done_by" = NULL, "done_at" = NULL, "done_criteria_digest" = NULL,
           "done_task_epochs" = NULL, "accepted_gaps" = '[]'::jsonb, "reopened_at" = NULL, "reopened_facts" = NULL
     WHERE "id" = ${projectId}::uuid`;
}

async function projectRow(db: PrismaClient, projectId: string) {
  return db.project.findUniqueOrThrow({
    where: { id: projectId }, select: { status: true, doneBy: true, doneAt: true, updatedAt: true },
  });
}

/** Everything a start could have put in front of somebody or on a queue, for one project. */
async function noise(db: PrismaClient, projectId: string) {
  return {
    jobs: await db.projectIntegrationJob.count({ where: { projectId } }),
    openItems: await db.projectOpenItem.count({ where: { projectId, state: 'OPEN' } }),
    wakes: await db.projectCoordinatorWake.count({ where: { projectId } }),
  };
}
const QUIET = { jobs: 0, openItems: 0, wakes: 0 };

const V2_ROW: VerificationRun = { branchSha: sha('9'), baseSha: sha('9'), changedFiles: DETACHED_CHECKOUT_DIFF };

// ═══ (c) a start over a settled project ══════════════════════════════════════════════════════════

test('(c) a start over a DONE project whose old codeless tasks checked out the line detached leaves it DONE, every criterion LANDED, and no item, wake or job',
  { skip, timeout: 240_000 }, async () => {
    const db = await connect();
    try {
      const project = await settledProject(db, 'settled', [V2_ROW, V2_ROW, V2_ROW]);

      await start(db);

      const frozen = await db.task.findMany({
        where: { projectId: project.projectId }, select: { deliveredSha: true, deliveredBaseSha: true },
      });
      assert.ok(frozen.every((task) => task.deliveredSha === sha('9') && task.deliveredBaseSha === sha('9')),
        'CONTROL: the pass froze each task\'s empty identity');
      const row = await projectRow(db, project.projectId);
      assert.equal(row.status, ProjectStatus.DONE, 'the project is still DONE');
      assert.equal(row.doneAt?.toISOString(), ORIGINAL_DONE_AT.toISOString(), 'and its completion time is untouched');
      const derived = await readDerivedProjectDone(db as unknown as PrismaService, project.ownerId, project.projectId);
      assert.deepEqual(derived.withheld, [], 'nothing withholds DONE: the facts still prove it');
      assert.equal(derived.counts.byReason.NO_RECEIPT, 0, 'no criterion reads NO_RECEIPT');
      assert.equal(derived.counts.byReason.NOTHING_TO_LAND, 3, 'every criterion reads LANDED with nothing to land');
      assert.deepEqual(await noise(db, project.projectId), QUIET,
        'no observation was queued for identities with nothing to observe, and nobody was asked or woken');
    } finally {
      await db.$disconnect();
    }
  });

// ═══ (d) the state production is in ════════════════════════════════════════════════════════════════

test('(d) from production\'s state, a start predicts and then does it: DONE again by derivation, open questions superseded by the fact, answered ones left, nothing queued or woken; a second start undoes an old-server edge, a third writes nothing',
  { skip, timeout: 300_000 }, async () => {
    const db = await connect();
    try {
      const project = await settledProject(db, 'flipped', [V2_ROW, V2_ROW, V2_ROW, V2_ROW]);
      await freezeAsTheFirstPassDid(db, project);
      await flipToOpen(db, project.projectId);
      // The nine reviews production opened, one per task: three accepted by hand, one still open — and a
      // LANDING_UNOBSERVED (WORK_ELSEWHERE) the first reading's enqueue opened for the last task.
      const [first, second, third, fourth] = project.tasks;
      const reviews: string[] = [];
      for (const task of [first!, second!, third!, fourth!]) {
        const filed = await db.$transaction((tx) => recordDeliveryReview(tx, {
          projectId: project.projectId, taskId: task.taskId, sessionId: task.sessionId,
          reason: 'OUTSIDE_DECLARED_SCOPE', paths: DETACHED_CHECKOUT_DIFF.map((file) => file.path),
          declaredPaths: ['scripts/install.sh'], criterionKey: task.criterionKey,
        }));
        assert.ok(filed?.itemId, 'CONTROL: the review was filed');
        reviews.push(filed.itemId);
      }
      const unobserved = await db.$transaction((tx) => recordLandingUnobserved(tx, {
        taskId: fourth!.taskId, reason: 'WORK_ELSEWHERE', deliveredSha: sha('9'), baseSha: sha('9'),
        branch: fourth!.branch, sessionId: fourth!.sessionId,
      }));
      assert.ok(unobserved?.itemId, 'CONTROL: the LANDING_UNOBSERVED was filed');
      const handled = reviews.slice(0, 3);
      await db.projectOpenItem.updateMany({
        where: { id: { in: handled } },
        data: {
          state: 'RESOLVED', resolution: 'HANDLED', resolvedBy: 'COORDINATOR', resolvedAt: new Date(),
          resolutionNote: 'accepted: the 59 files are the line the run checked out',
        },
      });
      const handledBefore = await db.projectOpenItem.findMany({
        where: { id: { in: handled } }, orderBy: { id: 'asc' }, select: { id: true, state: true, resolution: true, updatedAt: true },
      });
      const stillOpen = [reviews[3]!, unobserved.itemId].sort();
      // A task that has waited on the first verification since the flip: J9 releases it with the fix.
      const waiting = randomUUID();
      await db.task.create({
        data: {
          id: waiting, ownerId: project.ownerId, creatorType: 'USER', creatorId: project.ownerId,
          title: 'publish the verified installer', projectId: project.projectId, status: 'OPEN',
          autoRunWhenReady: false, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
        },
      });
      await db.taskDependency.create({ data: { taskId: waiting, dependsOnTaskId: first!.taskId } });
      const before = new Date();

      // As the dry run reads it: one REPEATABLE READ, READ ONLY transaction, in which any write would fail.
      const prediction = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        return repair.predictLandingRegressionRepair(tx);
      }, { timeout: 60_000 });
      const predicted = prediction.projects.find((row) => row.projectId === project.projectId);
      assert.deepEqual(
        prediction.dependents.filter((row) => row.taskId === waiting)
          .map((row) => [row.waitsOn, row.heldTodayByJ9, row.dispatchHold]),
        [[first!.taskId, true, false]],
        'the prediction names the dependent, what it waits on, and that only the fix releases it: its line has '
          + 'started, the prerequisite is code work, and no receipt says it landed');
      const byId = (a: { taskId: string }, b: { taskId: string }) => a.taskId.localeCompare(b.taskId);
      assert.deepEqual(
        {
          tasks: [...(predicted?.tasks ?? [])].sort(byId),
          items: predicted?.supersededItemIds,
          from: predicted?.statusBefore,
          to: predicted?.statusAfter,
        },
        {
          tasks: project.tasks.map((task) => ({ taskId: task.taskId, clause: 'EMPTY_IDENTITY', servesCriterion: true }))
            .sort(byId),
          items: stillOpen,
          from: ProjectStatus.OPEN,
          to: ProjectStatus.DONE,
        },
        'the prediction names the project, its four tasks, the two open questions and OPEN -> DONE');
      // The command a deploy runs against production before the start, here against this database.
      const cli = JSON.parse(execFileSync(process.execPath, [join(__dirname, 'landing-regression-repair-dry-run.js'), '--json'], {
        env: { ...process.env, DATABASE_URL: URL }, encoding: 'utf8',
      })) as { projects: PredictedProject[] };
      const fromCli = cli.projects.find((row) => row.projectId === project.projectId);
      assert.deepEqual(
        [[...(fromCli?.tasks ?? [])].sort(byId), fromCli?.supersededItemIds, fromCli?.statusBefore, fromCli?.statusAfter],
        [[...(predicted?.tasks ?? [])].sort(byId), predicted?.supersededItemIds, predicted?.statusBefore, predicted?.statusAfter],
        'the dry-run command prints the same prediction');

      await start(db);

      const row = await projectRow(db, project.projectId);
      assert.equal(row.status, ProjectStatus.DONE, 'the project is DONE again');
      assert.equal(row.doneBy, 'DERIVED', 'by derivation, with nobody confirming anything');
      assert.ok(row.doneAt && row.doneAt >= before,
        'recorded at the repair: the original completion time is not restored, and nothing pretends it is');
      const derived = await readDerivedProjectDone(db as unknown as PrismaService, project.ownerId, project.projectId);
      assert.equal(derived.counts.byReason.NOTHING_TO_LAND, 4, 'every criterion reads LANDED with nothing to land');
      assert.equal(derived.counts.byReason.NO_RECEIPT, 0, 'and none NO_RECEIPT');
      const superseded = await db.projectOpenItem.findMany({
        where: { id: { in: stillOpen } }, orderBy: { id: 'asc' },
        select: { id: true, state: true, resolvedBy: true, resolutionNote: true },
      });
      assert.deepEqual(superseded.map((item) => [item.id, item.state, item.resolvedBy]),
        stillOpen.map((id) => [id, 'SUPERSEDED', 'PLATFORM']),
        'the open questions are superseded by the platform, as the prediction said');
      assert.ok(superseded.every((item) => item.resolutionNote?.includes('delivered nothing of its own')),
        'naming the fact that closed them');
      assert.deepEqual(await db.projectOpenItem.findMany({
        where: { id: { in: handled } }, orderBy: { id: 'asc' }, select: { id: true, state: true, resolution: true, updatedAt: true },
      }), handledBefore, 'the reviews a coordinator accepted stay exactly as they were answered');
      assert.deepEqual(await noise(db, project.projectId), QUIET, 'nothing queued, nothing open, nobody woken');

      // The old server still serves while the new image's first process runs: an edge of it re-derives the
      // project with the first reading. The process that stays runs the same start again.
      await flipToOpen(db, project.projectId);
      await start(db);
      assert.equal((await projectRow(db, project.projectId)).status, ProjectStatus.DONE,
        'the second start of the release puts DONE back');
      const settled = await projectRow(db, project.projectId);
      await start(db);
      assert.deepEqual(await projectRow(db, project.projectId), settled, 'a third start writes nothing');
      assert.deepEqual(await noise(db, project.projectId), QUIET, 'and still queues and wakes nothing');
    } finally {
      await db.$disconnect();
    }
  });

// ═══ (e) the other cause: an identity nobody can name ═══════════════════════════════════════════

test('(e) a project flipped by an identity nobody can name, whose every work session reported an empty diff (T3), is DONE again by the same start',
  { skip, timeout: 240_000 }, async () => {
    const db = await connect();
    try {
      // T3's row: one worktree session from before the runner reported a tip, an EMPTY list, task_done.
      const project = await settledProject(db, 'unnamed', [{ branchSha: null, baseSha: sha('3'), changedFiles: [] }]);
      await flipToOpen(db, project.projectId);

      const predicted = (await repair.predictLandingRegressionRepair(db)).projects
        .find((row) => row.projectId === project.projectId);
      assert.deepEqual(
        [predicted?.tasks, predicted?.statusBefore, predicted?.statusAfter],
        [[{ taskId: project.tasks[0]!.taskId, clause: 'UNNAMED_IDENTITY_EMPTY_LISTS', servesCriterion: true }],
          ProjectStatus.OPEN, ProjectStatus.DONE],
        'the prediction names the task, its clause, and OPEN -> DONE');

      await start(db);

      const identity = await db.task.findUniqueOrThrow({
        where: { id: project.tasks[0]!.taskId }, select: { deliveredSha: true },
      });
      assert.equal(identity.deliveredSha, null, 'CONTROL: nobody could name its identity, and the pass froze none');
      const row = await projectRow(db, project.projectId);
      assert.deepEqual([row.status, row.doneBy], [ProjectStatus.DONE, 'DERIVED'], 'the project is DONE again by derivation');
      const derived = await readDerivedProjectDone(db as unknown as PrismaService, project.ownerId, project.projectId);
      assert.equal(derived.counts.byReason.NOTHING_TO_LAND, 1, 'its criterion reads LANDED with nothing to land');
      assert.deepEqual(await noise(db, project.projectId), QUIET, 'nothing queued, nothing open, nobody woken');
    } finally {
      await db.$disconnect();
    }
  });

// ═══ (f) the scope review ════════════════════════════════════════════════════════════════════════

test('(f) the scope review is not asked about a task with nothing of its own whose changed_files is the diff to a commit it only checked out',
  { skip, timeout: 240_000 }, async () => {
    const db = await connect();
    try {
      // Two tasks under one criterion: the verification run with nothing of its own (the V2 row), and a
      // task with a real commit not landed yet, whose files are inside its declaration — so the criterion
      // is unlanded and the review is asked about the work under it.
      const project = await settledProject(db, 'scope', [V2_ROW]);
      await freezeAsTheFirstPassDid(db, project);
      const verification = project.tasks[0]!;
      const definition = await db.task.findUniqueOrThrow({
        where: { id: verification.taskId }, select: { criterionDefinitionId: true, criterionRevision: true },
      });
      const committed = randomUUID();
      const committedSession = randomUUID();
      await db.task.create({
        data: {
          id: committed, ownerId: project.ownerId, creatorType: 'USER', creatorId: project.ownerId,
          title: 'fix scripts/install.sh', description: 'Change scripts/install.sh only.',
          projectId: project.projectId, assigneeId: project.workspaceId, status: 'IN_PROGRESS', autoRunWhenReady: false,
          completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
          criterionDefinitionId: definition.criterionDefinitionId, criterionRevision: definition.criterionRevision,
        },
      });
      await db.session.create({
        data: {
          id: committedSession, ownerId: project.ownerId, creatorId: project.ownerId, taskId: committed,
          workspaceId: project.workspaceId, assignedRunnerId: project.runnerId, title: 'fix', prompt: 'fix',
          provider: 'claude', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true, isolationStatus: 'worktree', branch: 'orbit/fix-install', branchSha: sha('c'),
          baseSha: sha('9'), worktreeDirty: false, finishedAt: new Date(),
          changedFiles: [{ path: 'scripts/install.sh', status: 'M', additions: 5, deletions: 2 }],
        },
      });
      await db.$executeRaw`UPDATE "task" SET "status" = 'DONE' WHERE "id" = ${committed}::uuid`;
      await db.task.update({
        where: { id: committed },
        data: {
          deliveredSha: sha('c'), deliveredBaseSha: sha('9'), deliveredBranch: 'orbit/fix-install',
          deliveredSessionId: committedSession, deliveredAt: new Date(),
        },
      });
      await db.task.update({ where: { id: verification.taskId }, data: { description: 'Verify scripts/install.sh.' } });

      const fact = criterionUnlandedFact(project.projectId, verification.criterionKey, [
        { taskId: verification.taskId, status: 'DONE', lifecycleEpoch: 0 },
        { taskId: committed, status: 'DONE', lifecycleEpoch: 0 },
      ], 'UNKNOWN');
      assert.ok(fact, 'CONTROL: the criterion is unlanded while the committed task waits for its landing');
      const disposition = new WakeDispositionService(db as unknown as PrismaService, {} as never, {} as never);
      const raised = await disposition.raiseBlockerIfNeeded(fact);

      assert.equal(raised, null, 'no question: the only out-of-scope files were a checked-out commit\'s');
      assert.equal(await db.projectOpenItem.count({
        where: { projectId: project.projectId, kind: 'DELIVERY_REVIEW' },
      }), 0, 'and no review was filed about the verification run');
      assert.equal(criterionKeyOf(definition.criterionDefinitionId!), verification.criterionKey,
        'CONTROL: the fact named the criterion both tasks serve');
    } finally {
      await db.$disconnect();
    }
  });

// ═══ (g) a misread task that serves no criterion ═══════════════════════════════════════════════════

test('(g) a project whose only misread task serves no criterion is not projected again, even where the stored status lags',
  { skip, timeout: 240_000 }, async () => {
    const db = await connect();
    try {
      // Every criterion served by work landed on main by a MERGED receipt, the set confirmed: the facts
      // prove DONE. The stored column says OPEN anyway — a lag this repair did not cause.
      const project = await settledProject(db, 'lagging', [{ branchSha: sha('c'), baseSha: sha('9'), changedFiles: [] }]);
      const served = project.tasks[0]!;
      await db.sessionMergeReceipt.create({
        data: {
          ownerId: project.ownerId, sessionId: served.sessionId, taskId: served.taskId, projectId: project.projectId,
          result: 'MERGED', sourceBranch: served.branch, sourceSha: sha('c'), targetBranch: 'main',
          targetShaBefore: sha('a'), targetShaAfter: sha('b'), recordedBy: 'AGENT', idempotencyKey: `landed:${served.taskId}`,
        },
      });
      await flipToOpen(db, project.projectId);
      // And a task outside every criterion that the fix now reads as nothing of its own (T3's shape).
      const loose = randomUUID();
      await db.task.create({
        data: {
          id: loose, ownerId: project.ownerId, creatorType: 'USER', creatorId: project.ownerId,
          title: 'an October measurement nobody filed under a criterion', projectId: project.projectId,
          assigneeId: project.workspaceId, status: 'IN_PROGRESS', autoRunWhenReady: false,
          completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
        },
      });
      await db.session.create({
        data: {
          id: randomUUID(), ownerId: project.ownerId, creatorId: project.ownerId, taskId: loose,
          workspaceId: project.workspaceId, assignedRunnerId: project.runnerId, title: 'measure', prompt: 'measure',
          provider: 'claude', turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
          startsTaskWork: true, isolationStatus: 'worktree', branch: 'orbit/loose', baseSha: sha('3'),
          changedFiles: [], worktreeDirty: false, finishedAt: new Date('2026-10-01T10:00:00.000Z'),
        },
      });
      await db.$executeRaw`UPDATE "task" SET "status" = 'DONE' WHERE "id" = ${loose}::uuid AND "status" = 'IN_PROGRESS'`;
      const derived = await readDerivedProjectDone(db as unknown as PrismaService, project.ownerId, project.projectId);
      assert.deepEqual(derived.withheld, [], 'CONTROL: the facts prove DONE, and the stored column lags');

      const predicted = (await repair.predictLandingRegressionRepair(db)).projects
        .find((row) => row.projectId === project.projectId);
      assert.deepEqual(
        [predicted?.tasks, predicted?.statusBefore, predicted?.statusAfter],
        [[{ taskId: loose, clause: 'UNNAMED_IDENTITY_EMPTY_LISTS', servesCriterion: false }], ProjectStatus.OPEN, ProjectStatus.OPEN],
        'the prediction names the task and leaves the project as it is');

      await start(db);

      assert.equal((await projectRow(db, project.projectId)).status, ProjectStatus.OPEN,
        'the repair does not project a project whose misread work serves no criterion');
    } finally {
      await db.$disconnect();
    }
  });

// ═══ (h) and (i) the repair never takes a project out of DONE, and its dry run says so ═════════════

/**
 * Production's 01a0726d: DONE by derivation since September, its misread task (the V2 row, frozen empty)
 * serving a criterion, and a task filed under its other criterion since then, still OPEN. Filed by hand,
 * as rows from before the projection's edges were: the stored DONE is stale against the facts.
 */
async function staleDoneProject(db: PrismaClient, label: string) {
  const project = await settledProject(db, label, [V2_ROW, V2_ROW]);
  await freezeAsTheFirstPassDid(db, project);
  const second = await db.task.findUniqueOrThrow({
    where: { id: project.tasks[1]!.taskId }, select: { criterionDefinitionId: true, criterionRevision: true },
  });
  await db.task.create({
    data: {
      id: randomUUID(), ownerId: project.ownerId, creatorType: 'USER', creatorId: project.ownerId,
      title: 'a follow-up filed under criterion 2 after the project was settled', projectId: project.projectId,
      status: 'OPEN', autoRunWhenReady: false, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
      criterionDefinitionId: second.criterionDefinitionId, criterionRevision: second.criterionRevision,
    },
  });
  const stale = await projectRow(db, project.projectId);
  assert.deepEqual([stale.status, stale.doneBy], [ProjectStatus.DONE, 'DERIVED'], 'CONTROL: stored DONE by derivation');
  const derived = await readDerivedProjectDone(db as unknown as PrismaService, project.ownerId, project.projectId);
  assert.deepEqual(derived.withheld, ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED'],
    'CONTROL: the projection reads not done, for the OPEN follow-up and not for the misread task');
  return { project, stale };
}

test('(h) a project DONE by derivation whose projection reads not done for a reason of its own stays DONE through a start, its row untouched: the repair stores nothing but DONE, and only over OPEN',
  { skip, timeout: 240_000 }, async () => {
    const db = await connect();
    try {
      const { project, stale } = await staleDoneProject(db, 'stale-done');

      await start(db);

      assert.deepEqual(await projectRow(db, project.projectId), stale,
        'a start leaves it DONE, recorded DERIVED at its original time: the repair wrote nothing to the row');
      assert.deepEqual(await noise(db, project.projectId), QUIET, 'nothing queued, nothing open, nobody woken');
    } finally {
      await db.$disconnect();
    }
  });

test('(i) the dry run prints every project with its status as read from the row and the status the start leaves it in, exactly as its JSON holds them — a stale DONE one among them — and its summary counts the unchanged',
  { skip, timeout: 300_000 }, async () => {
    const db = await connect();
    try {
      const { project, stale } = await staleDoneProject(db, 'stale-printed');

      const predicted = (await repair.predictLandingRegressionRepair(db)).projects
        .find((row) => row.projectId === project.projectId);
      assert.deepEqual(
        [predicted?.statusBefore, predicted?.statusAfter, predicted?.withheld],
        [ProjectStatus.DONE, ProjectStatus.DONE, ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED']],
        'the prediction leaves it DONE, and says what the projection withholds DONE for');

      // The command a deploy runs, both ways, against this database: every project the cases above left
      // in it, OPEN, DONE and stale DONE alike, printed as its JSON holds it.
      const dryRun = join(__dirname, 'landing-regression-repair-dry-run.js');
      const env = { ...process.env, DATABASE_URL: URL };
      const json = JSON.parse(execFileSync(process.execPath, [dryRun, '--json'], { env, encoding: 'utf8' })) as {
        projects: PredictedProject[];
      };
      const text = execFileSync(process.execPath, [dryRun], { env, encoding: 'utf8' }).split('\n');
      const lines = text.filter((line) => line.startsWith('landing repair (predicted): project '));
      const printed = new Map(lines.map((line) => {
        const match = /^landing repair \(predicted\): project (\S+): (\w+)(?: \((\w+)\))? -> (\w+)(?: \((\w+)\))?, /.exec(line);
        assert.ok(match, `a project line prints the status read from the row and the status the start leaves: ${line}`);
        return [match[1]!, { from: match[2], fromBy: match[3] ?? null, to: match[4], toBy: match[5] ?? null }] as const;
      }));
      assert.equal(printed.size, json.projects.length, 'one line for every project of the prediction, unchanged ones included');
      for (const row of json.projects) {
        assert.deepEqual(printed.get(row.projectId), {
          from: row.statusBefore ?? 'gone', fromBy: row.statusBefore === 'DONE' ? row.doneByBefore ?? null : null,
          to: row.statusAfter ?? 'gone', toBy: row.statusAfter === 'DONE' ? row.doneByAfter ?? null : null,
        }, `the line for ${row.projectId} prints the statuses its JSON holds`);
      }
      assert.deepEqual(printed.get(project.projectId), { from: 'DONE', fromBy: 'DERIVED', to: 'DONE', toBy: 'DERIVED' },
        'this project prints DONE -> DONE');
      assert.match(lines.find((line) => line.includes(project.projectId)) ?? '',
        /unchanged: the projection withholds DONE \(CRITERION_UNSATISFIED, CRITERION_UNLANDED\), and the repair never takes a project out of DONE/,
        'and says why it stays');
      const summary = text.find((line) => /^landing repair \(predicted\): \d+ project\(s\) hold misread tasks; /.test(line)) ?? '';
      const count = (status: string) => json.projects.filter((row) => row.statusBefore === status && row.statusAfter === status).length;
      assert.match(summary, new RegExp(`: ${json.projects.length} project\\(s\\) hold misread tasks; `), 'the summary counts every project');
      assert.match(summary, /; 0 taken out of DONE; /, 'none taken out of DONE');
      assert.match(summary, new RegExp(`unchanged: [^;]*\\b${count('DONE')} DONE\\b`), 'the DONE ones it leaves are counted');
      assert.ok(count('DONE') >= 1, 'CONTROL: DONE projects are among the ones compared');

      // And the start does what was printed.
      await start(db);
      assert.deepEqual(await projectRow(db, project.projectId), stale, 'a start leaves the row as the prediction said');
    } finally {
      await db.$disconnect();
    }
  });
