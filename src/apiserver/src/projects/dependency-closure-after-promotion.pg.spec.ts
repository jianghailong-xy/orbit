import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import { decideSessionSource, SESSION_SOURCE_TASK_SELECT } from './session-source';

/**
 * P4's dependency closure right after a prerequisite was promoted into upstream, driven against a
 * real PostgreSQL and a real repository:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/dependency-closure-after-promotion.pg.spec.ts
 *
 * `docs/project-integration-line-contract.md` §1.5 L10, the P4 row.
 *
 * WHAT WAS WRONG
 * ==============
 * `prerequisiteLandingCommits` took `target_sha_after` from every MERGED receipt of a prerequisite,
 * including the one its project's promotion writes. That receipt names upstream's merge commit,
 * whose second parent is the project branch's tip. The project branch is where a P4 run starts, and
 * it contains that merge only after its next main sync, which only a later landing performs. So the
 * runner's containment check refused every dependent started in between with
 * DEPENDENCY_BASE_NOT_LANDED, although the prerequisite's work was on the pinned commit. The last
 * task of a chain, after which nothing lands, could never start. Seen on 2026-09-23 in project
 * 34Tcl0kralZrY8opuLJU4: pinned 4c5b9cd42, required 51866560b, and 51866560b^2 is 4c5b9cd42.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * The production shape in git: a task's commit landed on the project branch, then the project branch
 * was promoted into a main that had moved. The receipts for those two landings go through
 * `MergeReceiptService.fromIntegrationJob`, the door both integration jobs use. The SOURCE that
 * `decideSessionSource` freezes for the dependent is then checked the way the runner checks it:
 * `git merge-base --is-ancestor` of every required commit against the tip the run starts from.
 *
 * The same repository also has a prerequisite whose work reached main directly, never the project
 * branch. Its dependent must stay held, by that commit on main. So a closure that stopped requiring
 * anything from upstream fails here as loudly as one that requires upstream's merge commit.
 *
 * Not destructive: every case owns freshly generated ids and its own temporary repository.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

/** The declaration every task here carries; never the thing under test. */
const CHECK = {
  completionCriterion: 'EXECUTABLE' as const,
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  tasks: TasksService;
  receipts: MergeReceiptService;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  // No landing dispatcher: a receipt that also started the dependent would take away the session
  // create this case is asking about.
  return {
    db,
    prisma,
    tasks: new TasksService(prisma, sessions, publishes),
    receipts: new MergeReceiptService(prisma),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The project's integration branch, by the short name a receipt's branch columns hold. */
  branch: string;
}

/** An owner with one online runner, one workspace bound to it, and a project on a PROJECT_BRANCH line. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = {
    ownerId: randomUUID(),
    runnerId: randomUUID(),
    workspaceId: randomUUID(),
    projectId: randomUUID(),
  };
  await db.user.create({
    data: {
      id: ids.ownerId, email: `${label}-${RUN}-${ids.ownerId}@closure-promotion.invalid`, name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId, ownerId: ids.ownerId, name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(), maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId, ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${label}-agent`,
      enabled: true, repoUrl: 'https://github.com/example/closure',
    },
  });
  await db.project.create({
    data: {
      id: ids.projectId, ownerId: ids.ownerId, title: `${label} project`,
      coordinatorWorkspaceId: ids.workspaceId,
    },
  });
  const branch = `project/${ids.projectId.slice(0, 8)}`;
  await db.projectCodebase.create({
    data: {
      ownerId: ids.ownerId,
      projectId: ids.projectId,
      canonicalRepoUrl: 'https://github.com/example/closure',
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${branch}`,
      refAuthority: 'REMOTE',
      remoteName: 'origin',
      integrationRefSource: 'DEFAULT_RULE',
      integrationStartedAt: new Date(),
    },
  });
  return { ...ids, branch };
}

/** A task filed under the project, created through the door a person and an agent both use. */
async function task(stack: Stack, ids: World, title: string): Promise<string> {
  const created = await stack.tasks.create(ids.ownerId, {
    title,
    projectId: ids.projectId,
    assigneeId: ids.workspaceId,
    autoRunWhenReady: false,
    ...CHECK,
  } as never);
  return created.id;
}

/** A finished piece of code work: DONE, with the worktree session whose branch did it. */
async function donePrerequisite(
  stack: Stack,
  ids: World,
  branch: string,
): Promise<{ taskId: string; sessionId: string }> {
  const taskId = await task(stack, ids, branch);
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      taskId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      title: branch,
      prompt: branch,
      provider: 'claude',
      turnState: null, finishedAt: new Date(), 
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      isolationStatus: 'worktree',
      branch,
      completedAt: new Date(),
    },
  });
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  return { taskId, sessionId };
}

/** A task waiting on one prerequisite. */
async function dependentOf(stack: Stack, ids: World, prerequisiteId: string, title: string): Promise<string> {
  const dependent = await task(stack, ids, title);
  await stack.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: prerequisiteId } });
  return dependent;
}

/** The SOURCE a session create would freeze for this task, through the production door. */
async function resolvedSource(stack: Stack, taskId: string) {
  const row = await stack.db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: SESSION_SOURCE_TASK_SELECT,
  });
  return await decideSessionSource(stack.prisma, row);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim();
}

/** A throwaway repository holding nothing but the history the case writes into it. */
function repository(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `orbit-${label}-`));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'fixture@orbit.invalid');
  git(dir, 'config', 'user.name', 'fixture');
  return dir;
}

/** Commit one new file on whatever is checked out, and answer the new commit. */
function commitFile(dir: string, file: string): string {
  writeFileSync(path.join(dir, file), `${file}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '--quiet', '-m', file);
  return git(dir, 'rev-parse', 'HEAD');
}

/** The runner's check before it forks a pinned run (`setupSourceWorktree`): is `sha` in `tip`? */
function contains(dir: string, tip: string, sha: string): boolean {
  return spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', sha, tip]).status === 0;
}

test('a dependent started right after its prerequisite was promoted requires the commit that landed on the project branch, not upstream\'s merge commit',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    const repo = repository('closure-after-promotion');
    try {
      const ids = await world(stack.db, 'closure-promotion');
      const base = commitFile(repo, 'base');
      git(repo, 'branch', ids.branch);

      // The promoted prerequisite: its session's commit, landed on the project branch by LAND_TASK
      // as a new commit, the way a rebase lands it.
      const promoted = await donePrerequisite(stack, ids, 'orbit/promoted');
      git(repo, 'checkout', '--quiet', '-b', 'orbit/promoted', base);
      const promotedSource = commitFile(repo, 'promoted-work');
      git(repo, 'checkout', '--quiet', ids.branch);
      git(repo, 'cherry-pick', promotedSource);
      const landed = git(repo, 'rev-parse', 'HEAD');
      await MergeReceiptService.fromIntegrationJob(stack.db, {
        ownerId: ids.ownerId, sessionId: promoted.sessionId, taskId: promoted.taskId,
        projectId: ids.projectId, jobId: randomUUID(), state: 'LANDED',
        sourceBranch: 'orbit/promoted', targetBranch: ids.branch,
        sourceSha: promotedSource, targetShaBefore: base, landedSha: landed, rebaseBaseSha: base,
        testedTreeSha: null, landedTreeSha: null, mainSyncSha: null,
      });

      // The direct prerequisite: its work reached main without passing through the project branch.
      const direct = await donePrerequisite(stack, ids, 'orbit/direct');
      git(repo, 'checkout', '--quiet', '-b', 'orbit/direct', base);
      const directSource = commitFile(repo, 'direct-work');
      git(repo, 'checkout', '--quiet', 'main');
      git(repo, 'merge', '--quiet', '--no-ff', '-m', 'orbit/direct into main', directSource);
      const mainAfterDirect = git(repo, 'rev-parse', 'HEAD');
      const recorded = await stack.receipts.record(ids.ownerId, direct.sessionId, {
        result: 'MERGED',
        sourceSha: directSource,
        targetBranch: 'main',
        targetShaBefore: base,
        targetShaAfter: mainAfterDirect,
      } as never, 'AGENT');
      assert.equal(recorded.created, true, 'the direct landing on main was not recorded');

      // The promotion: the project branch merged into the main that moved, and the receipt
      // LAND_PROMOTION writes for each task it carried, whose source is that task's landed commit.
      git(repo, 'merge', '--quiet', '--no-ff', '-m', `Merge refs/heads/${ids.branch} into refs/heads/main`, ids.branch);
      const promotionMerge = git(repo, 'rev-parse', 'HEAD');
      await MergeReceiptService.fromIntegrationJob(stack.db, {
        ownerId: ids.ownerId, sessionId: promoted.sessionId, taskId: promoted.taskId,
        projectId: ids.projectId, jobId: randomUUID(), state: 'LANDED',
        sourceBranch: ids.branch, targetBranch: 'main',
        sourceSha: landed, targetShaBefore: mainAfterDirect, landedSha: promotionMerge,
        rebaseBaseSha: mainAfterDirect, testedTreeSha: null, landedTreeSha: null, mainSyncSha: null,
      });

      // The premise, read off the repository: the project branch has not absorbed main since, so
      // its tip is the promotion's second parent and contains neither the merge nor the direct work.
      const projectTip = git(repo, 'rev-parse', ids.branch);
      assert.equal(git(repo, 'rev-parse', `${promotionMerge}^2`), projectTip, 'the fixture is not the shape seen in production');
      assert.equal(contains(repo, projectTip, promotionMerge), false);
      assert.equal(contains(repo, projectTip, mainAfterDirect), false);

      const afterPromoted = await resolvedSource(stack, await dependentOf(stack, ids, promoted.taskId, 'after the promoted one'));
      assert.equal(afterPromoted.reason.rank, 'P4', 'the dependent under test is not resolving on P4');
      assert.equal(afterPromoted.columns.sourceRef, `refs/heads/${ids.branch}`);
      for (const sha of afterPromoted.columns.sourceRequiredContains) {
        assert.ok(
          contains(repo, projectTip, sha),
          `the runner refuses this run: it requires ${sha}${sha === promotionMerge ? ' (upstream\'s promotion merge)' : ''}, `
            + `which the project branch it starts from (${projectTip}) does not contain`,
        );
      }
      assert.deepEqual(
        afterPromoted.columns.sourceRequiredContains, [landed],
        'the promoted prerequisite is no longer required by the commit it landed on the project branch',
      );

      // The paired hold: work that only main has is still required, and the project branch still
      // lacks it, so the runner still refuses that dependent until the line absorbs main.
      const afterDirect = await resolvedSource(stack, await dependentOf(stack, ids, direct.taskId, 'after the direct one'));
      assert.equal(afterDirect.reason.rank, 'P4', 'a prerequisite that landed on main stopped making its dependent P4');
      assert.deepEqual(
        afterDirect.columns.sourceRequiredContains, [mainAfterDirect],
        'a prerequisite whose work reached main directly is no longer required by its commit on main',
      );
    } finally {
      await stack.db.$disconnect();
      rmSync(repo, { recursive: true, force: true });
    }
  });

/**
 * The 2026-11-27 incident (project INV-A), on the receipt's half. The batch queue merged the
 * prerequisite's branch into main; the project line was a mirror of an older main; the LAND_TASK
 * found the source only inside the main sync it had just made and answered ALREADY_LANDED. The
 * runner now pushes that sync (J-S3), so the line's tip is main's, and reports it as `landedSha`.
 * The receipt has to say where the line ended up — before, an ALREADY_MERGED receipt always wrote
 * `target_sha_after` NULL — and the dependent's start has to find its prerequisite on the line.
 */
test('an ALREADY_LANDED that pushed the main sync records where the line ended up, and the dependent starts from a tip that holds its prerequisite',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const stack = connect();
    const repo = repository('already-landed-main-sync');
    try {
      const ids = await world(stack.db, 'already-landed-sync');
      const base = commitFile(repo, 'base');
      git(repo, 'branch', ids.branch);

      // The prerequisite's work, merged into main by the batch queue, never through the line.
      const prerequisite = await donePrerequisite(stack, ids, 'orbit/v13');
      git(repo, 'checkout', '--quiet', '-b', 'orbit/v13', base);
      const source = commitFile(repo, 'v13-work');
      git(repo, 'checkout', '--quiet', 'main');
      git(repo, 'merge', '--quiet', '--no-ff', '-m', 'batch merge of orbit/v13', source);
      commitFile(repo, 'main-moved-on');
      const upstream = git(repo, 'rev-parse', 'HEAD');
      assert.equal(contains(repo, ids.branch, source), false, 'the fixture is not the shape seen in production');

      // What the runner's J-S3 now does on a line with nothing of its own: fast-forward it to main.
      git(repo, 'branch', '--force', ids.branch, upstream);
      const [receiptId] = await MergeReceiptService.fromIntegrationJob(stack.db, {
        ownerId: ids.ownerId, sessionId: prerequisite.sessionId, taskId: prerequisite.taskId,
        projectId: ids.projectId, jobId: randomUUID(), state: 'ALREADY_LANDED',
        sourceBranch: 'orbit/v13', targetBranch: ids.branch,
        sourceSha: source, targetShaBefore: base, landedSha: upstream, rebaseBaseSha: base,
        testedTreeSha: null, landedTreeSha: git(repo, 'rev-parse', `${upstream}^{tree}`), mainSyncSha: null,
      });
      const receipt = await stack.db.sessionMergeReceipt.findUniqueOrThrow({
        where: { id: receiptId }, select: { result: true, targetShaAfter: true },
      });
      assert.equal(receipt.result, 'ALREADY_MERGED');
      assert.equal(receipt.targetShaAfter, upstream, 'the receipt does not name the commit the line was synced to');
      assert.ok(contains(repo, receipt.targetShaAfter!, source), 'the receipt names a line that lacks the source');

      const dependent = await resolvedSource(stack, await dependentOf(stack, ids, prerequisite.taskId, 'V14'));
      assert.equal(dependent.reason.rank, 'P4', 'the dependent under test is not resolving on P4');
      assert.equal(dependent.columns.sourceRef, `refs/heads/${ids.branch}`);
      const lineTip = git(repo, 'rev-parse', ids.branch);
      assert.deepEqual(dependent.columns.sourceRequiredContains, [source]);
      for (const sha of dependent.columns.sourceRequiredContains) {
        assert.ok(contains(repo, lineTip, sha), `DEPENDENCY_BASE_NOT_LANDED: ${lineTip} does not contain ${sha}`);
      }

      // An ALREADY_LANDED that pushed nothing keeps writing no `target_sha_after`.
      const unpushed = await donePrerequisite(stack, ids, 'orbit/unpushed');
      const [unpushedId] = await MergeReceiptService.fromIntegrationJob(stack.db, {
        ownerId: ids.ownerId, sessionId: unpushed.sessionId, taskId: unpushed.taskId,
        projectId: ids.projectId, jobId: randomUUID(), state: 'ALREADY_LANDED',
        sourceBranch: 'orbit/unpushed', targetBranch: ids.branch,
        sourceSha: base, targetShaBefore: upstream, landedSha: null, rebaseBaseSha: upstream,
        testedTreeSha: null, landedTreeSha: null, mainSyncSha: null,
      });
      const unpushedReceipt = await stack.db.sessionMergeReceipt.findUniqueOrThrow({
        where: { id: unpushedId }, select: { result: true, targetShaAfter: true },
      });
      assert.deepEqual(unpushedReceipt, { result: 'ALREADY_MERGED', targetShaAfter: null });
    } finally {
      await stack.db.$disconnect();
      rmSync(repo, { recursive: true, force: true });
    }
  });
