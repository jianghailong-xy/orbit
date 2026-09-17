import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../common/current-user.decorator';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import type { SessionTagsService } from '../session-tags/session-tags.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * A code project's integration line: recorded, decided by the default rule at the first
 * integration when nobody chose, locked once integration started, the branch "landed" is read
 * against, and never written back as the shared workspace's default merge target.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-integration-ref.pg.spec.ts
 *
 * Project acceptance criterion 4, cases as `docs/project-integration-line-contract.md` §1.7 lists
 * them, plus §8.8's C1 compatibility case and L5's owner-only door.
 *
 * WHAT IS REAL
 * ============
 * The owner's settings and reads go over HTTP through the real `ProjectsController`, validation
 * pipe and public-id interceptor; only the JWT check is replaced, so a bearer token names the
 * caller. An agent's write goes through `RunnerProjectsController`, the door MCP and the CLI use.
 * Merges are queued through the two real doors that queue them — the runner's, which agents use,
 * and the owner's own Merge menu. Landing is read off receipts recorded through
 * `MergeReceiptService`.
 *
 * WHY THE FIRST INTEGRATION IS REACHED AT RUN TIME
 * ================================================
 * Nothing on an HTTP route integrates: the platform does, inside the transaction that queues the
 * first integration job. So cases 2–4 call `startOnFirstIntegration` the way that transaction will,
 * and they load its module with `require` rather than `import`. An import would make this whole
 * file a compile error on the tree before the change, and then no case could fail on the assertion
 * that names what is missing — the landing case least of all, whose red has to say UNKNOWN.
 *
 * Case 5 writes its binding with the columns 0231 created and nothing else for the same reason:
 * the rows it reads have to exist on both trees.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** The declaration every piece of work here carries. */
const CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

/** The coordination workspace's remote as somebody typed it, and the identity stored for it. */
const REPO_URL = 'https://GitHub.com/Example/Integration-Ref.git';
const CANONICAL_REPO_URL = 'https://github.com/Example/Integration-Ref';

const sha = (nibble: string) => nibble.repeat(40);

// What main.ts installs before the app serves anything: the project read carries BIGINT columns,
// and without this JSON.stringify refuses them and every read of a real project is a 500.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sql: Client;
  realtime: RealtimeService;
  sessions: SessionsService;
  tasks: TasksService;
  projects: ProjectsService;
  receipts: MergeReceiptService;
}

async function connect(): Promise<Stack> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    prisma,
    sql,
    realtime,
    sessions,
    // No completion-input router: nothing here is about the facts a task write or a receipt moves.
    tasks: new TasksService(prisma, sessions, realtime),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    receipts: new MergeReceiptService(prisma),
  };
}

async function disconnect(stack: Stack): Promise<void> {
  await stack.db.$disconnect().catch(() => undefined);
  await stack.sql.end().catch(() => undefined);
}

/** The owner's HTTP surface for projects, with a guard that takes the bearer token as the caller. */
async function openDoor(stack: Stack): Promise<{ base: string; close: () => Promise<void> }> {
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: stack.projects },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
      { provide: ProjectOpenItemService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
      { provide: PrismaService, useValue: stack.prisma },
    ],
  })
  class IntegrationDoorModule {}

  const app = await NestFactory.create(IntegrationDoorModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  return { base: await app.getUrl(), close: () => app.close() };
}

async function call(
  base: string,
  caller: string,
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${caller}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  publicId: string;
  coordinatorSessionId: string;
}

/**
 * One owner, one runner, and one project coordinated from a workspace that names its remote.
 * The workspace's merge default is `main`, which is what case 6 watches for movement.
 */
async function project(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@integration-ref.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
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
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: REPO_URL,
      defaultMergeTarget: 'main',
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `协调：${label}`,
      prompt: `协调：${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `协调：${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 的代码项目`,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return {
    ownerId,
    runnerId,
    workspaceId,
    projectId,
    publicId: uuidToBase62(projectId),
    coordinatorSessionId,
  };
}

/** A piece of code work filed under the project. Never auto-run: nothing here dispatches. */
async function codeTask(
  stack: Stack,
  f: Fixture,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await stack.tasks.create(f.ownerId, {
    title,
    projectId: f.projectId,
    autoRunWhenReady: false,
    ...CHECK,
    ...extra,
  } as never);
  return created.id;
}

/** The worktree session that did a task's work (or, with no task, some other session's). */
async function workSession(
  stack: Stack,
  f: Fixture,
  taskId: string | null,
  label: string,
): Promise<string> {
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: taskId !== null,
      isolationStatus: 'worktree',
      branch: `orbit/${label}`,
    },
  });
  return sessionId;
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]): Promise<string[]> {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems).map((item) => item.key);
}

/** One criterion per branch, each served by one task whose session merged into that branch. */
async function landEach(stack: Stack, f: Fixture, into: Record<string, string>): Promise<void> {
  const texts = Object.keys(into);
  const keys = await state(stack, f, texts);
  for (const [index, text] of texts.entries()) {
    const taskId = await codeTask(stack, f, `${f.publicId}: ${text}`, { criterionKey: keys[index] });
    const sessionId = await workSession(stack, f, taskId, `${f.publicId}-${index}`);
    const recorded = await stack.receipts.record(f.ownerId, sessionId, {
      result: 'MERGED',
      targetBranch: into[text],
      sourceSha: sha('a'),
      targetShaBefore: sha('b'),
      targetShaAfter: sha('c'),
    } as never, 'AGENT');
    assert.equal(recorded.created, true, `the receipt into ${into[text]} was not recorded`);
  }
}

/** Each criterion's landing, by its text, as the project read serves it to a client. */
async function landings(door: { base: string }, f: Fixture): Promise<Record<string, string>> {
  const read = await call(door.base, f.ownerId, 'GET', `/api/projects/${f.publicId}`);
  assert.equal(read.status, 200, read.body);
  const items = read.json.acceptanceCriteriaItems as Array<{ text: string; landing: string }>;
  return Object.fromEntries(items.map((item) => [item.text, item.landing]));
}

async function integrationOf(door: { base: string }, f: Fixture): Promise<Record<string, unknown>> {
  const read = await call(door.base, f.ownerId, 'GET', `/api/projects/${f.publicId}/integration`);
  assert.equal(read.status, 200, `GET /projects/:id/integration answered ${read.status}: ${read.body}`);
  return read.json;
}

/** The part of the integration view that says which line this is and who decided it. */
function lineOf(view: Record<string, unknown> | undefined) {
  return {
    line: view?.line,
    ref: view?.ref,
    upstreamRef: view?.upstreamRef,
    source: view?.source,
    locked: view?.locked,
  };
}

const NOT_DECIDED = { line: null, ref: null, upstreamRef: null, source: null, locked: false };

/** What `project-integration-line.ts` exposes to the transaction that queues an integration. */
interface IntegrationLineModule {
  startOnFirstIntegration(
    tx: unknown,
    first: { ownerId: string; projectId: string; taskId: string },
  ): Promise<unknown>;
}

/** Integrate one code task for the first time, the way the integration queue's transaction will. */
async function integrate(stack: Stack, f: Fixture, taskId: string): Promise<void> {
  let line: IntegrationLineModule | null = null;
  try {
    line = require('./project-integration-line') as IntegrationLineModule;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }
  assert.ok(line?.startOnFirstIntegration,
    'nothing records a project’s integration line at its first integration: '
      + '`project-integration-line.ts#startOnFirstIntegration` does not exist');
  await stack.db.$transaction((tx) => line.startOnFirstIntegration(tx, {
    ownerId: f.ownerId,
    projectId: f.projectId,
    taskId,
  }));
}

async function codebaseRow(stack: Stack, f: Fixture) {
  const read = await stack.sql.query(
    `SELECT * FROM "project_codebase" WHERE "project_id" = $1::uuid AND "slot" = 'primary'`,
    [f.projectId],
  );
  return read.rows as Array<Record<string, unknown>>;
}

async function defaultMergeTargetOf(stack: Stack, f: Fixture): Promise<string | null> {
  const workspace = await stack.db.workspace.findUniqueOrThrow({
    where: { id: f.workspaceId },
    select: { defaultMergeTarget: true },
  });
  return workspace.defaultMergeTarget;
}

/** The trigger's refusal, which names the rule before anything else. */
const LOCKED_BY_THE_DATABASE = (error: Error) => /^INTEGRATION_LINE_LOCKED\b/.test(error.message);

test('a project’s integration line is recorded, defaulted, locked, read for landing, and never '
  + 'written back as the workspace merge default', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const stack = await connect();
  const door = await openDoor(stack);
  t.after(async () => {
    await door.close();
    await disconnect(stack);
  });

  await t.test('explicit integration settings read back', async () => {
    const f = await project(stack, 'explicit');

    const chosen = await call(door.base, f.ownerId, 'PATCH',
      `/api/projects/${f.publicId}/integration`, { line: 'MAIN' });
    assert.equal(chosen.status, 200,
      `the owner's choice of integration line was not accepted (${chosen.status}): ${chosen.body}`);
    assert.deepEqual(lineOf(await integrationOf(door, f)),
      { line: 'MAIN', ref: 'main', upstreamRef: 'main', source: 'EXPLICIT', locked: false });

    // L-T2: before anything integrated, the owner may change their mind, and the project branch
    // is named after the project's public id (appendix A-Q1).
    const changed = await call(door.base, f.ownerId, 'PATCH',
      `/api/projects/${f.publicId}/integration`, { line: 'PROJECT_BRANCH' });
    assert.equal(changed.status, 200, changed.body);
    const expected = {
      line: 'PROJECT_BRANCH',
      ref: `project/${f.publicId}`,
      upstreamRef: 'main',
      source: 'EXPLICIT',
      locked: false,
    };
    assert.deepEqual(lineOf(await integrationOf(door, f)), expected);

    // The row is the one `project_codebase` binding, with the repository named by the project's
    // coordination workspace, in the form its CHECK accepts.
    assert.deepEqual((await codebaseRow(stack, f)).map((row) => ({
      integration_ref: row.integration_ref,
      upstream_ref: row.upstream_ref,
      canonical_repo_url: row.canonical_repo_url,
      integration_ref_source: row.integration_ref_source,
      integration_started_at: row.integration_started_at,
    })), [{
      integration_ref: `refs/heads/project/${f.publicId}`,
      upstream_ref: 'refs/heads/main',
      canonical_repo_url: CANONICAL_REPO_URL,
      integration_ref_source: 'EXPLICIT',
      integration_started_at: null,
    }]);

    // And the project read MCP's project_get and the CLI serve carries the same line.
    const read = await call(door.base, f.ownerId, 'GET', `/api/projects/${f.publicId}`);
    assert.equal(read.status, 200, read.body);
    assert.deepEqual(lineOf(read.json.integration as Record<string, unknown> | undefined), expected);
  });

  await t.test('with no explicit choice, dependent code tasks record a project branch at the first '
    + 'integration', async () => {
    const f = await project(stack, 'dependent');
    const prerequisite = await codeTask(stack, f, 'dependent: the prerequisite');
    await codeTask(stack, f, 'dependent: the work that waits for it',
      { dependsOnTaskIds: [prerequisite] });
    await workSession(stack, f, prerequisite, `dependent-${f.publicId}`);

    const before = await integrationOf(door, f);
    assert.deepEqual(lineOf(before), NOT_DECIDED,
      'nothing integrated yet and nobody chose: there is no line to report');
    assert.equal(before.lineAbsentReason, 'NOT_DECIDED');

    await integrate(stack, f, prerequisite);

    assert.deepEqual(lineOf(await integrationOf(door, f)), {
      line: 'PROJECT_BRANCH',
      ref: `project/${f.publicId}`,
      upstreamRef: 'main',
      source: 'DEFAULT_RULE',
      locked: true,
    }, 'two code tasks with a dependency between them go through a project branch');
    const [row] = await codebaseRow(stack, f);
    assert.equal(row?.canonical_repo_url, CANONICAL_REPO_URL,
      'the repository is the one the integrated task’s session worked in');
    assert.ok(row?.integration_started_at instanceof Date, 'the line records when it started');
  });

  await t.test('with no explicit choice, a single code task records main at the first integration',
    async () => {
      const f = await project(stack, 'single');
      const only = await codeTask(stack, f, 'single: the only code task');
      await workSession(stack, f, only, `single-${f.publicId}`);

      await integrate(stack, f, only);

      assert.deepEqual(lineOf(await integrationOf(door, f)),
        { line: 'MAIN', ref: 'main', upstreamRef: 'main', source: 'DEFAULT_RULE', locked: true },
        'one code task with nothing depending on it goes straight to main');
    });

  await t.test('switching the line after integration started is refused INTEGRATION_LINE_LOCKED',
    async () => {
      const f = await project(stack, 'locked');
      const only = await codeTask(stack, f, 'locked: the only code task');
      await workSession(stack, f, only, `locked-${f.publicId}`);
      await integrate(stack, f, only);

      // The service's refusal, over the owner's own door.
      const refused = await call(door.base, f.ownerId, 'PATCH',
        `/api/projects/${f.publicId}/integration`, { line: 'PROJECT_BRANCH' });
      assert.equal(refused.status, 409, refused.body);
      assert.equal(refused.json.code, 'INTEGRATION_LINE_LOCKED', refused.body);
      assert.deepEqual(lineOf(await integrationOf(door, f)),
        { line: 'MAIN', ref: 'main', upstreamRef: 'main', source: 'DEFAULT_RULE', locked: true });

      // What does not move the line is still the owner's to change after it started (L4).
      const check = await call(door.base, f.ownerId, 'PATCH',
        `/api/projects/${f.publicId}/integration`, { mergeCheckCommand: 'npm test' });
      assert.equal(check.status, 200, check.body);
      assert.equal((await integrationOf(door, f)).mergeCheckCommand, 'npm test');

      // The database's refusal, for a writer that never asked the service.
      await assert.rejects(stack.sql.query(
        `UPDATE "project_codebase" SET "integration_ref" = $2 WHERE "project_id" = $1::uuid`,
        [f.projectId, `refs/heads/project/${f.publicId}`],
      ), LOCKED_BY_THE_DATABASE);
      await assert.rejects(stack.sql.query(
        `UPDATE "project_codebase" SET "integration_started_at" = NULL WHERE "project_id" = $1::uuid`,
        [f.projectId],
      ), LOCKED_BY_THE_DATABASE);
      const unlocked = await stack.sql.query(
        `UPDATE "project_codebase" SET "merge_check_timeout_seconds" = 600 WHERE "project_id" = $1::uuid`,
        [f.projectId],
      );
      assert.equal(unlocked.rowCount, 1, 'the trigger refuses moving the line, not every write');
    });

  await t.test('a receipt into the project branch makes its serving task landed', async () => {
    const f = await project(stack, 'landing');
    await stack.sql.query(
      `INSERT INTO "project_codebase" ("id", "project_id", "owner_id", "canonical_repo_url",
                                       "upstream_ref", "integration_ref", "ref_authority", "updated_at")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'refs/heads/main', $5, 'REMOTE', now())`,
      [randomUUID(), f.projectId, f.ownerId, CANONICAL_REPO_URL, `refs/heads/project/${f.publicId}`],
    );

    await landEach(stack, f, {
      'on the project branch': `project/${f.publicId}`,
      'on main': 'main',
      'on master': 'master',
    });

    assert.deepEqual(await landings(door, f), {
      // Landed on this project's integration line, and not yet on its upstream.
      'on the project branch': 'ON_INTEGRATION_LINE',
      'on main': 'LANDED',
      // This project's upstream is main. `master` is some other branch, not a fallback.
      'on master': 'UNKNOWN',
    });
  });

  await t.test('platform-initiated merges leave workspace.defaultMergeTarget unchanged', async () => {
    const f = await project(stack, 'merge-target');
    const work = await codeTask(stack, f, 'merge-target: the work');
    const merged = await workSession(stack, f, work, `merge-target-${f.publicId}`);
    const runner = await stack.db.runner.findUniqueOrThrow({ where: { id: f.runnerId } });

    // The runner's door: how a coordinator's `session_merge` reaches the server.
    const runnerDoor = new RunnerSessionsController(
      stack.sessions,
      { assert: async () => undefined } as unknown as RunnerOrchestrationAuthorizer,
      stack.receipts,
      {} as SessionAttemptService,
    );
    assert.deepEqual(await runnerDoor.mergeSession(runner, undefined, undefined, undefined, merged,
      { targetBranch: `project/${f.publicId}` }), { ok: true });
    assert.deepEqual(await stack.db.session.findUniqueOrThrow({
      where: { id: merged },
      select: { mergeStatus: true, mergeTarget: true },
    }), { mergeStatus: 'pending', mergeTarget: `project/${f.publicId}` },
    'the merge itself is queued into the target it named');
    assert.equal(await defaultMergeTargetOf(stack, f), 'main',
      'a merge nobody picked in the Merge menu moved the default that every session of this '
        + 'shared workspace merges into');

    // The owner's own Merge menu is the door that remembers a pick, and it still does — so the
    // assertion above is about who merged, not about a column nothing can move.
    const picked = await workSession(stack, f, null, `merge-target-owner-${f.publicId}`);
    const ownerDoor = new SessionsController(
      stack.sessions, stack.prisma, stack.realtime, {} as SessionTagsService, stack.receipts,
    );
    await ownerDoor.mergeToMain({ userId: f.ownerId, email: 'owner@integration-ref.invalid' } as AuthUser,
      picked, { targetBranch: 'develop' });
    assert.equal(await defaultMergeTargetOf(stack, f), 'develop');
  });

  await t.test('an agent session’s integration settings are refused INTEGRATION_SETTINGS_OWNER_ONLY',
    async () => {
      const f = await project(stack, 'owner-only');
      const runner = await stack.db.runner.findUniqueOrThrow({ where: { id: f.runnerId } });
      const agentDoor = new RunnerProjectsController(
        stack.projects,
        {} as ProjectAcceptanceService,
        {} as ProjectHandoffService,
        {} as RunnerOrchestrationAuthorizer,
      );

      await assert.rejects(
        agentDoor.updateProject(runner, f.projectId, f.coordinatorSessionId,
          { integration: { line: 'MAIN' } } as never),
        (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
          assert.equal(error.getStatus?.(), 403, String(error));
          assert.equal((error.getResponse?.() as { code?: string }).code,
            'INTEGRATION_SETTINGS_OWNER_ONLY');
          return true;
        },
      );
      assert.deepEqual(lineOf(await integrationOf(door, f)), NOT_DECIDED,
        'a refused write left nothing behind');

      // The same door with no acting session is the owner at their own terminal, and it lands.
      await agentDoor.updateProject(runner, f.projectId, undefined,
        { integration: { line: 'MAIN' } } as never);
      assert.deepEqual(lineOf(await integrationOf(door, f)),
        { line: 'MAIN', ref: 'main', upstreamRef: 'main', source: 'EXPLICIT', locked: false });
    });

  await t.test('a project with no codebase row still reads landing from main or master', async () => {
    const f = await project(stack, 'legacy');

    await landEach(stack, f, {
      'into main': 'main',
      'into master': 'master',
      'into another branch': 'orbit/elsewhere',
    });

    assert.deepEqual(await landings(door, f), {
      'into main': 'LANDED',
      'into master': 'LANDED',
      'into another branch': 'UNKNOWN',
    });
    assert.deepEqual(await codebaseRow(stack, f), [], 'reading landing bound nothing');
  });
});
