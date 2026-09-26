/**
 * A project shared by a public link — share-links/public-project.ts over real HTTP (the real
 * SharedController, ShareLinksController, ProjectsController and TasksController behind main.ts's
 * pipe, interceptors and filters, the JWT guard fed by a stubbed verifier) against a real, fully
 * migrated PostgreSQL. docs/share-links-design.md §1, §5, §6 and §7 are the contract. What it is
 * held to:
 *
 *   (1) the project page is exactly the projection's fields — the set of field paths deepEquals the
 *       expected one — with the default layers and with every layer on; and its seven blocks carry
 *       the app's own answers: the owner's panorama buckets, the owner's graph marks, the owner's
 *       task page rows, the owner's criteria lanes (landing said as on main / not on main yet / no
 *       merge receipt either way, and the tasks holding an unmet one by id, title and status);
 *   (2) the red line, as public-task.pg.spec holds it: a runner name, a local path, the runs' branch,
 *       the project's integration branch and its merge check, a SHA, a provider, a model, the
 *       owner's address and id, the project's instructions and a blocker's words, the coordinator's
 *       workspace, the dispatch ledger, a comment's delivery record and the titles of tasks in
 *       another project are planted in the owner's data. Each is first shown in the owner's own
 *       reads, then shown absent — as a value, and as a field name — from every answer the link
 *       gives; the coordinator's conversation too, while Conversations is off;
 *   (3) scope traversal: the project's own task opens under /tasks/:id; another project's task, a
 *       task with Task pages off, and — with Task pages off — Comments & files and Conversations
 *       all answer the one 404 a dead link gives;
 *   (4) with Conversations on, the project's tasks' runs and its coordinator open under
 *       /sessions/:id (the page, a page of events, one event); a run in the Trash, a run of another
 *       project's task, a session that is nobody's run, and the coordinator with Conversations off
 *       answer the one 404; none of it counts a view;
 *   (5) attachments follow the same scope: its tasks' input files with Comments & files, the
 *       conversations' images with Conversations, nothing of another project's;
 *   (6) `scope` lists what the link opens, layer by layer, and the owner's dialog read counts what
 *       each layer holds.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/share-links/public-project.pg.spec.ts
 *
 * Not destructive: every row belongs to an owner this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  RunStatus,
  SessionDispatchOrigin,
  TaskCommentMentionDeliveryStatus,
  TaskCompletionCriterion,
  TaskStatus,
} from '@prisma/client';
import { RunEventType, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { AttachmentsService } from '../attachments/attachments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criteriaFromDefinitions } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import { ProjectFuseService } from '../projects/project-fuse.service';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectsController } from '../projects/projects.controller';
import { ProjectsService } from '../projects/projects.service';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { TaskCheckpointService } from '../projects/task-checkpoint.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { SharedController } from '../shared/shared.controller';
import { TasksController } from '../tasks/tasks.controller';
import { TasksService } from '../tasks/tasks.service';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

// What main.ts installs before the app serves anything: the owner's reads carry BIGINT columns.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString();
};

type Json = Record<string, any>;
type Answer = { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string; json: Json };

/** One request on a connection of its own (agent: false), so no answer rides a pooled socket. */
function send(base: string, method: string, path: string, options: { as?: 'owner'; body?: unknown } = {}): Promise<Answer> {
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  const headers: Record<string, string> = {};
  if (options.as) headers.authorization = `Bearer ${options.as}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json: Json = {};
        try { json = JSON.parse(text) as Json; } catch { /* an empty or file body */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Every field path an answer carries — `root.graph.marks[].title` — so two answers compare as field sets. */
function fieldPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => fieldPaths(item, `${prefix}[]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Json).flatMap(([key, child]) => {
    const at = prefix ? `${prefix}.${key}` : key;
    return [at, ...fieldPaths(child, at)];
  });
}
const fieldSet = (json: unknown): string[] => [...new Set(fieldPaths(json))].sort();
const under = (prefix: string, fields: string[]): string[] => [prefix, ...fields.map((field) => `${prefix}.${field}`)];

/** Every key anywhere in an answer. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Json)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

/**
 * Contract §6 as field names — public-task.pg.spec's list, and what a project adds to it: its
 * instructions, blockers, open items and crossings, its coordination settings, its integration
 * line and the merge receipts it reads, and the owner's own actions.
 */
const RED_LINE_FIELDS = [
  'owner', 'ownerId', 'ownerPublicId', 'userId', 'email', 'creatorId', 'creatorType', 'creatorSession',
  'creatorSessionId', 'assignee', 'assigneeId', 'authorId', 'authorType', 'authorName',
  'runner', 'runnerId', 'assignedRunnerId', 'targetRunnerId', 'workspaceId', 'workDir', 'repoUrl', 'env',
  'branch', 'baseSha', 'knownGoodSha', 'pinnedRevision', 'mergeCheckCommand', 'integration',
  'provider', 'providerBuiltin', 'model', 'costUsd', 'sumInputTokens', 'sumOutputTokens', 'contextTokens',
  'poolMemberProviderId',
  'dispatchAuthority', 'dispatchAttempt', 'dispatchHold', 'dispatchRefusal', 'autoRunWhenReady',
  'autoRunSkipped', 'priority', 'runAt', 'requiredCapabilities', 'idempotencyKey', 'progressState',
  'convergenceCounters', 'lastProgressAt', 'attemptGeneration', 'scopeRevision', 'completionFenceRevision',
  'completionCriterionOverrideReason', 'criterionDefinitionId', 'criterionRevision', 'verdict',
  'verifiesTaskId', 'verifier', 'verificationState', 'instructions', 'listId',
  'deliveries', 'mentions', 'mentionDeliveryVersion', 'lastError', 'requiredAction',
  'dependsOn', 'dependedOnBy', 'sessions', 'successorChain', 'supersedes',
  // A project's own.
  'blockers', 'openItems', 'crossings', 'handoffs', 'coordinatorWorkspaceId', 'coordinatorSessionId',
  'coordinatorEnabled', 'coordinatorAgentId', 'coordinatorGeneration', 'maxConcurrentTasks',
  'sessionBudgetPerDay', 'configRevision', 'convergenceThresholds', 'attemptBudget', 'derivedDone',
  'unmet', 'clause', 'handler', 'openItemId', 'jobId', 'checksRunningForMs', 'ref', 'upstreamRef',
  'integrationRef', 'canonicalRepoUrl', 'mergeReceipts', 'targetBranch', 'sourceSha', 'receipts',
  'acceptanceCriteriaItems', 'tasksByStatus', '_count',
];

test('a shared project: its seven blocks, the red line, and the scope a token reaches', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const server: PrismaClient = prismaClientFor(url);
  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await server.$disconnect().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const prisma = server as unknown as PrismaService;
  const pub = uuidToBase62;

  // ── what must never reach a visitor, planted where the owner reads it ─────────────────────
  const SECRET = {
    runner: `secret-runner-${RUN}`,
    path: `/root/.orbit/worktrees/secret-path-${RUN}`,
    branch: `orbit/secret-branch-${RUN}`,
    line: `project/secret-line-${RUN}`,
    mergeCheck: `npm run secret-merge-check-${RUN}`,
    sha: `${RUN}${'a'.repeat(32)}`,
    provider: `secret-provider-${RUN}`,
    model: `secret-model-${RUN}`,
    // The owner's address, as their name too: it is how a person's comment is signed to its owner.
    email: `owner.${RUN}@secret-mail.invalid`,
    idempotency: `secret-idempotency-${RUN}`,
    delivery: `secret-delivery-error-${RUN}`,
    instructions: `SECRET instructions for the agents ${RUN}`,
    blocker: `SECRET the blocker asks for ${RUN}`,
    crossPrerequisite: `SECRET prerequisite in another project ${RUN}`,
    crossDependent: `SECRET dependent in another project ${RUN}`,
  };
  /** In the row, and in no read of the owner's either: the canonical repository address. */
  const REPO = `ssh://git@secret-host.invalid/secret-repo-${RUN}`;
  /** Shared only with Conversations: the coordinator's conversation. */
  const COORDINATOR_TITLE = `Coordinator conversation ${RUN}`;
  /** The coordinator card's Workspace, which the project page never draws. A conversation's own page
   *  names the workspace it ran in (as a session link's always has), so the coordinator's does. */
  const COORDINATOR_WORKSPACE = `secret-coordinator-workspace-${RUN}`;

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: SECRET.email, name: SECRET.email, passwordHash: 'x' } });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: SECRET.runner, tokenHash: `public-project-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  const WORKSPACE = `orbit ${RUN}`;
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: WORKSPACE, enabled: true, model: SECRET.model, workDir: SECRET.path },
  });
  const coordinatorWorkspaceId = randomUUID();
  await db.workspace.create({
    data: {
      id: coordinatorWorkspaceId, ownerId, runnerId, name: COORDINATOR_WORKSPACE, enabled: true,
      model: SECRET.model, workDir: SECRET.path,
    },
  });

  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const PROJECT_TITLE = `Claude pool ${RUN}`;
  const GOAL = `Dispatch by subscription quota ${RUN}.\n\nOne account running out must not stop the work.`;
  await db.project.create({
    data: { id: projectId, ownerId, title: PROJECT_TITLE, goal: GOAL, instructions: SECRET.instructions },
  });
  await db.project.create({ data: { id: otherProjectId, ownerId, title: `Another project ${RUN}` } });
  // The project's line: a branch of its own, decided, with a merge check the owner configured.
  await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: REPO, upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${SECRET.line}`, integrationRefSource: 'EXPLICIT', refAuthority: 'REMOTE',
      mergeCheckCommand: SECRET.mergeCheck, integrationStartedAt: new Date('2026-09-20T09:00:00Z'),
    },
  });
  // A blocker: the owner's to answer, in words nobody else is shown.
  const raisedAt = new Date('2026-09-25T06:00:00Z');
  await db.projectBlocker.create({
    data: {
      projectId, kind: 'AWAITING_USER_APPROVAL', owner: 'USER', recovery: 'HUMAN', severity: 'CRITICAL',
      requiredAction: SECRET.blocker, nextCheckAt: raisedAt, subjectType: 'PROJECT', subjectId: projectId,
      detail: { reason: SECRET.blocker }, dedupeKey: `public-project-${RUN}`, lifecycleGeneration: 1n,
      conditionVersion: 'c'.repeat(64), firstSeenAt: raisedAt, lastSeenAt: raisedAt,
    },
  });

  const owners = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  // Four criteria, whose work will stand in each of the ways a criterion can: met and on main, met
  // and only on the project's branch, not met with a task holding it, and not served at all.
  const MET_ON_MAIN = `Met, and on main ${RUN}`;
  const MET_ON_LINE = `Met, and only on the project branch ${RUN}`;
  const HELD_UP = `Not met, one task holds it ${RUN}`;
  const NOBODY = `Not met, nothing filed under it ${RUN}`;
  const METHOD = `Read the pg spec and see it pass ${RUN}`;
  const [onMainAt, onLineAt, heldUpAt] = criteriaFromDefinitions(
    (await owners.update(ownerId, projectId, {
      acceptanceCriteriaItems: [MET_ON_MAIN, MET_ON_LINE, HELD_UP, NOBODY].map((text) => ({ text, verificationMethod: METHOD })),
    } as never)).acceptanceCriteriaItems,
  );

  async function task(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, ownerId, title, projectId, creatorType: CreatorType.USER, creatorId: ownerId,
        completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT, ...extra,
      } as never,
    });
    return id;
  }
  async function session(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, title, prompt: title,
        status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, ...extra,
      } as never,
    });
    return id;
  }
  async function event(sessionId: string, seq: number, type: string, payload: unknown) {
    await sql.query(
      `INSERT INTO run_event (id, session_id, seq, type, payload) VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::jsonb)`,
      [sessionId, seq, type, JSON.stringify(payload)],
    );
  }
  const declared = (criterion: { definitionId: string; definitionRevision: number }) => ({
    criterionDefinitionId: criterion.definitionId, criterionRevision: criterion.definitionRevision,
  });
  const EXECUTABLE_DONE = {
    status: TaskStatus.DONE, completionCriterion: TaskCompletionCriterion.EXECUTABLE,
    acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  };
  const RUN_FIELDS = { provider: SECRET.provider, model: SECRET.model, baseSha: SECRET.sha, costUsd: 12.5 };

  // The coordinator: its conversation, where it runs, and the project's pointer to it.
  const coordinator = await session(COORDINATOR_TITLE, { workspaceId: coordinatorWorkspaceId, ...RUN_FIELDS });
  await event(coordinator, 1, RunEventType.USER, { text: 'Plan the project.' });
  await event(coordinator, 2, RunEventType.ASSISTANT, { text: 'Filing the tasks.' });
  await db.project.update({
    where: { id: projectId },
    data: { coordinatorSessionId: coordinator, coordinatorWorkspaceId },
  });

  // Its tasks. Landed on main, landed on the project's branch, running, and waiting on the runner.
  const landed = await task(`T1 identity and migration ${RUN}`, { ...EXECUTABLE_DONE, ...declared(onMainAt) });
  const onLine = await task(`T2 selector ${RUN}`, { ...EXECUTABLE_DONE, ...declared(onLineAt) });
  const running = await task(`T3 claim wiring ${RUN}`, {
    ...declared(heldUpAt), assigneeId: workspaceId, creatorSessionId: coordinator,
    provider: SECRET.provider, model: SECRET.model, knownGoodSha: SECRET.sha,
    pinnedRevision: `refs/heads/${SECRET.branch}`, idempotencyKey: SECRET.idempotency,
  });
  const waiting = await task(`T4 brake ${RUN}`);
  const crossPrerequisite = await task(SECRET.crossPrerequisite, { projectId: otherProjectId, status: TaskStatus.DONE });
  const crossDependent = await task(SECRET.crossDependent, { projectId: otherProjectId });
  for (const [from, to] of [[waiting, running], [waiting, crossPrerequisite], [crossDependent, waiting]]) {
    await db.taskDependency.create({ data: { taskId: from, dependsOnTaskId: to } });
  }

  // Their runs, each on a branch of its own; the first two leave the receipts their criteria read.
  const landedRun = await session(`Run of T1 ${RUN}`, {
    taskId: landed, ...RUN_FIELDS, branch: SECRET.branch, isolationStatus: 'worktree', status: RunStatus.SUCCEEDED,
    createdAt: new Date('2026-09-20T10:00:00Z'), startedAt: new Date('2026-09-20T10:00:05Z'),
    finishedAt: new Date('2026-09-20T11:00:05Z'),
  });
  const onLineRun = await session(`Run of T2 ${RUN}`, {
    taskId: onLine, ...RUN_FIELDS, branch: `${SECRET.branch}-2`, isolationStatus: 'worktree', status: RunStatus.SUCCEEDED,
  });
  const runningRun = await session(`Run of T3 ${RUN}`, {
    taskId: running, ...RUN_FIELDS, branch: `${SECRET.branch}-3`, isolationStatus: 'worktree',
    status: RunStatus.RUNNING, assignedRunnerId: runnerId, startedAt: new Date(),
  });
  const trashedRun = await session(`Trashed run of T1 ${RUN}`, {
    taskId: landed, ...RUN_FIELDS, status: RunStatus.FAILED, deletedAt: new Date(),
  });
  const receipts = new MergeReceiptService(prisma);
  await receipts.record(ownerId, landedRun, {
    result: 'ALREADY_MERGED', sourceSha: SECRET.sha, targetBranch: 'main',
  } as never, 'AGENT');
  await receipts.record(ownerId, onLineRun, {
    result: 'ALREADY_MERGED', sourceSha: `${RUN}${'b'.repeat(32)}`, targetBranch: SECRET.line,
  } as never, 'AGENT');
  for (const [seq, type, payload] of [
    [1, RunEventType.USER, { text: 'Claim the account.' }],
    [2, RunEventType.ASSISTANT, { text: 'Wiring the claim.' }],
    [3, RunEventType.TOOL_USE, { id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
    [4, RunEventType.TOOL_RESULT, { toolUseId: 'toolu_1', content: 'ok', isError: false }],
  ] as const) {
    await event(runningRun, seq, type, payload);
  }
  await event(trashedRun, 1, RunEventType.USER, { text: 'In the Trash.' });

  // Comments on T1: an agent's, whose mention has a delivery record, and the owner's.
  const AGENT_COMMENT = `Delivered: the migration ${RUN}. @${WORKSPACE}`;
  const OWNER_COMMENT = `Looks right ${RUN}`;
  const agentComment = await db.taskComment.create({
    data: {
      taskId: landed, authorType: CreatorType.AGENT, authorId: workspaceId, body: AGENT_COMMENT,
      mentions: [workspaceId], mentionDeliveryVersion: 1, createdAt: new Date('2026-09-25T03:17:00Z'),
    },
    select: { id: true },
  });
  const failedDelivery = {
    status: TaskCommentMentionDeliveryStatus.DEAD, attempts: 8, lastError: SECRET.delivery,
    requiredAction: 'look at the runner', targetSessionId: coordinator,
  };
  await db.taskCommentMentionDelivery.upsert({
    where: { commentId_workspaceId: { commentId: agentComment.id, workspaceId } },
    create: { commentId: agentComment.id, taskId: landed, workspaceId, ownerId, ...failedDelivery },
    update: failedDelivery,
  });
  await db.taskComment.create({
    data: { taskId: landed, authorType: CreatorType.USER, authorId: ownerId, body: OWNER_COMMENT, createdAt: new Date('2026-09-25T04:00:00Z') },
  });
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const attach = async (data: Record<string, unknown>) => (await db.attachment.create({
    data: { ownerId, mimeType: 'image/png', sizeBytes: png.length, data: Uint8Array.from(png), ...data } as never,
    select: { id: true },
  })).id;
  const input = await attach({ taskId: landed, fileName: 'design-mock.png' });
  const runImage = await attach({ sessionId: runningRun, fileName: 'shot.png' });
  const coordinatorImage = await attach({ sessionId: coordinator, fileName: 'plan.png' });
  const trashedImage = await attach({ sessionId: trashedRun, fileName: 'trashed.png' });

  // Outside the project: another project's task, its run and its files, and a session nobody runs.
  const otherTask = crossPrerequisite;
  const otherRun = await session(`Run in another project ${RUN}`, { taskId: otherTask, status: RunStatus.SUCCEEDED });
  await event(otherRun, 1, RunEventType.USER, { text: 'Elsewhere.' });
  const otherInput = await attach({ taskId: otherTask, fileName: 'elsewhere.png' });
  const otherRunImage = await attach({ sessionId: otherRun, fileName: 'elsewhere-run.png' });
  const loose = await session(`A conversation of nobody's task ${RUN}`);
  await event(loose, 1, RunEventType.USER, { text: 'Loose.' });

  // ── the app: the real controllers, main.ts's middleware, pipe, interceptors and filters ──────
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, {} as never, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  @Module({
    controllers: [SharedController, ShareLinksController, TasksController, ProjectsController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: TasksService, useValue: tasks },
      { provide: ProjectsService, useValue: owners },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
      { provide: ProjectOpenItemService, useValue: {} },
      { provide: ProjectFuseService, useValue: {} },
      { provide: AttachmentsService, useValue: new AttachmentsService(prisma) },
      { provide: ShareLinksService, useValue: new ShareLinksService(prisma) },
      { provide: ProjectAttributionService, useValue: {} },
      // A budget no case here comes near: the budget is public-surface.pg.spec's subject.
      { provide: SharedRateLimiter, useValue: new SharedRateLimiter({ max: 100_000, windowMs: 60_000 }) },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: ownerId }) } },
    ],
  })
  class PublicProjectHarness {}

  app = await NestFactory.create(PublicProjectHarness, { logger: ['error'], abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const owner = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'owner', body });
  const shareAt = `/projects/${pub(projectId)}/share`;
  const link = await owner('PUT', shareAt, {});
  assert.equal(link.status, 200, link.text);
  const token = link.json.token as string;
  const visit = (rest = '') => send(base, 'GET', `/api/shared/${encodeURIComponent(token)}${rest}`);
  const layers = async (include: Json) => {
    const changed = await owner('PUT', shareAt, { include });
    assert.equal(changed.status, 200, changed.text);
  };
  const ALL_ON = { taskPages: true, commentsAndFiles: true, conversations: true };
  const DEFAULTS = { taskPages: true, commentsAndFiles: false, conversations: false };
  const views = async () =>
    Number((await sql.query('SELECT view_count FROM share_link WHERE token = $1', [token])).rows[0].view_count);
  // The answer a dead token gets; every refused route must give exactly this.
  const dead = await send(base, 'GET', `/api/shared/${'x'.repeat(32)}`);
  assert.equal(dead.status, 404);
  const isDead = (answer: Answer, what: string) => {
    assert.equal(answer.status, 404, `${what}: ${answer.text.slice(0, 200)}`);
    assert.deepEqual(answer.body, dead.body, `${what}: a refused route must answer as a dead link does`);
  };

  // The owner's own reads of the same project — what every block is held against.
  const ownersPanorama = await owner('GET', `/projects/${pub(projectId)}/panorama`);
  assert.equal(ownersPanorama.status, 200, ownersPanorama.text);
  const ownersGraph = await owner('GET', `/projects/${pub(projectId)}/dependency-graph`);
  assert.equal(ownersGraph.status, 200, ownersGraph.text);
  const ownersTasks = await owner('GET', `/projects/${pub(projectId)}/tasks/page?limit=100`);
  assert.equal(ownersTasks.status, 200, ownersTasks.text);
  const ownersProject = await owner('GET', `/projects/${pub(projectId)}`);
  assert.equal(ownersProject.status, 200, ownersProject.text);

  const TASK_REF = ['id', 'publicId', 'title', 'status'];
  const MARK = ['kind', 'id', 'publicId', 'taskId', 'taskPublicId', 'title', 'status', 'parentTaskId',
    'parentTaskPublicId', 'running', 'queued', 'workState'];
  const ROW = ['id', 'publicId', 'title', 'status', 'workState', 'landing', 'dependencyState', 'landingWaitCount',
    'topoLevel', 'unmetCount', 'blocksCount', 'childCount'];
  const PAGE_FIELDS = (include: Json) => [
    ...under('include', ['taskPages', 'commentsAndFiles', 'conversations', 'toolOutput']),
    'kind', 'sharedAt',
    ...under('root', ['id', 'publicId', 'title', 'status', 'createdAt', 'lastActivityAt', 'taskCount', 'goal']),
    ...under('root.overview', ['integrationLine']),
    ...under('root.overview.buckets', Object.keys(ownersPanorama.json.buckets)),
    ...under('root.overview.shape', ['taskCount', 'edgeCount', 'ratio', 'maxDepth', 'form']),
    ...under('root.graph', ['marks', 'edges', 'taskCount', 'folded', 'truncated', 'limits']),
    ...under('root.graph.limits', ['maxTasks', 'maxMarks']),
    ...MARK.map((field) => `root.graph.marks[].${field}`),
    ...['sourceMarkId', 'sourceMarkPublicId', 'targetMarkId', 'targetMarkPublicId'].map((f) => `root.graph.edges[].${f}`),
    ...under('root.chain', ['current', 'next']),
    ...TASK_REF.map((field) => `root.chain.current.${field}`),
    ...under('root.criteria', []),
    ...['ordinal', 'text', 'verificationMethod', 'satisfied', 'landing', 'heldUpBy'].map((f) => `root.criteria[].${f}`),
    ...TASK_REF.map((field) => `root.criteria[].heldUpBy[].${field}`),
    ...under('root.tasks', ['items', 'hasMore']),
    ...ROW.map((field) => `root.tasks.items[].${field}`),
    ...(include.conversations ? under('root.coordinator', ['sessionId', 'sessionPublicId']) : []),
    ...under('scope', ['projectId', 'projectPublicId', 'tasks', 'conversations']),
    ...(include.taskPages ? ['id', 'publicId'].map((f) => `scope.tasks[].${f}`) : []),
    ...(include.conversations ? ['id', 'publicId'].map((f) => `scope.conversations[].${f}`) : []),
  ];

  await t.test('(1) the project page is the projection\'s fields, and every block the app\'s own answer', async () => {
    const page = await visit();
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.kind, 'PROJECT');
    assert.deepEqual(page.json.include, { ...DEFAULTS, toolOutput: true });
    assert.deepEqual(fieldSet(page.json), [...new Set(PAGE_FIELDS(DEFAULTS))].sort());

    const root = page.json.root;
    // Header: the title, the status, how many tasks, when it started and last moved.
    assert.equal(root.id, pub(projectId));
    assert.equal(root.title, PROJECT_TITLE);
    assert.equal(root.status, 'OPEN');
    assert.equal(root.taskCount, 4);
    assert.equal(root.goal, GOAL);
    const lastWrite = await db.task.aggregate({ where: { projectId }, _max: { updatedAt: true } });
    assert.equal(root.lastActivityAt, lastWrite._max.updatedAt!.toISOString());

    // Work overview: the owner's panorama, lane for lane; the line, but no branch.
    assert.deepEqual(root.overview.buckets, ownersPanorama.json.buckets);
    assert.deepEqual(root.overview.shape, ownersPanorama.json.shape);
    assert.equal(root.overview.integrationLine, 'PROJECT_BRANCH');

    // Task graph: the owner's marks and edges, each mark only as its task and the state it is drawn in.
    assert.deepEqual(
      root.graph.marks,
      ownersGraph.json.marks.map((mark: Json) => ({
        kind: mark.kind, id: mark.id, publicId: mark.publicId, taskId: mark.taskId, taskPublicId: mark.taskPublicId,
        title: mark.title, status: mark.status, parentTaskId: mark.parentTaskId, parentTaskPublicId: mark.parentTaskPublicId,
        running: mark.running, queued: mark.queued, workState: mark.workState,
      })),
    );
    assert.deepEqual(root.graph.edges, ownersGraph.json.edges);
    assert.deepEqual(
      { taskCount: root.graph.taskCount, folded: root.graph.folded, truncated: root.graph.truncated, limits: root.graph.limits },
      { taskCount: 4, folded: ownersGraph.json.folded, truncated: ownersGraph.json.truncated, limits: ownersGraph.json.limits },
    );
    assert.deepEqual(root.graph.marks.find((mark: Json) => mark.id === pub(running)).running, true);

    // Chain progress: a chain-shaped project names the step it is on — the task holding the most.
    assert.equal(ownersPanorama.json.shape.form, 'chain');
    assert.deepEqual(root.chain, {
      current: { id: pub(running), publicId: pub(running), title: `T3 claim wiring ${RUN}`, status: 'OPEN' },
      next: null,
    });

    // Acceptance criteria: in their words and order, how each is checked, and the owner's lanes —
    // landing in the three phrases a visitor gets, and the task holding the unmet one.
    const lanes: Record<string, string> = { LANDED: 'ON_MAIN', ON_INTEGRATION_LINE: 'NOT_ON_MAIN_YET', UNKNOWN: 'NO_MERGE_RECEIPT' };
    assert.deepEqual(
      root.criteria,
      ownersProject.json.acceptanceCriteriaItems.map((item: Json) => ({
        ordinal: item.ordinal,
        text: item.text,
        verificationMethod: item.verificationMethod,
        satisfied: item.satisfied,
        landing: lanes[item.landing],
        heldUpBy: item.unmet.flatMap((reason: Json) => reason.heldUpBy.map((held: Json) => ({
          id: held.taskId, publicId: held.taskPublicId, title: held.title, status: held.status,
        }))),
      })),
    );
    // …and the fixture stands each criterion where it was meant to, so every phrase is exercised.
    assert.deepEqual(
      root.criteria.map((c: Json) => [c.text, c.satisfied, c.landing, c.heldUpBy.map((h: Json) => h.id)]),
      [
        [MET_ON_MAIN, true, 'ON_MAIN', []],
        [MET_ON_LINE, true, 'NOT_ON_MAIN_YET', []],
        [HELD_UP, false, 'NO_MERGE_RECEIPT', [pub(running)]],
        [NOBODY, false, 'NO_MERGE_RECEIPT', []],
      ],
    );
    assert.ok(root.criteria.every((c: Json) => c.verificationMethod === METHOD));

    // Tasks: the owner's first page of top-level tasks, as the app bands them, row for row.
    const coarse: Record<string, string | null> = {
      ON_UPSTREAM: 'ON_MAIN', ON_INTEGRATION_LINE: 'ON_PROJECT_BRANCH', QUEUED: 'INTEGRATING', RUNNING: 'INTEGRATING',
      CONFLICT: 'INTEGRATING', CHECK_FAILED: 'INTEGRATING', ERROR: 'INTEGRATING', AWAITING_OWNER: 'INTEGRATING',
      NOT_APPLICABLE: null,
    };
    assert.deepEqual(
      root.tasks.items,
      ownersTasks.json.items.map((row: Json) => ({
        id: row.id, publicId: row.publicId, title: row.title, status: row.status, workState: row.workState,
        landing: coarse[row.integration.state], dependencyState: row.dependencyState,
        landingWaitCount: row.landingWaitCount, topoLevel: row.topoLevel, unmetCount: row.unmetCount,
        blocksCount: row.blocksCount, childCount: row.childCount,
      })),
    );
    assert.equal(root.tasks.hasMore, false);
    const byTitle = new Map(root.tasks.items.map((row: Json) => [row.id, row]));
    assert.equal((byTitle.get(pub(landed)) as Json).landing, 'ON_MAIN');
    assert.equal((byTitle.get(pub(onLine)) as Json).landing, 'ON_PROJECT_BRANCH');
    // "waits 1": the prerequisite still owing work; the one done in another project is not named.
    assert.equal((byTitle.get(pub(waiting)) as Json).unmetCount, 1);

    // Every layer on: the coordinator's conversation joins the page, and the scope names its runs.
    await layers(ALL_ON);
    const on = await visit();
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(on.json.include, { ...ALL_ON, toolOutput: true });
    assert.deepEqual(fieldSet(on.json), [...new Set(PAGE_FIELDS(ALL_ON))].sort());
    assert.deepEqual(on.json.root.coordinator, { sessionId: pub(coordinator), sessionPublicId: pub(coordinator) });
    await layers(DEFAULTS);
  });

  await t.test('(2) the red line: planted in the owner\'s project, shown there first, absent from every public answer', async () => {
    // Ids the owner's reads carry and a visitor's must not: the owner, the workspaces, the runner,
    // the tasks in another project, the run in the Trash, the sessions nobody shares.
    const ids = {
      owner: ownerId, workspace: workspaceId, coordinatorWorkspace: coordinatorWorkspaceId, runner: runnerId,
      crossPrerequisite, crossDependent, trashed: trashedRun, otherRun, loose,
    };
    const neverShown = [...Object.values(SECRET), REPO, ...Object.values(ids).map(pub), ...Object.values(ids)];
    // Shared only with Conversations: the coordinator, by title and by id.
    const conversationsOnly = [COORDINATOR_TITLE, pub(coordinator), coordinator];

    // The positive control: every planted value is really in the owner's own reads — the project
    // document, its task page, the graph, and a task's detail — base62 there, as every id is.
    const ownersTask = await owner('GET', `/tasks/${pub(running)}`);
    assert.equal(ownersTask.status, 200, ownersTask.text);
    const ownersLanded = await owner('GET', `/tasks/${pub(landed)}`);
    assert.equal(ownersLanded.status, 200, ownersLanded.text);
    const ownersWaiting = await owner('GET', `/tasks/${pub(waiting)}`);
    assert.equal(ownersWaiting.status, 200, ownersWaiting.text);
    const ownersText = [ownersProject, ownersTasks, ownersGraph, ownersTask, ownersLanded, ownersWaiting]
      .map((answer) => answer.text).join('\n');
    const inOwners = [
      ...Object.values(SECRET).filter((value) => value !== SECRET.runner && value !== SECRET.path),
      pub(ownerId), pub(workspaceId), pub(coordinatorWorkspaceId), pub(crossPrerequisite), pub(crossDependent),
      pub(trashedRun), pub(coordinator), COORDINATOR_TITLE,
    ];
    assert.deepEqual(inOwners.filter((value) => !ownersText.includes(value)), [], 'the fixture did not plant what (2) looks for');
    // The three machine-side values live under the workspace and the runner, and are in their rows.
    const machine = (await sql.query(
      'SELECT w.name, w.work_dir, r.name AS runner FROM workspace w JOIN runner r ON r.id = w.runner_id WHERE w.id = $1',
      [coordinatorWorkspaceId],
    )).rows[0];
    assert.deepEqual(machine, { name: COORDINATOR_WORKSPACE, work_dir: SECRET.path, runner: SECRET.runner });
    const ownerKeys = keysOf(ownersProject.json);
    assert.deepEqual(
      ['ownerId', 'instructions', 'blockers', 'integration', 'mergeCheckCommand', 'coordinatorWorkspaceId',
        'coordinatorSessionId', 'derivedDone', 'unmet', 'requiredAction'].filter((name) => !ownerKeys.has(name)),
      [],
      'the owner\'s read lost a field (2) proves absent from the public one',
    );

    // Every answer the link gives: with the default layers, and with every layer on — the most it
    // can show — its root, a task page, the conversations and their events.
    const defaults: [string, Answer][] = [
      ['project page, default layers', await visit()],
      ['task page, default layers', await visit(`/tasks/${pub(landed)}`)],
      ['task page of the running task, default layers', await visit(`/tasks/${pub(running)}`)],
    ];
    await layers(ALL_ON);
    const allOn: [string, Answer][] = [
      ['project page, all layers', await visit()],
      ['task page, all layers', await visit(`/tasks/${pub(landed)}`)],
      ['task page of the running task, all layers', await visit(`/tasks/${pub(running)}`)],
      ['task page of the waiting task, all layers', await visit(`/tasks/${pub(waiting)}`)],
      ['run', await visit(`/sessions/${pub(runningRun)}`)],
      ['run, events', await visit(`/sessions/${pub(runningRun)}/events?limit=2`)],
      ['run, one event', await visit(`/sessions/${pub(runningRun)}/events/3`)],
      ['coordinator', await visit(`/sessions/${pub(coordinator)}`)],
      ['coordinator, events', await visit(`/sessions/${pub(coordinator)}/events?limit=1`)],
    ];
    await layers(DEFAULTS);
    for (const [what, answer] of [...defaults, ...allOn]) {
      assert.equal(answer.status, 200, `${what}: ${answer.text.slice(0, 300)}`);
      assert.deepEqual(neverShown.filter((value) => answer.text.includes(value)), [], `${what} carries a red-line value`);
      if (!what.startsWith('coordinator')) {
        assert.equal(answer.text.includes(COORDINATOR_WORKSPACE), false, `${what} names the coordinator's workspace`);
      }
      // A transcript's events are the conversation itself — command output and file contents are
      // what the Conversations layer warns about — so their payloads are not fields of the page.
      const envelope = answer.json.events ? { ...answer.json, events: [] } : answer.json;
      const keys = keysOf(what.endsWith('one event') ? { ...envelope, payload: null } : envelope);
      assert.deepEqual(RED_LINE_FIELDS.filter((name) => keys.has(name)), [], `${what} carries a red-line field`);
    }
    for (const [what, answer] of defaults) {
      assert.deepEqual(conversationsOnly.filter((value) => answer.text.includes(value)), [], `${what} names the coordinator`);
    }
  });

  await t.test('(3) scope: the project\'s tasks open with Task pages; nothing else does, and each refusal is the one 404', async () => {
    const before = await views();
    const own = await visit(`/tasks/${pub(landed)}`);
    assert.equal(own.status, 200, own.text);
    // The task link's projection of it, with the link's layers and scope.
    assert.deepEqual(Object.keys(own.json).sort(), ['include', 'root', 'scope']);
    assert.equal(own.json.root.id, pub(landed));
    assert.equal(own.json.root.title, `T1 identity and migration ${RUN}`);
    assert.deepEqual(own.json.root.project, { title: PROJECT_TITLE });
    assert.equal('comments' in own.json.root, false, 'Comments & files is off');
    assert.ok(own.json.root.runs.every((run: Json) => !('sessionId' in run)), 'Conversations is off');
    // Its dependencies inside the project are named; in another project, only counted.
    const waitingPage = await visit(`/tasks/${pub(waiting)}`);
    assert.equal(waitingPage.status, 200, waitingPage.text);
    assert.deepEqual(waitingPage.json.root.dependencies, {
      prerequisites: [{ id: pub(running), publicId: pub(running), title: `T3 claim wiring ${RUN}`, status: 'OPEN' }],
      dependents: [],
      prerequisitesInOtherProjects: 1,
      dependentsInOtherProjects: 1,
    });

    // Another project's task, by the same owner — and one that does not exist at all.
    isDead(await visit(`/tasks/${pub(otherTask)}`), 'another project\'s task');
    isDead(await visit(`/tasks/${pub(crossDependent)}`), 'a task that depends on this project\'s');
    isDead(await visit(`/tasks/${pub(randomUUID())}`), 'a task that does not exist');

    // Task pages off: no task page opens, and the two layers under it go with it — whatever they say.
    await layers({ taskPages: false, commentsAndFiles: true, conversations: true });
    const off = await visit();
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json.include, { taskPages: false, commentsAndFiles: false, conversations: false, toolOutput: true });
    assert.deepEqual(off.json.scope, {
      projectId: pub(projectId), projectPublicId: pub(projectId), tasks: [], conversations: [],
    });
    assert.equal('coordinator' in off.json.root, false);
    for (const id of [landed, running, waiting]) isDead(await visit(`/tasks/${pub(id)}`), `task pages off: ${id}`);
    isDead(await visit(`/sessions/${pub(runningRun)}`), 'task pages off: a run');
    isDead(await visit(`/sessions/${pub(coordinator)}`), 'task pages off: the coordinator');
    isDead(await visit(`/attachments/${pub(input)}`), 'task pages off: an input file');
    await layers(DEFAULTS);

    // A session link's own transcript routes are not a project link's.
    isDead(await visit('/events'), 'the session-root events page');
    isDead(await visit('/events/1'), 'the session-root event');
    isDead(await visit('/artifacts?path=x.png'), 'the session-root artifact');
    assert.equal(await views(), before + 1, 'only the root page counts a view');
  });

  await t.test('(4) its tasks\' runs and its coordinator open with Conversations; nothing else does', async () => {
    // Off: none of them.
    for (const id of [runningRun, landedRun, coordinator]) {
      isDead(await visit(`/sessions/${pub(id)}`), `conversations off: ${id}`);
      isDead(await visit(`/sessions/${pub(id)}/events`), `conversations off, events: ${id}`);
      isDead(await visit(`/sessions/${pub(id)}/events/1`), `conversations off, one event: ${id}`);
    }
    await layers({ conversations: true });
    const before = await views();

    const run = await visit(`/sessions/${pub(runningRun)}?limit=3`);
    assert.equal(run.status, 200, run.text);
    assert.equal(run.json.title, `Run of T3 ${RUN}`);
    assert.equal(run.json.runState, 'RUNNING');
    assert.deepEqual(run.json.events.map((e: Json) => e.seq), [2, 3, 4]);
    // The project and the task it is a run of — the breadcrumb — and the link's scope.
    assert.deepEqual(run.json.project, { title: PROJECT_TITLE });
    assert.deepEqual(run.json.task, {
      id: pub(running), publicId: pub(running), title: `T3 claim wiring ${RUN}`,
      runs: [{ sessionId: pub(runningRun), sessionPublicId: pub(runningRun) }],
    });
    const older = await visit(`/sessions/${pub(runningRun)}/events?before=2&limit=5`);
    assert.equal(older.status, 200, older.text);
    assert.deepEqual(older.json.events.map((e: Json) => e.seq), [1]);
    const one = await visit(`/sessions/${pub(runningRun)}/events/3`);
    assert.equal(one.status, 200, one.text);
    assert.deepEqual(one.json.payload, { id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } });
    assert.equal((await visit(`/sessions/${pub(landedRun)}`)).status, 200);

    const lead = await visit(`/sessions/${pub(coordinator)}`);
    assert.equal(lead.status, 200, lead.text);
    assert.equal(lead.json.title, COORDINATOR_TITLE);
    assert.deepEqual(lead.json.project, { title: PROJECT_TITLE });
    assert.equal(lead.json.task, null, 'the coordinator is nobody\'s run');
    assert.equal((await visit(`/sessions/${pub(coordinator)}/events/1`)).status, 200);

    // Not this project's, or paused in the Trash: the one 404.
    for (const [id, what] of [
      [trashedRun, 'a run in the Trash'], [otherRun, 'a run of another project\'s task'], [loose, 'nobody\'s run'],
    ] as const) {
      isDead(await visit(`/sessions/${pub(id)}`), what);
      isDead(await visit(`/sessions/${pub(id)}/events`), `${what}, events`);
      isDead(await visit(`/sessions/${pub(id)}/events/1`), `${what}, one event`);
    }
    // A coordinator in the Trash is paused like any conversation, and comes back with it.
    await db.session.update({ where: { id: coordinator }, data: { deletedAt: new Date() } });
    isDead(await visit(`/sessions/${pub(coordinator)}`), 'the coordinator in the Trash');
    assert.equal('coordinator' in (await visit('?preview=1')).json.root, false);
    await db.session.update({ where: { id: coordinator }, data: { deletedAt: null } });
    assert.equal((await visit(`/sessions/${pub(coordinator)}`)).status, 200);
    assert.equal(await views(), before, 'a page below the root counted a view');

    // Tool output off keeps the tools' names and drops what they ran and returned.
    await layers({ toolOutput: false });
    const quiet = await visit(`/sessions/${pub(runningRun)}/events/3`);
    assert.equal(quiet.status, 200, quiet.text);
    assert.deepEqual(quiet.json.payload, { id: 'toolu_1', name: 'Bash' });
    await layers({ ...DEFAULTS, toolOutput: true });
  });

  await t.test('(5) attachments follow the scope: input files with Comments & files, a conversation\'s with Conversations', async () => {
    const routes = {
      input: `/attachments/${pub(input)}`,
      runImage: `/attachments/${pub(runImage)}`,
      coordinatorImage: `/attachments/${pub(coordinatorImage)}`,
    };
    for (const include of [
      { commentsAndFiles: false, conversations: false },
      { commentsAndFiles: true, conversations: false },
      { commentsAndFiles: false, conversations: true },
      { commentsAndFiles: true, conversations: true },
    ]) {
      await layers({ taskPages: true, ...include });
      const label = JSON.stringify(include);
      const expect = { input: include.commentsAndFiles, runImage: include.conversations, coordinatorImage: include.conversations };
      for (const [name, route] of Object.entries(routes)) {
        const answer = await visit(route);
        if (expect[name as keyof typeof expect]) {
          assert.equal(answer.status, 200, `${label} ${name}: ${answer.text}`);
          assert.deepEqual(answer.body, png);
        } else {
          isDead(answer, `${label} ${name}`);
        }
      }
      // Never another project's, a run in the Trash's, or a file that does not exist.
      for (const [id, what] of [[otherInput, 'another project\'s input'], [otherRunImage, 'another project\'s run image'],
        [trashedImage, 'a trashed run\'s image'], [randomUUID(), 'no attachment']] as const) {
        isDead(await visit(`/attachments/${pub(id)}`), `${label} ${what}`);
      }
    }
    await layers(DEFAULTS);
  });

  await t.test('(6) scope lists what the link opens, layer by layer; the dialog\'s read counts each layer', async () => {
    const tasksOf = (answer: Answer) => answer.json.scope.tasks.map((task: Json) => task.id).sort();
    const sessionsOf = (answer: Answer) => answer.json.scope.conversations.map((s: Json) => s.id).sort();
    const projectTasks = [landed, onLine, running, waiting].map(pub).sort();

    const page = await visit('?preview=1');
    assert.deepEqual(tasksOf(page), projectTasks);
    assert.deepEqual(sessionsOf(page), []);

    await layers(ALL_ON);
    const on = await visit('?preview=1');
    assert.deepEqual(tasksOf(on), projectTasks);
    // Its tasks' runs outside the Trash, and its coordinator: every conversation the link opens.
    assert.deepEqual(sessionsOf(on), [coordinator, landedRun, onLineRun, runningRun].map(pub).sort());
    // The nested pages carry the same scope, so their links resolve without the root page.
    assert.deepEqual(tasksOf(await visit(`/tasks/${pub(landed)}`)), projectTasks);
    assert.deepEqual(sessionsOf(await visit(`/sessions/${pub(coordinator)}`)), sessionsOf(on));
    await layers(DEFAULTS);

    const read = await owner('GET', shareAt);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.link.token, token);
    // Four tasks; two comments and one input file on T1; three runs out of the Trash, and the coordinator.
    assert.deepEqual(read.json.counts, { tasks: 4, comments: 2, files: 1, runs: 3, transcripts: 4 });
  });
});
