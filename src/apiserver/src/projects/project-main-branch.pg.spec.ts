/**
 * A project's main branch (`project_codebase.upstream_ref`): chosen by the account owner, recorded
 * with when (`upstream_ref_chosen_at`, migration 0422), remembered per account and repository, and
 * offered back to whoever chooses next (`docs/project-integration-line-contract.md` L6).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-main-branch.pg.spec.ts
 *
 * WHAT THIS FILE HOLDS IT TO
 * --------------------------
 *   (1) the start door writes the main branch it is given and records it as the owner's choice; the
 *       start's record and the coordinator's message name it; a branch that is not a full ref is 400;
 *   (2) the next project of the same account and repository is bound on the main branch chosen last
 *       — through the owner's integration door and through a start that names none — without
 *       recording a choice of its own, and a newer choice is the one remembered;
 *   (3) another repository of the same account, and the same repository of another account, are
 *       bound on main, and a choice made there reaches nothing here;
 *   (4) a project nobody started is bound on the remembered main branch at its first integration;
 *   (5) once its line has started, a different main branch is 409 INTEGRATION_LINE_LOCKED from both
 *       of the owner's doors and is kept out of a start, and nothing is recorded; naming the one it
 *       has is still recorded, and the database lets that column through while it refuses the ref;
 *   (6) an agent session's main branch is 403 INTEGRATION_SETTINGS_OWNER_ONLY and records nothing,
 *       at the start door too; the CLI at a terminal (the runner door with no session) records it;
 *   (7) GET /projects/:id/integration names the repository, the branches its coordination workspace
 *       reported (without `orbit/*`), this account's last choice and when this project's own was
 *       chosen; the project document carries the last choice; no repository means none of them;
 *   (8) a coordinator's start request keeps the main branch it suggests, names it on the card's
 *       line, is refused one with no repository, and a start answering it marks a main branch the
 *       owner did not take.
 *
 * WHAT IS REAL
 * ------------
 * The owner's doors go over HTTP through the real `ProjectsController`, validation pipe and
 * public-id interceptor; only the JWT check is replaced, so a bearer token names the caller. An
 * agent — and the CLI — reaches the server through `RunnerProjectsController`. The first integration
 * is the transaction that queues it (`enqueueForDoneTask`). Every write is read back with SQL.
 *
 * Not destructive: every case owns freshly generated ids.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  type ProjectStartRecord,
  type ProjectStartRequest,
  type ProjectStartRequestBody,
  type StartProjectRequestBody,
  uuidToBase62,
} from '@orbit/shared';
import { RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { RequestProjectStartDto } from './dto';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { enqueueForDoneTask } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** One repository as two people typed it, and the identity both are stored under. */
const REPO_URL = 'https://GitHub.com/Example/Main-Branch.git';
const REPO_URL_AGAIN = 'https://github.com/Example/Main-Branch/';
const REPO_CANONICAL = 'https://github.com/Example/Main-Branch';
const REPO_SHORT = 'Example/Main-Branch';
const OTHER_REPO_URL = 'https://github.com/Example/Another-Repository.git';

const METHOD = 'VERIFICATION';
const CRITERION = 'the project lands its work on the main branch its owner chose';

// What main.ts installs before the app serves anything: the project read carries BIGINT columns.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

interface Account { ownerId: string; runnerId: string }

interface Fixture extends Account {
  projectId: string;
  publicId: string;
  workspaceId: string;
  sessionId: string;
}

interface Binding {
  upstream_ref: string;
  integration_ref: string;
  integration_ref_source: string;
  upstream_ref_chosen_at: Date | null;
  integration_started_at: Date | null;
}

interface Answer { status: number; body: string; json: Record<string, unknown> }

test('a project’s main branch is chosen by its owner, remembered per account and repository, and '
  + 'offered back', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  // The production wiring over one client; only the publish and the queue nudge are inert.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions);
  const tasks = new TasksService(db, sessions, realtime);
  // The runner's door: how an agent — and `orbit project update` at a terminal — reaches the server.
  const runnerDoor = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => undefined } as never,
    openItems,
  );

  // ── the owner's doors, over real HTTP ────────────────────────────────────────────────────────
  const refuse = (name: string) => () => {
    throw new Error(`${name} must not be reached by this probe`);
  };
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: acceptance },
      { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
      { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
      { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
      { provide: ProjectOpenItemService, useValue: openItems },
      { provide: ProjectFuseService, useValue: { resume: refuse('the fuse') } },
      JwtAuthGuard,
      Reflector,
      // The bearer token is the caller's user id, so two accounts can knock on the same door.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
      { provide: PrismaService, useValue: db },
    ],
  })
  class MainBranchDoorModule {}

  const app = await NestFactory.create(MainBranchDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  async function call(
    caller: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
    sessionHeader?: string,
  ): Promise<Answer> {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${caller}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(sessionHeader ? { 'x-orbit-session-id': sessionHeader } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Left empty: the status assertion that follows quotes the raw body.
    }
    return { status: response.status, body: text, json };
  }

  async function refused(action: () => Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    }
    return assert.fail('the call was expected to be refused and was not');
  }

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────

  async function account(label: string): Promise<Account> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    await prisma.user.create({
      data: { id: ownerId, email: `${label}-${ownerId}@main-branch.invalid`, name: label, passwordHash: 'x' },
    });
    await prisma.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: `hash-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    });
    return { ownerId, runnerId };
  }

  /** A conversation parked where a turn appends: what a coordinator is between its turns. */
  async function conversation(who: Account, workspaceId: string, label: string): Promise<string> {
    const sessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId: who.ownerId,
        creatorId: who.ownerId,
        workspaceId,
        assignedRunnerId: who.runnerId,
        title: label,
        prompt: label,
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    await prisma.conversationTurn.create({
      data: {
        sessionId,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(sessionId),
        kind: 'message',
        content: label,
        status: 'ANSWERED',
      },
    });
    return sessionId;
  }

  /**
   * A project nobody has started, coordinated from a conversation in a workspace on the account's
   * runner whose remote is `repoUrl` (none when null), stating one criterion so a start has a seal.
   */
  async function project(who: Account, label: string, repoUrl: string | null): Promise<Fixture> {
    const workspaceId = randomUUID();
    await prisma.workspace.create({
      data: { id: workspaceId, ownerId: who.ownerId, runnerId: who.runnerId, name: `${label}-workspace`, enabled: true, repoUrl },
    });
    const sessionId = await conversation(who, workspaceId, `coordinating ${label}`);
    const projectId = randomUUID();
    await prisma.project.create({
      data: {
        id: projectId,
        ownerId: who.ownerId,
        title: `${label} project`,
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId: sessionId,
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    await projects.update(who.ownerId, projectId, {
      acceptanceCriteriaItems: [{ text: CRITERION, verificationMethod: METHOD }],
    } as never);
    return { ...who, projectId, publicId: uuidToBase62(projectId), workspaceId, sessionId };
  }

  async function seal(f: Fixture): Promise<string> {
    return (await acceptance.standardSetConfirmation(f.ownerId, f.projectId)).currentVersion.digest;
  }

  /** The start as a browser presses it. */
  async function press(f: Fixture, body: Omit<StartProjectRequestBody, 'criteriaDigest'>, sessionHeader?: string) {
    return call(f.ownerId, 'POST', `/projects/${f.publicId}/start`,
      { criteriaDigest: await seal(f), ...body }, sessionHeader);
  }

  async function integrationOf(f: Fixture): Promise<Record<string, unknown>> {
    const read = await call(f.ownerId, 'GET', `/projects/${f.publicId}/integration`);
    assert.equal(read.status, 200, read.body);
    return read.json;
  }

  async function documentOf(f: Fixture): Promise<Record<string, unknown>> {
    const read = await call(f.ownerId, 'GET', `/projects/${f.publicId}`);
    assert.equal(read.status, 200, read.body);
    return read.json.integration as Record<string, unknown>;
  }

  async function bindingOf(f: Fixture): Promise<Binding | undefined> {
    const { rows } = await sql.query<Binding>(
      `SELECT "upstream_ref", "integration_ref", "integration_ref_source", "upstream_ref_chosen_at",
              "integration_started_at"
         FROM "project_codebase" WHERE "project_id" = $1::uuid AND "slot" = 'primary'`,
      [f.projectId],
    );
    assert.ok(rows.length <= 1);
    return rows[0];
  }

  /** The owner's integration door. */
  async function configure(f: Fixture, settings: Record<string, unknown>): Promise<Answer> {
    return call(f.ownerId, 'PATCH', `/projects/${f.publicId}/integration`, settings);
  }

  /** A recorded choice falls inside the request that made it: no earlier, no later. */
  async function chosenWithin(f: Fixture, write: () => Promise<unknown>): Promise<Date> {
    const before = Date.now();
    await write();
    const after = Date.now();
    const chosen = (await bindingOf(f))?.upstream_ref_chosen_at;
    assert.ok(chosen instanceof Date, 'the choice was not recorded');
    // TIMESTAMPTZ(3) rounds to the millisecond, so allow it on both sides.
    assert.ok(chosen.getTime() >= before - 1 && chosen.getTime() <= after + 1,
      `recorded at ${chosen.toISOString()}, outside the request (${new Date(before).toISOString()} – `
        + `${new Date(after).toISOString()})`);
    return chosen;
  }

  const owner = await account('owner');

  // ═══ (1) the start door ═══════════════════════════════════════════════════════════════════════

  let firstChoice: Date | undefined;

  await t.test('(1) the start door writes the main branch it is given, as the owner’s choice', async () => {
    const f = await project(owner, 'start-master', REPO_URL);
    assert.equal(await bindingOf(f), undefined, 'the fixture project has no binding yet');

    // Not a full ref: refused by the door's own rule, before anything is written.
    const bare = await press(f, {
      line: 'MAIN', upstreamRef: 'master', automatic: false, maxConcurrentTasks: 2, mergeCheckCommand: null,
    });
    assert.equal(bare.status, 400, bare.body);
    assert.match(bare.body, /CODEBASE_AUTHORITY_INVALID: upstreamRef must be a full branch ref/);
    assert.equal(await bindingOf(f), undefined);

    let sent: Answer | undefined;
    firstChoice = await chosenWithin(f, async () => {
      sent = await press(f, {
        line: 'MAIN', upstreamRef: 'refs/heads/master', automatic: false, maxConcurrentTasks: 2, mergeCheckCommand: null,
      });
    });
    assert.equal(sent!.status, 201, sent!.body);
    const settings = {
      line: 'MAIN', upstreamRef: 'refs/heads/master', automatic: false, maxConcurrentTasks: 2, mergeCheckCommand: null,
    };
    assert.deepEqual(sent!.json.settings, settings);
    assert.deepEqual(sent!.json.differsFromRequest, []);

    const row = await bindingOf(f);
    assert.equal(row?.upstream_ref, 'refs/heads/master');
    assert.equal(row?.integration_ref, 'refs/heads/master', 'main is the line, and main is master');
    assert.equal(row?.integration_ref_source, 'EXPLICIT');
    assert.equal(row?.integration_started_at, null);

    const { rows: [confirmation] } = await sql.query<{ started_with: ProjectStartRecord }>(
      `SELECT "started_with" FROM "project_standard_set_confirmation" WHERE "project_id" = $1::uuid`,
      [f.projectId],
    );
    assert.deepEqual(confirmation.started_with, { settings, differsFromRequest: [] },
      'the start records the main branch it left the project on');

    // The coordinator is told where the work goes, by the branch's own name.
    const { rows: told } = await sql.query<{ content: string }>(
      `SELECT "content" FROM "conversation_turn"
        WHERE "session_id" = $1::uuid AND "client_turn_id" LIKE 'project-started:v1:%'`,
      [f.sessionId],
    );
    assert.equal(told.length, 1);
    assert.ok(told[0].content.includes('It runs with: tasks land directly into master · Automatic off'),
      told[0].content);

    // A project branch takes a main branch too: the branch it is merged into.
    const branched = await project(owner, 'start-branch-develop', OTHER_REPO_URL);
    const onBranch = await press(branched, {
      line: 'PROJECT_BRANCH', upstreamRef: 'refs/heads/develop', automatic: false, maxConcurrentTasks: 1,
      mergeCheckCommand: null,
    });
    assert.equal(onBranch.status, 201, onBranch.body);
    const branchedRow = await bindingOf(branched);
    assert.equal(branchedRow?.upstream_ref, 'refs/heads/develop');
    assert.equal(branchedRow?.integration_ref, `refs/heads/project/${branched.publicId}`);
    assert.ok(branchedRow?.upstream_ref_chosen_at instanceof Date);
  });

  // ═══ (2) the next project of the same account and repository ═══════════════════════════════

  await t.test('(2) the next project on the same repository is bound on the main branch chosen last', async () => {
    // The same repository, typed the other way: identity is the canonical URL.
    const next = await project(owner, 'remembered-by-patch', REPO_URL_AGAIN);
    const offered = await integrationOf(next);
    assert.equal(offered.upstreamRef, null, 'nothing is bound yet');
    assert.equal(offered.upstreamChosenAt, null);
    assert.equal(offered.repository, REPO_SHORT);
    assert.deepEqual(offered.lastMainBranch,
      { branch: 'master', repository: REPO_SHORT, chosenAt: firstChoice!.toISOString() },
      'the last choice for this repository is offered before anything binds');

    // The owner's integration door binds it — naming the line, not the main branch.
    const chosen = await configure(next, { line: 'PROJECT_BRANCH' });
    assert.equal(chosen.status, 200, chosen.body);
    const row = await bindingOf(next);
    assert.equal(row?.upstream_ref, 'refs/heads/master', 'bound on the main branch chosen last');
    assert.equal(row?.integration_ref, `refs/heads/project/${next.publicId}`);
    assert.equal(row?.upstream_ref_chosen_at, null,
      'carrying the owner’s last choice is not a choice of this project’s');
    const view = await integrationOf(next);
    assert.equal(view.upstreamRef, 'master');
    assert.equal(view.upstreamChosenAt, null);

    // A start that names no main branch binds the same way, and records none.
    const started = await project(owner, 'remembered-by-start', REPO_URL);
    const pressed = await press(started, {
      line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null,
    });
    assert.equal(pressed.status, 201, pressed.body);
    assert.deepEqual(pressed.json.settings,
      { line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null },
      'a start that named no main branch records none');
    const startedRow = await bindingOf(started);
    assert.equal(startedRow?.upstream_ref, 'refs/heads/master');
    assert.equal(startedRow?.integration_ref, 'refs/heads/master');
    assert.equal(startedRow?.upstream_ref_chosen_at, null);

    // A newer choice is the one remembered: `integration` on a project update names develop.
    const changed = await project(owner, 'changes-its-mind', REPO_URL);
    let updated: Answer | undefined;
    const secondChoice = await chosenWithin(changed, async () => {
      updated = await call(changed.ownerId, 'PATCH', `/projects/${changed.publicId}`,
        { integration: { upstreamRef: 'refs/heads/develop' } });
    });
    assert.equal(updated!.status, 200, updated!.body);
    assert.ok(secondChoice > firstChoice!);
    const after = await project(owner, 'after-the-change', REPO_URL);
    assert.deepEqual((await integrationOf(after)).lastMainBranch,
      { branch: 'develop', repository: REPO_SHORT, chosenAt: secondChoice.toISOString() });
    assert.equal((await configure(after, { line: 'MAIN' })).status, 200);
    assert.equal((await bindingOf(after))?.upstream_ref, 'refs/heads/develop');
    // And the earlier projects keep the branch they were bound on.
    assert.equal((await bindingOf(next))?.upstream_ref, 'refs/heads/master');
  });

  // ═══ (3) another repository, another account ═══════════════════════════════════════════════

  await t.test('(3) another repository and another account start from main, and reach nothing here', async () => {
    const elsewhere = await project(owner, 'another-repository', 'https://github.com/Example/Third-Repository');
    assert.equal((await integrationOf(elsewhere)).lastMainBranch, null,
      'this account never chose a main branch for that repository');
    assert.equal((await configure(elsewhere, { line: 'MAIN' })).status, 200);
    assert.equal((await bindingOf(elsewhere))?.upstream_ref, 'refs/heads/main');

    const stranger = await account('stranger');
    const theirs = await project(stranger, 'same-repository-other-account', REPO_URL);
    const offered = await integrationOf(theirs);
    assert.equal(offered.repository, REPO_SHORT);
    assert.equal(offered.lastMainBranch, null, 'another account’s choices are not this one’s');
    assert.equal((await configure(theirs, { line: 'MAIN' })).status, 200);
    assert.equal((await bindingOf(theirs))?.upstream_ref, 'refs/heads/main');

    // The other account chooses trunk for the same repository: the owner's memory does not move.
    assert.equal((await configure(theirs, { upstreamRef: 'refs/heads/trunk' })).status, 200);
    const mine = await project(owner, 'unmoved-by-the-stranger', REPO_URL);
    assert.equal(((await integrationOf(mine)).lastMainBranch as { branch?: string }).branch, 'develop');
    assert.equal((await configure(mine, { line: 'MAIN' })).status, 200);
    assert.equal((await bindingOf(mine))?.upstream_ref, 'refs/heads/develop');
    // Nor does a choice for another repository of the same account.
    assert.equal((await configure(elsewhere, { upstreamRef: 'refs/heads/stable' })).status, 200);
    assert.equal(((await integrationOf(mine)).lastMainBranch as { branch?: string }).branch, 'develop');
  });

  // ═══ (4) the first integration of a project nobody started ═════════════════════════════════

  let integrated: Fixture | undefined;

  await t.test('(4) a project nobody started is bound on the remembered main branch at its first '
    + 'integration', async () => {
    const f = await project(owner, 'first-integration', REPO_URL);
    integrated = f;
    const created = await tasks.create(f.ownerId, {
      title: 'first-integration: the only code task',
      projectId: f.projectId,
      autoRunWhenReady: false,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await prisma.session.create({
      data: {
        id: randomUUID(),
        ownerId: f.ownerId,
        creatorId: f.ownerId,
        taskId: created.id,
        workspaceId: f.workspaceId,
        assignedRunnerId: f.runnerId,
        title: 'first-integration work',
        prompt: 'first-integration work',
        provider: 'claude',
        status: RunStatus.SUCCEEDED,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: true,
        isolationStatus: 'worktree',
        branch: `orbit/first-integration-${f.publicId}`,
      },
    });
    await prisma.task.update({ where: { id: created.id }, data: { status: TaskStatus.DONE } });

    const outcome = await prisma.$transaction((tx) => enqueueForDoneTask(tx, f.ownerId, created.id));
    assert.equal(outcome.enqueued, true, JSON.stringify(outcome));
    const row = await bindingOf(f);
    assert.equal(row?.upstream_ref, 'refs/heads/develop', 'the first integration binds on the remembered branch');
    assert.equal(row?.integration_ref, 'refs/heads/develop', 'one code task: straight onto that main branch');
    assert.equal(row?.integration_ref_source, 'DEFAULT_RULE');
    assert.ok(row?.integration_started_at instanceof Date);
    assert.equal(row?.upstream_ref_chosen_at, null);
    // A line straight onto the main branch offers the task's branch as a merge candidate: the job
    // the DONE queued is aimed at that branch.
    assert.ok(outcome.enqueued);
    const { rows: jobs } = await sql.query<{ target_ref: string; upstream_ref: string }>(
      `SELECT "target_ref", "upstream_ref" FROM "project_integration_job" WHERE "id" = $1::uuid`,
      [outcome.jobId],
    );
    assert.deepEqual(jobs, [{ target_ref: 'refs/heads/develop', upstream_ref: 'refs/heads/develop' }],
      'and what the DONE queued is aimed at it');
    const view = await integrationOf(f);
    assert.equal(view.upstreamRef, 'develop');
    assert.equal(view.locked, true);
    assert.equal(view.upstreamChosenAt, null);
  });

  // ═══ (5) a line that has started ═══════════════════════════════════════════════════════════

  await t.test('(5) once the line started, another main branch is 409 and nothing is recorded', async () => {
    const f = integrated!;
    const before = await bindingOf(f);
    assert.ok(before?.integration_started_at, 'the line has started');

    const viaIntegration = await configure(f, { upstreamRef: 'refs/heads/main' });
    assert.equal(viaIntegration.status, 409, viaIntegration.body);
    assert.equal(viaIntegration.json.code, 'INTEGRATION_LINE_LOCKED');
    const viaUpdate = await call(f.ownerId, 'PATCH', `/projects/${f.publicId}`,
      { integration: { upstreamRef: 'refs/heads/main' } });
    assert.equal(viaUpdate.status, 409, viaUpdate.body);
    assert.equal(viaUpdate.json.code, 'INTEGRATION_LINE_LOCKED');
    assert.deepEqual(await bindingOf(f), before, 'a refused choice wrote nothing, its time included');

    // The start keeps the line and the main branch it is on, records no choice, and says so.
    const started = await press(f, {
      line: 'MAIN', upstreamRef: 'refs/heads/main', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null,
    });
    assert.equal(started.status, 201, started.body);
    assert.equal(started.json.lineLocked, true);
    assert.deepEqual(started.json.settings, {
      line: 'MAIN', upstreamRef: 'refs/heads/develop', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null,
    });
    assert.deepEqual(started.json.differsFromRequest, ['line']);
    assert.deepEqual(await bindingOf(f), before);

    // Naming the main branch it already has moves nothing, and is the owner's choice all the same.
    const same = await chosenWithin(f, async () => {
      const answer = await configure(f, { upstreamRef: 'refs/heads/develop' });
      assert.equal(answer.status, 200, answer.body);
    });
    assert.equal((await integrationOf(f)).upstreamChosenAt, same.toISOString());
    const { rows: [unmoved] } = await sql.query<{ upstream_ref: string; integration_ref: string }>(
      `SELECT "upstream_ref", "integration_ref" FROM "project_codebase" WHERE "project_id" = $1::uuid`,
      [f.projectId],
    );
    assert.deepEqual(unmoved, { upstream_ref: 'refs/heads/develop', integration_ref: 'refs/heads/develop' });

    // 0270's lock refuses the ref and lets the choice column through.
    await assert.rejects(sql.query(
      `UPDATE "project_codebase" SET "upstream_ref" = 'refs/heads/main' WHERE "project_id" = $1::uuid`,
      [f.projectId],
    ), (error: Error) => /^INTEGRATION_LINE_LOCKED\b/.test(error.message));
    const through = await sql.query(
      `UPDATE "project_codebase" SET "upstream_ref_chosen_at" = now() - interval '1 second'
        WHERE "project_id" = $1::uuid`,
      [f.projectId],
    );
    assert.equal(through.rowCount, 1);
  });

  // ═══ (6) an agent session, and the CLI ═════════════════════════════════════════════════════

  await t.test('(6) an agent session’s main branch is 403 and records nothing; the CLI at a terminal '
    + 'records it', async () => {
    const f = await project(owner, 'agent-door', REPO_URL);
    const runner = { id: f.runnerId, ownerId: f.ownerId } as never;

    const refusal = await refused(() => runnerDoor.updateProject(runner, f.projectId, f.sessionId,
      { integration: { upstreamRef: 'refs/heads/master' } } as never));
    assert.equal(refusal.status, 403);
    assert.equal(refusal.body.code, 'INTEGRATION_SETTINGS_OWNER_ONLY');
    assert.equal(await bindingOf(f), undefined, 'a refused write bound nothing and recorded nothing');

    // The start door refuses a session's start whole, main branch and all.
    const fromSession = await press(f, {
      line: 'MAIN', upstreamRef: 'refs/heads/master', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null,
    }, uuidToBase62(f.sessionId));
    assert.equal(fromSession.status, 403, fromSession.body);
    assert.equal(await bindingOf(f), undefined);

    // `orbit project update --upstream-ref` at a terminal: the same door with no session.
    const chosen = await chosenWithin(f, () => runnerDoor.updateProject(runner, f.projectId, undefined,
      { integration: { upstreamRef: 'refs/heads/release' } } as never));
    assert.equal((await bindingOf(f))?.upstream_ref, 'refs/heads/release');
    assert.deepEqual((await integrationOf(f)).lastMainBranch,
      { branch: 'release', repository: REPO_SHORT, chosenAt: chosen.toISOString() });
  });

  // ═══ (7) what the main branch is chosen from ═══════════════════════════════════════════════

  await t.test('(7) GET /projects/:id/integration names the repository, the branches, the last choice '
    + 'and when this one was chosen', async () => {
    const reader = await account('reader');
    const f = await project(reader, 'branches', REPO_URL);
    const workSession = async (workspaceId: string, label: string, mergeTargets: string[], extra: {
      createdAt: Date; deletedAt?: Date;
    }) => {
      const id = randomUUID();
      await prisma.session.create({
        data: {
          id,
          ownerId: f.ownerId,
          creatorId: f.ownerId,
          workspaceId,
          assignedRunnerId: f.runnerId,
          title: label,
          prompt: label,
          provider: 'claude',
          status: RunStatus.SUCCEEDED,
          dispatchOrigin: SessionDispatchOrigin.USER,
          mergeTargets,
          ...extra,
        },
      });
      return id;
    };
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    // Oldest to newest: an older report, the newest one, then three that are not it — one with no
    // report, one in the Trash, and one in another workspace.
    await workSession(f.workspaceId, 'older report', ['main', 'stale'], { createdAt: minutesAgo(50) });
    const newest = await workSession(f.workspaceId, 'newest report',
      ['develop', 'main', 'orbit/session-1a2b3c', 'project/next', 'release'], { createdAt: minutesAgo(40) });
    await workSession(f.workspaceId, 'no report', [], { createdAt: minutesAgo(30) });
    await workSession(f.workspaceId, 'trashed', ['trashed-branch'], { createdAt: minutesAgo(20), deletedAt: new Date() });
    const otherWorkspace = randomUUID();
    await prisma.workspace.create({
      data: { id: otherWorkspace, ownerId: f.ownerId, runnerId: f.runnerId, name: 'elsewhere', enabled: true, repoUrl: REPO_URL },
    });
    await workSession(otherWorkspace, 'elsewhere', ['elsewhere-branch'], { createdAt: minutesAgo(10) });
    const reported = await prisma.session.findUniqueOrThrow({ where: { id: newest }, select: { updatedAt: true } });

    const before = await integrationOf(f);
    assert.equal(before.repository, REPO_SHORT, 'unbound: the coordination workspace’s repository');
    assert.deepEqual(before.branches, {
      names: ['develop', 'main', 'project/next', 'release'],
      workspaceName: 'branches-workspace',
      reportedAt: reported.updatedAt.toISOString(),
    });
    assert.equal(before.lastMainBranch, null, 'this account has chosen nothing yet');
    assert.equal(before.upstreamChosenAt, null);
    assert.equal(before.upstreamRef, null);

    const chosen = await chosenWithin(f, async () => {
      assert.equal((await configure(f, { upstreamRef: 'refs/heads/release' })).status, 200);
    });
    const after = await integrationOf(f);
    assert.equal(after.repository, REPO_SHORT, 'bound: the binding’s repository');
    assert.equal(after.upstreamRef, 'release');
    assert.equal(after.upstreamChosenAt, chosen.toISOString());
    assert.deepEqual(after.lastMainBranch,
      { branch: 'release', repository: REPO_SHORT, chosenAt: chosen.toISOString() });
    assert.deepEqual(after.branches, before.branches);

    // The project document carries the last choice — what a coordinator reads before it asks to
    // start — and when this project's own was chosen.
    const doc = await documentOf(f);
    assert.deepEqual(doc.lastMainBranch, after.lastMainBranch);
    assert.equal(doc.upstreamChosenAt, chosen.toISOString());
    const unbound = await project(reader, 'branches-unbound', REPO_URL_AGAIN);
    assert.deepEqual((await documentOf(unbound)).lastMainBranch, after.lastMainBranch,
      'an unbound project of the same repository is offered it too');

    // No repository: nothing to choose, nothing remembered, nothing offered.
    const nowhere = await project(reader, 'no-repository', null);
    const empty = await integrationOf(nowhere);
    assert.equal(empty.repository, null);
    assert.equal(empty.lastMainBranch, null);
    assert.equal(empty.branches, null, 'its workspace reported nothing');
    assert.equal((await documentOf(nowhere)).lastMainBranch, null);
  });

  // ═══ (8) the coordinator's start request ═══════════════════════════════════════════════════

  await t.test('(8) a coordinator’s start request keeps the main branch it suggests', async () => {
    const asker = await account('asker');
    const runner = { id: asker.runnerId, ownerId: asker.ownerId } as never;
    const planned = async (label: string, repoUrl: string | null) => {
      const f = await project(asker, label, repoUrl);
      const [definition] = await prisma.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: f.projectId }, select: { id: true },
      });
      await prisma.task.create({
        data: {
          ownerId: f.ownerId,
          projectId: f.projectId,
          title: `${label}: the work`,
          creatorType: 'USER',
          creatorId: f.ownerId,
          assigneeId: f.workspaceId,
          status: TaskStatus.OPEN,
          completionCriterion: 'EXECUTABLE',
          acceptanceCommand: 'true',
          acceptanceExpectedExitCode: 0,
          autoRunWhenReady: true,
          criterionDefinitionId: definition.id,
        },
      });
      return f;
    };
    const suggestion: ProjectStartRequestBody = {
      line: 'MAIN',
      upstreamRef: 'refs/heads/master',
      automatic: true,
      maxConcurrentTasks: 2,
      mergeCheckCommand: 'npm test',
      why: 'one task, straight onto the repository’s main branch',
    };

    // The door's own rule, the same one the start door holds a main branch to.
    const malformed = await validate(plainToInstance(RequestProjectStartDto, { ...suggestion, upstreamRef: 'master' }));
    assert.deepEqual(malformed.map((error) => error.property), ['upstreamRef']);
    assert.deepEqual(await validate(plainToInstance(RequestProjectStartDto, suggestion)), []);

    const f = await planned('asked', REPO_URL);
    const filed = await runnerDoor.requestStart(runner, f.sessionId, f.projectId, suggestion as never);
    assert.equal(filed.settings.upstreamRef, 'refs/heads/master');
    const { rows: [stored] } = await sql.query<{ payload: ProjectStartRequest }>(
      `SELECT "payload" FROM "project_open_item"
        WHERE "project_id" = $1::uuid AND "kind" = 'START_REQUEST' AND "state" = 'OPEN'`,
      [f.projectId],
    );
    assert.equal(stored.payload.settings.upstreamRef, 'refs/heads/master', 'the request keeps it as suggested');
    const view = await openItems.list(f.ownerId, f.projectId);
    assert.equal(view.startRequest?.detailLine,
      'Directly into master · Automatic on · 2 tasks at a time · merge check set');
    assert.equal(await bindingOf(f), undefined, 'a suggestion binds nothing and records nothing');

    // A start that answers it on a client with no Main branch row: the project is bound on main —
    // this account never chose one for the repository — and the start says it is not what was asked.
    const answered = await acceptance.startProject(f.ownerId, f.projectId, {
      criteriaDigest: await seal(f),
      line: 'MAIN',
      automatic: false,
      maxConcurrentTasks: 2,
      mergeCheckCommand: 'npm test',
      requestId: filed.itemId,
    });
    assert.equal(answered.settings.upstreamRef, 'refs/heads/main');
    assert.deepEqual(answered.differsFromRequest, ['line', 'automatic']);
    assert.equal((await bindingOf(f))?.upstream_ref_chosen_at, null);

    // Answered with the branch it suggested: nothing differs, and the owner's choice is recorded.
    const taken = await planned('asked-and-taken', REPO_URL);
    const again = await runnerDoor.requestStart(runner, taken.sessionId, taken.projectId, suggestion as never);
    const agreed = await acceptance.startProject(taken.ownerId, taken.projectId, {
      criteriaDigest: await seal(taken),
      line: 'MAIN',
      upstreamRef: 'refs/heads/master',
      automatic: true,
      maxConcurrentTasks: 2,
      mergeCheckCommand: 'npm test',
      requestId: again.itemId,
    });
    assert.deepEqual(agreed.differsFromRequest, []);
    assert.equal((await bindingOf(taken))?.upstream_ref, 'refs/heads/master');
    assert.ok((await bindingOf(taken))?.upstream_ref_chosen_at instanceof Date);

    // A main branch is a branch of a repository: suggested for a project with none, refused.
    const nowhere = await planned('asked-without-repository', null);
    const refusal = await refused(() => runnerDoor.requestStart(runner, nowhere.sessionId, nowhere.projectId, {
      ...suggestion, mergeCheckCommand: null,
    } as never));
    assert.equal(refusal.status, 409);
    assert.equal(refusal.body.code, 'START_REQUEST_NOT_READY');
    const findings = refusal.body.findings as Array<{ code: string; requiredAction: string }>;
    assert.deepEqual(findings.map((finding) => finding.code), ['START_REPOSITORY_UNKNOWN']);
    assert.match(findings[0].requiredAction, /suggest line MAIN with no merge check and no upstreamRef\.$/);
    // And without one, the same plan is filed.
    const { upstreamRef: _dropped, ...withoutUpstream } = suggestion;
    const plain = await runnerDoor.requestStart(runner, nowhere.sessionId, nowhere.projectId, {
      ...withoutUpstream, mergeCheckCommand: null,
    } as never);
    assert.equal(plain.settings.upstreamRef, undefined);
    assert.equal((await openItems.list(nowhere.ownerId, nowhere.projectId)).startRequest?.detailLine,
      'Directly into main · Automatic on · 2 tasks at a time · no merge check',
      'a request that suggests no main branch reads as it always has');
  });
});
