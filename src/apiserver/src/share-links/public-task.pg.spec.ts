/**
 * A task shared by a public link — share-links/public-task.ts over real HTTP (the real
 * SharedController, ShareLinksController and TasksController behind main.ts's pipe, interceptors
 * and filters, the JWT guard fed by a stubbed verifier) against a real, fully migrated PostgreSQL.
 * docs/share-links-design.md §1, §5, §6 and §7 are the contract. What it is held to:
 *
 *   (1) the task page is exactly the projection's fields — the set of field paths deepEquals the
 *       expected one — with its layers off, and with both on;
 *   (2) the red line: a runner name, a local path, a branch, a SHA, a provider, a model, the owner's
 *       address and id, the dispatch ledger, a comment's delivery record, the coordinator's
 *       conversation and the titles of dependencies in another project are planted in the owner's
 *       data. Each is first shown in the owner's own GET /tasks/:id, then shown absent — as a value,
 *       and as a field name — from every answer the link gives;
 *   (3) with Comments & files off there are no comments and no input files, and an input's bytes
 *       404; with Conversations off no run carries a session id, and every conversation route and
 *       run attachment 404s — each layer independently of the other;
 *   (4) with Conversations on, the task's runs open under /shared/:token/sessions/:id (the page, a
 *       page of events, one event); a session that is not one of its runs, and a run in the Trash,
 *       answer the one 404; none of it counts a view;
 *   (5) dependencies inside the task's project are named, those in another project only counted;
 *   (6) the owner's dialog read counts what each layer holds.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/share-links/public-task.pg.spec.ts
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
import { ProjectAttributionService } from '../projects/project-attribution.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { SharedRateLimiter } from '../shared/public-surface.guard';
import { SharedController } from '../shared/shared.controller';
import { TasksController } from '../tasks/tasks.controller';
import { TasksService } from '../tasks/tasks.service';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

// What main.ts installs before the app serves anything: the owner's task detail carries BIGINT
// columns, and without this JSON.stringify refuses them.
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

/** Every field path an answer carries — `root.runs[].state` — so two answers compare as field sets. */
function fieldPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => fieldPaths(item, `${prefix}[]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Json).flatMap(([key, child]) => {
    const at = prefix ? `${prefix}.${key}` : key;
    return [at, ...fieldPaths(child, at)];
  });
}
const fieldSet = (json: unknown): string[] => [...new Set(fieldPaths(json))].sort();

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
 * Contract §6 as field names: owner and account, runner and machine, repository, compute, the
 * dispatch / convergence / verification internals, comment delivery records. None of them is a
 * field of any public answer, whatever the link includes.
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
];

test('a shared task: an explicit projection, the red line, its layers and its runs', {
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
    sha: `${RUN}${'a'.repeat(32)}`,
    provider: `secret-provider-${RUN}`,
    model: `secret-model-${RUN}`,
    // The owner's address, as their name too: it is how a person's comment is signed to its owner.
    email: `owner.${RUN}@secret-mail.invalid`,
    idempotency: `secret-idempotency-${RUN}`,
    delivery: `secret-delivery-error-${RUN}`,
    coordinator: `SECRET coordinator conversation ${RUN}`,
    crossPrerequisite: `SECRET prerequisite in another project ${RUN}`,
    crossDependent: `SECRET dependent in another project ${RUN}`,
  };

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: SECRET.email, name: SECRET.email, passwordHash: 'x' } });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: SECRET.runner, tokenHash: `public-task-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  const WORKSPACE = `orbit ${RUN}`;
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: WORKSPACE, enabled: true, model: SECRET.model, workDir: SECRET.path },
  });
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId, title: `Share-links project ${RUN}` } });
  await db.project.create({ data: { id: otherProjectId, ownerId, title: `Another project ${RUN}` } });

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

  const coordinator = await session(SECRET.coordinator);
  const successor = await task(`The attempt that replaced it ${RUN}`);
  // An earlier attempt, replaced by `successor`: what its page says about how it ended.
  const replaced = await task(`An attempt that was replaced ${RUN}`, {
    status: TaskStatus.CANCELLED,
    terminalReason: 'SUPERSEDED',
    supersededByTaskId: successor,
    supersededAt: new Date(),
  });
  const TITLE = `T6 public task ${RUN}`;
  const DESCRIPTION = `## What to do\n\nShare the task, **not** its machine. ${RUN}`;
  const CRITERIA = `The page reads in the panel's order. ${RUN}`;
  const COMMAND = 'npm test -w @orbit/web';
  const shared = await task(TITLE, {
    description: DESCRIPTION,
    acceptanceCriteria: CRITERIA,
    acceptanceCommand: COMMAND,
    acceptanceExpectedExitCode: 0,
    status: TaskStatus.IN_PROGRESS,
    assigneeId: workspaceId,
    creatorSessionId: coordinator,
    provider: SECRET.provider,
    model: SECRET.model,
    knownGoodSha: SECRET.sha,
    pinnedRevision: `refs/heads/${SECRET.branch}`,
    idempotencyKey: SECRET.idempotency,
    dispatchRefusal: {
      code: 'DEPENDENCY_BASE_NOT_LANDED',
      fixAction: 'LAND_PREREQUISITE',
      refusedAt: new Date().toISOString(),
      sessionId: coordinator,
      baseSha: SECRET.sha,
      ref: `refs/heads/${SECRET.branch}`,
      missing: [],
      reason: `runner ${SECRET.runner} could not check out ${SECRET.path}`,
    },
  });
  // Its prerequisites are done — a task waiting on one could not have started the runs below.
  const inProjectPrerequisite = await task(`Same-project prerequisite ${RUN}`, { status: TaskStatus.DONE });
  const inProjectDependent = await task(`Same-project dependent ${RUN}`);
  const crossPrerequisite = await task(SECRET.crossPrerequisite, { projectId: otherProjectId, status: TaskStatus.DONE });
  const crossDependent = await task(SECRET.crossDependent, { projectId: otherProjectId });
  for (const [from, to] of [
    [shared, inProjectPrerequisite], [shared, crossPrerequisite],
    [inProjectDependent, shared], [crossDependent, shared],
  ]) {
    await db.taskDependency.create({ data: { taskId: from, dependsOnTaskId: to } });
  }

  const AGENT_COMMENT = `Delivered: two spec files ${RUN}. @${WORKSPACE}`;
  const OWNER_COMMENT = `Looks right to me ${RUN}`;
  const agentComment = await db.taskComment.create({
    data: {
      taskId: shared, authorType: CreatorType.AGENT, authorId: workspaceId, body: AGENT_COMMENT,
      mentions: [workspaceId], mentionDeliveryVersion: 1, createdAt: new Date('2026-09-25T03:17:00Z'),
    },
    select: { id: true },
  });
  // The mention's delivery record — written when the comment is, and the one it went wrong on.
  const failedDelivery = {
    status: TaskCommentMentionDeliveryStatus.DEAD, attempts: 8, lastError: SECRET.delivery,
    requiredAction: 'look at the runner', targetSessionId: coordinator,
  };
  await db.taskCommentMentionDelivery.upsert({
    where: { commentId_workspaceId: { commentId: agentComment.id, workspaceId } },
    create: { commentId: agentComment.id, taskId: shared, workspaceId, ownerId, ...failedDelivery },
    update: failedDelivery,
  });
  await db.taskComment.create({
    data: {
      taskId: shared, authorType: CreatorType.USER, authorId: ownerId, body: OWNER_COMMENT,
      createdAt: new Date('2026-09-25T04:00:00Z'),
    },
  });
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
  const input = (await db.attachment.create({
    data: { ownerId, taskId: shared, mimeType: 'image/png', sizeBytes: png.length, fileName: 'design-mock.png', data: Uint8Array.from(png) },
    select: { id: true },
  })).id;

  // Its runs: one that succeeded (with a transcript and an image), one in the Trash, one running.
  const RUN_FIELDS = { taskId: shared, provider: SECRET.provider, model: SECRET.model, branch: SECRET.branch, baseSha: SECRET.sha, costUsd: 12.5 };
  const succeeded = await session(`Run of ${TITLE}`, {
    ...RUN_FIELDS, status: RunStatus.SUCCEEDED,
    createdAt: new Date('2026-09-20T10:00:00Z'), startedAt: new Date('2026-09-20T10:00:05Z'),
    finishedAt: new Date('2026-09-20T11:11:05Z'),
  });
  const trashed = await session(`Trashed run of ${TITLE}`, {
    ...RUN_FIELDS, status: RunStatus.FAILED, createdAt: new Date('2026-09-21T10:00:00Z'),
    finishedAt: new Date('2026-09-21T10:30:00Z'), deletedAt: new Date(),
  });
  const running = await session(`Rerun of ${TITLE}`, {
    ...RUN_FIELDS, status: RunStatus.RUNNING, assignedRunnerId: runnerId,
    createdAt: new Date('2026-09-22T09:00:00Z'), startedAt: new Date('2026-09-22T09:00:02Z'),
  });
  await event(succeeded, 1, RunEventType.USER, { text: 'Share the task.' });
  await event(succeeded, 2, RunEventType.ASSISTANT, { text: 'Reading the contract first.' });
  await event(succeeded, 3, RunEventType.TOOL_USE, { id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } });
  await event(succeeded, 4, RunEventType.TOOL_RESULT, { toolUseId: 'toolu_1', content: 'ok', isError: false });
  await event(trashed, 1, RunEventType.USER, { text: 'In the Trash.' });
  const runImage = (await db.attachment.create({
    data: { ownerId, sessionId: succeeded, mimeType: 'image/png', sizeBytes: png.length, fileName: 'shot.png', data: Uint8Array.from(png) },
    select: { id: true },
  })).id;
  // A conversation that is not one of its runs: the successor's.
  const notARun = await session(`Run of the successor ${RUN}`, { taskId: successor });

  // ── the app: the real controllers, main.ts's middleware, pipe, interceptors and filters ──────
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, {} as never, realtime);
  const tasks = new TasksService(prisma, sessions, realtime);
  @Module({
    controllers: [SharedController, ShareLinksController, TasksController],
    providers: [
      { provide: SessionsService, useValue: sessions },
      { provide: TasksService, useValue: tasks },
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
  class PublicTaskHarness {}

  app = await NestFactory.create(PublicTaskHarness, { logger: ['error'], abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const owner = (method: string, p: string, body?: unknown) => send(base, method, `/api${p}`, { as: 'owner', body });
  const shareAt = `/tasks/${pub(shared)}/share`;
  const link = await owner('PUT', shareAt, {});
  assert.equal(link.status, 200, link.text);
  const token = link.json.token as string;
  const visit = (rest = '') => send(base, 'GET', `/api/shared/${encodeURIComponent(token)}${rest}`);
  const layers = async (include: Json) => {
    const changed = await owner('PUT', shareAt, { include });
    assert.equal(changed.status, 200, changed.text);
  };
  const views = async () =>
    Number((await sql.query('SELECT view_count FROM share_link WHERE token = $1', [token])).rows[0].view_count);
  // The answer a dead token gets; every refused sub-route must give exactly this.
  const dead = await send(base, 'GET', `/api/shared/${'x'.repeat(32)}`);
  assert.equal(dead.status, 404);
  const isDead = (answer: Answer, what: string) => {
    assert.equal(answer.status, 404, `${what}: ${answer.text.slice(0, 200)}`);
    assert.deepEqual(answer.body, dead.body, `${what}: a refused route must answer as a dead link does`);
  };

  const OVERVIEW_FIELDS = [
    'include', 'include.commentsAndFiles', 'include.conversations', 'include.toolOutput', 'kind', 'sharedAt',
    'root', 'root.id', 'root.publicId', 'root.title', 'root.status', 'root.outcome',
    'root.supersededBy', 'root.completionCriterion', 'root.createdAt',
    'root.project', 'root.project.title', 'root.description', 'root.acceptanceCriteria',
    'root.acceptanceCommand', 'root.acceptanceExpectedExitCode',
    'root.dependencies', 'root.dependencies.prerequisites', 'root.dependencies.prerequisites[].id',
    'root.dependencies.prerequisites[].publicId', 'root.dependencies.prerequisites[].title',
    'root.dependencies.prerequisites[].status', 'root.dependencies.dependents', 'root.dependencies.dependents[].id',
    'root.dependencies.dependents[].publicId', 'root.dependencies.dependents[].title',
    'root.dependencies.dependents[].status', 'root.dependencies.prerequisitesInOtherProjects',
    'root.dependencies.dependentsInOtherProjects',
    'root.runs', 'root.runs[].state', 'root.runs[].startedAt', 'root.runs[].endedAt', 'root.runs[].durationMs',
  ];
  const CONVERSATION_FIELDS = ['root.runs[].sessionId', 'root.runs[].sessionPublicId'];
  const COMMENTS_AND_FILES_FIELDS = [
    'root.comments', 'root.comments[].author', 'root.comments[].body', 'root.comments[].createdAt',
    'root.inputs', 'root.inputs[].id', 'root.inputs[].publicId', 'root.inputs[].fileName',
    'root.inputs[].mimeType', 'root.inputs[].sizeBytes', 'root.inputs[].createdAt',
  ];

  await t.test('(1) the task page is the projection\'s fields, exactly — with its layers off and on', async () => {
    const off = await visit();
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.kind, 'TASK');
    assert.deepEqual(off.json.include, { commentsAndFiles: false, conversations: false, toolOutput: true });
    assert.deepEqual(fieldSet(off.json), [...OVERVIEW_FIELDS].sort());

    const root = off.json.root;
    assert.equal(root.id, pub(shared));
    assert.equal(root.title, TITLE);
    assert.equal(root.status, 'IN_PROGRESS');
    assert.equal(root.outcome, 'IN_PROGRESS');
    assert.equal(root.supersededBy, null);
    assert.equal(root.completionCriterion, 'EVIDENCE_JUDGMENT');
    assert.deepEqual(root.project, { title: `Share-links project ${RUN}` });
    assert.equal(root.description, DESCRIPTION);
    assert.equal(root.acceptanceCriteria, CRITERIA);
    assert.equal(root.acceptanceCommand, COMMAND);
    assert.equal(root.acceptanceExpectedExitCode, 0);
    // Its runs, newest first; the one in the Trash is not listed. How each went, when, how long.
    assert.deepEqual(root.runs, [
      { state: 'RUNNING', startedAt: '2026-09-22T09:00:02.000Z', endedAt: null, durationMs: null },
      {
        state: 'SUCCEEDED', startedAt: '2026-09-20T10:00:05.000Z', endedAt: '2026-09-20T11:11:05.000Z',
        durationMs: 71 * 60_000,
      },
    ]);

    await layers({ commentsAndFiles: true, conversations: true });
    const on = await visit();
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(fieldSet(on.json), [...OVERVIEW_FIELDS, ...CONVERSATION_FIELDS, ...COMMENTS_AND_FILES_FIELDS].sort());
    assert.deepEqual(on.json.root.runs.map((r: Json) => r.sessionId), [pub(running), pub(succeeded)]);
    // Signed as the contract signs them: the agent's workspace by name, the person as "Owner".
    assert.deepEqual(on.json.root.comments, [
      { author: WORKSPACE, body: AGENT_COMMENT, createdAt: '2026-09-25T03:17:00.000Z' },
      { author: 'Owner', body: OWNER_COMMENT, createdAt: '2026-09-25T04:00:00.000Z' },
    ]);
    assert.equal(on.json.root.inputs.length, 1);
    assert.deepEqual(
      { ...on.json.root.inputs[0], createdAt: undefined },
      { id: pub(input), publicId: pub(input), fileName: 'design-mock.png', mimeType: 'image/png', sizeBytes: png.length, createdAt: undefined },
    );
    await layers({ commentsAndFiles: false, conversations: false });

    // An attempt that was replaced says so — Superseded, not the Cancelled its status alone reads —
    // and names what replaced it. By title only: that is another task, which its link does not share.
    const replacedLink = await owner('PUT', `/tasks/${pub(replaced)}/share`, {});
    assert.equal(replacedLink.status, 200, replacedLink.text);
    const replacedPage = await send(base, 'GET', `/api/shared/${encodeURIComponent(replacedLink.json.token)}`);
    assert.equal(replacedPage.status, 200, replacedPage.text);
    assert.equal(replacedPage.json.root.status, 'CANCELLED');
    assert.equal(replacedPage.json.root.outcome, 'SUPERSEDED');
    assert.deepEqual(replacedPage.json.root.supersededBy, { title: `The attempt that replaced it ${RUN}` });
    assert.equal(replacedPage.text.includes(pub(successor)), false, 'the successor, outside the link, was addressed');
  });

  await t.test('(2) the red line: planted in the owner\'s task, shown there first, absent from every public answer', async () => {
    // Ids the owner's read carries and a visitor's must not: the owner, the assignee, the
    // coordinator's conversation, the tasks in another project, the run in the Trash.
    const ids = { owner: ownerId, workspace: workspaceId, coordinator, crossPrerequisite, crossDependent, trashed };
    const values = [
      ...Object.values(SECRET),
      ...Object.values(ids).map(pub),
      ...Object.values(ids),
    ];

    // The positive control: every planted value is really in the owner's own GET /tasks/:id — base62
    // there, as every id is — and so is every red-line field this read has.
    const mine = await owner('GET', `/tasks/${pub(shared)}`);
    assert.equal(mine.status, 200, mine.text);
    const inOwners = [...Object.values(SECRET), ...Object.values(ids).map(pub)];
    assert.deepEqual(inOwners.filter((value) => !mine.text.includes(value)), [], 'the fixture did not plant what (2) looks for');
    const ownerKeys = keysOf(mine.json);
    assert.deepEqual(
      ['ownerId', 'creatorSession', 'assignee', 'provider', 'model', 'knownGoodSha', 'pinnedRevision', 'idempotencyKey',
        'dispatchAuthority', 'dispatchRefusal', 'convergenceCounters', 'progressState', 'deliveries', 'mentions',
        'authorId', 'lastError'].filter((name) => !ownerKeys.has(name)),
      [],
      'the owner\'s read lost a field (2) proves absent from the public one',
    );

    // Every answer the link gives, with every layer on — the most it can show — and with none.
    await layers({ commentsAndFiles: true, conversations: true });
    const answers: [string, Answer][] = [
      ['task page, all layers', await visit()],
      ['conversation', await visit(`/sessions/${pub(succeeded)}`)],
      ['conversation, events', await visit(`/sessions/${pub(succeeded)}/events?limit=2`)],
      ['conversation, one event', await visit(`/sessions/${pub(succeeded)}/events/3`)],
    ];
    await layers({ commentsAndFiles: false, conversations: false });
    answers.push(['task page, no layers', await visit()]);
    for (const [what, answer] of answers) {
      assert.equal(answer.status, 200, `${what}: ${answer.text.slice(0, 300)}`);
      assert.deepEqual(values.filter((value) => answer.text.includes(value)), [], `${what} carries a red-line value`);
      // A transcript's events are the conversation itself — command output and file contents are
      // what the Conversations layer warns about — so their payloads are not fields of the page.
      const envelope = answer.json.events ? { ...answer.json, events: [] } : answer.json;
      const keys = keysOf(what.endsWith('one event') ? { ...envelope, payload: null } : envelope);
      assert.deepEqual(RED_LINE_FIELDS.filter((name) => keys.has(name)), [], `${what} carries a red-line field`);
    }
  });

  await t.test('(3) each layer off: its data is not returned and its routes 404, whatever the other says', async () => {
    const conversationRoutes = [
      `/sessions/${pub(succeeded)}`,
      `/sessions/${pub(succeeded)}/events`,
      `/sessions/${pub(succeeded)}/events/1`,
      `/attachments/${pub(runImage)}`,
    ];
    const commentsAndFilesRoutes = [`/attachments/${pub(input)}`];
    const runIds = [succeeded, running].flatMap((id) => [id, pub(id)]);

    for (const include of [
      { commentsAndFiles: false, conversations: false },
      { commentsAndFiles: true, conversations: false },
      { commentsAndFiles: false, conversations: true },
    ]) {
      await layers(include);
      const label = JSON.stringify(include);
      const page = await visit();
      assert.equal(page.status, 200, page.text);
      if (!include.commentsAndFiles) {
        assert.equal('comments' in page.json.root, false, `${label}: comments returned`);
        assert.equal('inputs' in page.json.root, false, `${label}: input files returned`);
        for (const text of [AGENT_COMMENT, OWNER_COMMENT, 'design-mock.png']) {
          assert.equal(page.text.includes(text), false, `${label}: ${text} reached the page`);
        }
        for (const route of commentsAndFilesRoutes) isDead(await visit(route), `${label} ${route}`);
      } else {
        assert.equal(page.json.root.comments.length, 2);
        for (const route of commentsAndFilesRoutes) {
          const file = await visit(route);
          assert.equal(file.status, 200, `${label} ${route}: ${file.text}`);
          assert.deepEqual(file.body, png);
        }
      }
      if (!include.conversations) {
        assert.ok(page.json.root.runs.every((run: Json) => !('sessionId' in run)), `${label}: a run carries its session`);
        assert.deepEqual(runIds.filter((id) => page.text.includes(id)), [], `${label}: a run's id reached the page`);
        for (const route of conversationRoutes) isDead(await visit(route), `${label} ${route}`);
      } else {
        for (const route of conversationRoutes) {
          const answer = await visit(route);
          assert.equal(answer.status, 200, `${label} ${route}: ${answer.text.slice(0, 200)}`);
        }
      }
    }
  });

  await t.test('(4) its runs open with Conversations; nothing else does, and none of it counts a view', async () => {
    await layers({ conversations: true });
    const before = await views();

    const page = await visit(`/sessions/${pub(succeeded)}?limit=3`);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.title, `Run of ${TITLE}`);
    assert.equal(page.json.runState, 'SUCCEEDED');
    assert.deepEqual(page.json.events.map((e: Json) => e.seq), [2, 3, 4]);
    assert.equal(page.json.hasMore, true);
    // The task it is a run of, and the task's runs a visitor may open — for the breadcrumb and links.
    assert.deepEqual(page.json.task, {
      id: pub(shared), publicId: pub(shared), title: TITLE,
      runs: [{ sessionId: pub(running), sessionPublicId: pub(running) }, { sessionId: pub(succeeded), sessionPublicId: pub(succeeded) }],
    });
    const older = await visit(`/sessions/${pub(succeeded)}/events?before=2&limit=5`);
    assert.equal(older.status, 200, older.text);
    assert.deepEqual(older.json.events.map((e: Json) => e.seq), [1]);
    assert.equal(older.json.hasMore, false);
    const one = await visit(`/sessions/${pub(succeeded)}/events/3`);
    assert.equal(one.status, 200, one.text);
    assert.deepEqual(one.json.payload, { id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } });
    const image = await visit(`/attachments/${pub(runImage)}`);
    assert.equal(image.status, 200, image.text);
    assert.deepEqual(image.body, png);

    // A run in the Trash is paused, and a session that is not one of its runs is not shared at all.
    for (const [id, what] of [[trashed, 'a run in the Trash'], [notARun, 'another task\'s run'], [coordinator, 'the coordinator']] as const) {
      isDead(await visit(`/sessions/${pub(id)}`), what);
      isDead(await visit(`/sessions/${pub(id)}/events`), `${what}, events`);
      isDead(await visit(`/sessions/${pub(id)}/events/1`), `${what}, one event`);
    }
    // The routes a session link's own transcript answers on are not a task link's.
    isDead(await visit('/events'), 'the session-root events page');
    isDead(await visit('/events/1'), 'the session-root event');
    assert.equal(await views(), before, 'a page below the root counted a view');

    // Restored from the Trash, the run is listed and opens again.
    await db.session.update({ where: { id: trashed }, data: { deletedAt: null } });
    assert.equal((await visit(`/sessions/${pub(trashed)}`)).status, 200);
    await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });
    await layers({ conversations: false });
  });

  await t.test('(5) a dependency in the task\'s project is named; one in another project is only counted', async () => {
    const page = await visit();
    assert.equal(page.status, 200, page.text);
    assert.deepEqual(page.json.root.dependencies, {
      prerequisites: [{ id: pub(inProjectPrerequisite), publicId: pub(inProjectPrerequisite), title: `Same-project prerequisite ${RUN}`, status: 'DONE' }],
      dependents: [{ id: pub(inProjectDependent), publicId: pub(inProjectDependent), title: `Same-project dependent ${RUN}`, status: 'OPEN' }],
      prerequisitesInOtherProjects: 1,
      dependentsInOtherProjects: 1,
    });
  });

  await t.test('(6) the dialog\'s read counts what each layer holds, for its owner', async () => {
    const read = await owner('GET', shareAt);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.link.token, token);
    // Two comments and one input file; two runs to read — the one in the Trash is not counted.
    assert.deepEqual(read.json.counts, { comments: 2, files: 1, transcripts: 2 });
  });
});
