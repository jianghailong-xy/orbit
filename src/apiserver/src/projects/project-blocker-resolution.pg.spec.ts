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
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorDeliveryService } from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criterionSubjectId } from './coordinator-wake';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * A project blocker can be read, ended by its owner with a reason, and ends by itself once the
 * work it was about has landed.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-blocker-resolution.pg.spec.ts
 *
 * Until this, `project_blocker.resolved_at` had no writer in production: nothing on the API, MCP,
 * CLI or web could end an episode, and the projects list showed a count with no kind and no text.
 *
 * WHAT IS REAL
 * ============
 * The blockers are raised by the production path — a finished criterion's `CRITERION_UNLANDED`
 * fact routed through the real router into `WakeDispositionService` — and landing is a merge
 * receipt recorded through `MergeReceiptService`, whose post-commit edge is what runs in
 * production after every merge. The owner's door is driven over HTTP through the real controller,
 * validation pipe and public-id interceptor; only the JWT check is replaced, so that a bearer
 * token names the caller. Two things are written directly: DONE (through the database's own DONE
 * fence, as `project-get-query-count.pg.spec.ts` settles work) and the attempt's changed-file
 * snapshot. `blocker-disposition.pg.spec.ts` drives both through a runner round; what this file
 * is about starts after the blocker exists.
 *
 * Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A rung of the method ladder, so moving it up is an edit that lands (see blocker-disposition). */
const METHOD = 'VERIFICATION';
const PROMOTED_METHOD = 'EXECUTABLE';

/** The declaration every piece of work here carries, and the fence DONE is written through. */
const CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

const DECLARED_DIR = 'src/apiserver/src/projects';
const IN_SCOPE = `${DECLARED_DIR}/project-blocker-resolution.ts`;
/** The one file nobody asked for. */
const STRAY = 'src/runner-go/worktree.go';
const DECLARATION = `只改 ${DECLARED_DIR}/ 下面的东西，别碰别的目录。`;
/** Written prose arguing a criterion does not apply — not a criterion-change record. */
const ARGUMENT = '这条判据的阴性一项对本任务不适用：它测的是另一条路径，本任务没有碰那条路径。';

/** What an automatic resolution has to say about why it happened. */
const LANDED_NOTE = 'the work landed on main';

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
  router: CompletionInputRouter;
  tasks: TasksService;
  projects: ProjectsService;
  receipts: MergeReceiptService;
}

/** The production wiring over one client: the router is the real one, and so is every producer. */
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
  const convergence = new CoordinatorConvergenceService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  return {
    db,
    prisma,
    sql,
    router,
    tasks: new TasksService(prisma, sessions, realtime, undefined, router),
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    receipts: new MergeReceiptService(prisma, router),
  };
}

async function disconnect(stack: Stack): Promise<void> {
  await stack.db.$disconnect().catch(() => undefined);
  await stack.sql.end().catch(() => undefined);
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

/** One owner, one runner, and one project with a standing coordinator conversation. */
async function fixture(stack: Stack, label: string): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@blocker-resolution.invalid`,
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
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
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
      title: `${label} 有 blocker 的项目`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId };
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]): Promise<string[]> {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems).map((item) => item.key);
}

/** Move one criterion's method up the ladder, which advances its revision and keeps its id. */
async function moveTheStandard(stack: Stack, f: Fixture, texts: string[], moved: string) {
  const before = await stack.projects.get(f.ownerId, f.projectId);
  const items = criteriaFromDefinitions(before.acceptanceCriteriaItems);
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: items.map((item, index) => ({
      id: item.key,
      text: texts[index]!,
      verificationMethod: item.key === moved ? PROMOTED_METHOD : METHOD,
    })),
  } as never);
  const after = criteriaFromDefinitions(written.acceptanceCriteriaItems)
    .find((item) => item.key === moved);
  assert.equal(after?.definitionRevision, 2, 'the edit did not advance the criterion it moved');
}

/** File one piece of work against a criterion, through the door that resolves the key. */
async function fileWork(
  stack: Stack,
  f: Fixture,
  criterionKey: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await stack.tasks.create(f.ownerId, {
    title,
    projectId: f.projectId,
    criterionKey,
    ...CHECK,
    ...extra,
  } as never);
  return created.id;
}

/** DONE, through the database's DONE fence: the WHERE clause repeats the declaration. */
async function settle(stack: Stack, taskId: string): Promise<void> {
  const written = await stack.sql.query(
    `UPDATE "task" SET "status" = 'DONE'
      WHERE "id" = $1::uuid
        AND "status" IN ('OPEN', 'IN_PROGRESS')
        AND "completion_criterion" = 'EXECUTABLE'
        AND "acceptance_command" = 'true'
        AND "acceptance_expected_exit_code" = 0`,
    [taskId],
  );
  assert.equal(written.rowCount, 1, 'the task did not reach DONE through the DONE fence');
}

/** The attempt that produced the work, with the file set the runner reported for it. */
async function attempt(
  stack: Stack,
  f: Fixture,
  taskId: string,
  label: string,
  paths: readonly string[],
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
      startsTaskWork: true,
      branch: `orbit/${label}`,
      changedFiles: paths.map((path) => ({ path, additions: 1, deletions: 0, status: 'A' })),
    },
  });
  return sessionId;
}

/** A merge receipt, through the door every merge is recorded through. */
async function recordMerge(
  stack: Stack,
  f: Fixture,
  sessionId: string,
  receipt: Record<string, unknown>,
): Promise<void> {
  const recorded = await stack.receipts.record(f.ownerId, sessionId, {
    sourceSha: sha('a'),
    targetShaBefore: sha('b'),
    ...receipt,
  } as never, 'AGENT');
  assert.equal(recorded.created, true, 'the receipt was not recorded');
}

const MERGED_INTO_MAIN = { result: 'MERGED', targetBranch: 'main', targetShaAfter: sha('c') };

/** A blocker of a kind this file does not raise through a delivery, written the way 0125 shapes one. */
async function insertBlocker(
  stack: Stack,
  row: { projectId: string; kind: string; subjectType: string; subjectId: string; dedupeKey: string },
): Promise<string> {
  const id = randomUUID();
  await stack.sql.query(
    `INSERT INTO "project_blocker" (
       "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
       "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
       "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at", "updated_at"
     ) VALUES (
       $1::uuid, $2::uuid, $3, 'USER', 'HUMAN', 'CRITICAL', $4,
       now(), $5, $6, '{}'::jsonb, $7, 1, $8, now(), now(), now()
     )`,
    [
      id, row.projectId, row.kind, `Look at ${row.kind} and decide.`, row.subjectType,
      row.subjectId, row.dedupeKey, 'c'.repeat(64),
    ],
  );
  return id;
}

interface Resolution {
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedByUserId: string | null;
}

/** Everything the database recorded about how one blocker ended. */
async function resolutionOf(stack: Stack, blockerId: string): Promise<Resolution> {
  const { rows } = await stack.sql.query<Resolution>(
    `SELECT "resolved_at" AS "resolvedAt", "resolved_by"::text AS "resolvedBy",
            "resolution_note" AS "resolutionNote",
            "resolved_by_user_id"::text AS "resolvedByUserId"
       FROM "project_blocker" WHERE "id" = $1::uuid`,
    [blockerId],
  );
  assert.equal(rows.length, 1, 'the blocker row is gone');
  return rows[0]!;
}

/** The project's blockers as its detail read serves them, narrowed to what this file reads. */
interface ServedBlocker {
  id: string;
  kind: string;
  requiredAction: string;
  subjectTitle: string | null;
  detail: { reason?: string; paths?: string[] };
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

interface ServedBlockers {
  open: ServedBlocker[];
  resolved: ServedBlocker[];
  resolvedCount: number;
}

/** The owner's HTTP surface for projects, with a guard that takes the bearer token as the caller. */
async function openDoor(prisma: PrismaService): Promise<{ base: string; close: () => Promise<void> }> {
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useValue: projects },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: ProjectHandoffService, useValue: {} },
      { provide: SessionAttemptService, useValue: {} },
      { provide: TaskCheckpointService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
      { provide: PrismaService, useValue: prisma },
    ],
  })
  class BlockerDoorModule {}

  const app = await NestFactory.create(BlockerDoorModule, { logger: false, abortOnError: false });
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
  method: 'GET' | 'POST',
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

// (a) -----------------------------------------------------------------------------------------
test('the owner reads a blocker and ends it with a written reason, and nobody can rewrite that',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    const door = await openDoor(stack.prisma);
    t.after(async () => {
      await door.close();
      await disconnect(stack);
    });

    const f = await fixture(stack, 'door');
    const [criterionKey] = await state(stack, f, ['这条标准的活改了没让它改的东西']);
    const title = 'door 的交付：只动 projects 目录';
    const taskId = await fileWork(stack, f, criterionKey!, title, { description: DECLARATION });
    await settle(stack, taskId);
    await attempt(stack, f, taskId, 'door', [IN_SCOPE, STRAY]);
    const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
    assert.equal(
      delivered.find((one) => one.criterionSubjectId === criterionSubjectId(f.projectId, criterionKey!))
        ?.blockerKind,
      'AWAITING_USER_APPROVAL',
      'the fixture did not raise the blocker this case is about',
    );
    const [raised] = await stack.db.projectBlocker.findMany({
      where: { projectId: f.projectId, subjectId: taskId },
      select: { id: true, requiredAction: true },
    });
    assert.ok(raised, 'the raised blocker is not on the project');
    // A kind outside the three that clear themselves, about something that is not a task, so "any
    // blocker" is not only those three.
    const stalled = await insertBlocker(stack, {
      projectId: f.projectId,
      kind: 'PROVIDER_UNAVAILABLE',
      subjectType: 'PROVIDER',
      subjectId: 'claude',
      dedupeKey: 'PROVIDER_UNAVAILABLE:PROVIDER:claude',
    });
    const resolvePath = (id: string) => `/api/projects/${f.projectId}/blockers/${id}/resolve`;

    await t.test('the project read names its kind, what it asks for and the files it is about',
      async () => {
        const read = await call(door.base, f.ownerId, 'GET', `/api/projects/${f.projectId}`);
        assert.equal(read.status, 200, read.body);
        const blockers = read.json.blockers as ServedBlockers | undefined;
        assert.ok(blockers, `GET /projects/:id serves no blockers: ${read.body.slice(0, 400)}`);
        assert.equal(blockers.resolvedCount, 0);
        assert.deepEqual(blockers.resolved, []);
        assert.deepEqual(blockers.open.map((one) => one.id).sort(),
          [uuidToBase62(raised.id), uuidToBase62(stalled)].sort());
        const served = blockers.open.find((one) => one.id === uuidToBase62(raised.id))!;
        assert.equal(served.kind, 'AWAITING_USER_APPROVAL');
        assert.equal(served.requiredAction, raised.requiredAction);
        assert.ok(served.requiredAction.trim() !== '', 'the blocker says nothing about what to do');
        assert.equal(served.detail.reason, 'OUTSIDE_DECLARED_SCOPE');
        assert.deepEqual(served.detail.paths, [STRAY], 'the read does not name the stray file');
        assert.equal(served.subjectTitle, title, 'the read does not say which work it is about');
        assert.equal(served.resolvedAt, null);
      });

    await t.test('somebody who does not own the project is refused, and the blocker stays open',
      async () => {
        const stranger = randomUUID();
        const refused = await call(door.base, stranger, 'POST', resolvePath(raised.id), {
          reason: 'not my project, closing it anyway',
        });
        assert.equal(refused.status, 404, refused.body);
        assert.equal(refused.json.message, 'blocker not found',
          `refused for a reason other than ownership: ${refused.body}`);
        assert.equal((await resolutionOf(stack, raised.id)).resolvedAt, null);
      });

    await t.test('the owner is refused without a reason', async () => {
      const blank = await call(door.base, f.ownerId, 'POST', resolvePath(raised.id), {
        reason: '   ',
      });
      assert.equal(blank.status, 400, blank.body);
      const missing = await call(door.base, f.ownerId, 'POST', resolvePath(raised.id), {});
      assert.equal(missing.status, 400, missing.body);
      assert.equal((await resolutionOf(stack, raised.id)).resolvedAt, null);
    });

    const reason = '已合入 main，判据已满足；这个文件是注入作业状态的必要改动，接受。';

    await t.test('the owner resolves it with a reason: USER, who and why are recorded', async () => {
      const resolved = await call(door.base, f.ownerId, 'POST', resolvePath(raised.id), { reason });
      assert.equal(resolved.status, 201, resolved.body);
      assert.equal(resolved.json.id, uuidToBase62(raised.id));
      assert.equal(resolved.json.resolvedBy, 'USER');
      assert.equal(resolved.json.resolutionNote, reason);

      const row = await resolutionOf(stack, raised.id);
      assert.ok(row.resolvedAt instanceof Date, 'the resolution was not written');
      assert.equal(row.resolvedBy, 'USER');
      assert.equal(row.resolutionNote, reason);
      assert.equal(row.resolvedByUserId, f.ownerId);

      const read = await call(door.base, f.ownerId, 'GET', `/api/projects/${f.projectId}`);
      const blockers = read.json.blockers as ServedBlockers;
      assert.deepEqual(blockers.open.map((one) => one.id), [uuidToBase62(stalled)]);
      assert.equal(blockers.resolvedCount, 1);
      assert.equal(blockers.resolved[0]?.id, uuidToBase62(raised.id));
      assert.equal(blockers.resolved[0]?.resolvedBy, 'USER');
      assert.equal(blockers.resolved[0]?.resolutionNote, reason);
    });

    await t.test('a resolved blocker is not resolved again, and its record cannot be rewritten',
      async () => {
        const before = await resolutionOf(stack, raised.id);
        const again = await call(door.base, f.ownerId, 'POST', resolvePath(raised.id), {
          reason: 'a second, different reason',
        });
        assert.equal(again.status, 409, again.body);
        assert.equal(again.json.code, 'BLOCKER_ALREADY_RESOLVED', again.body);
        assert.deepEqual(await resolutionOf(stack, raised.id), before);

        for (const [column, value] of [
          ['resolution_note', `'rewritten afterwards'`],
          ['resolved_by_user_id', `'${randomUUID()}'::uuid`],
          ['resolved_at', 'now()'],
        ] as const) {
          await assert.rejects(
            stack.sql.query(
              `UPDATE "project_blocker" SET "${column}" = ${value} WHERE "id" = $1::uuid`,
              [raised.id],
            ),
            /BLOCKER_RESOLVED_IMMUTABLE/,
            `${column} of a resolved blocker was rewritten`,
          );
        }
        assert.deepEqual(await resolutionOf(stack, raised.id), before);
      });

    await t.test('any kind of blocker can be ended this way, addressed by its public id',
      async () => {
        const resolved = await call(door.base, f.ownerId, 'POST', resolvePath(uuidToBase62(stalled)), {
          reason: 'claude 的额度已经恢复，派发不再被拒。',
        });
        assert.equal(resolved.status, 201, resolved.body);
        const row = await resolutionOf(stack, stalled);
        assert.equal(row.resolvedBy, 'USER');
        assert.equal(row.resolvedByUserId, f.ownerId);
      });
  });

// (b) -----------------------------------------------------------------------------------------
test('an argued exemption, a moved standard and an undeclared file wait for their work to land, '
  + 'then resolve themselves with the reason written down',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    const f = await fixture(stack, 'landing');
    const texts = [
      '这条标准的活声称某条判据不适用',
      '这条标准的活要通过就得改验收标准',
      '这条标准的活改了没让它改的东西',
    ];
    const [exemptionKey, standardKey, scopeKey] = await state(stack, f, texts);
    const exemption = await fileWork(stack, f, exemptionKey!, 'landing：写了豁免理由的交付', {
      completionCriterionOverrideReason: ARGUMENT,
    });
    const standard = await fileWork(stack, f, standardKey!, 'landing：开工后标准被改过的交付');
    const scope = await fileWork(stack, f, scopeKey!, 'landing：改了声明外文件的交付', {
      description: DECLARATION,
    });
    await moveTheStandard(stack, f, texts, standardKey!);

    const sessions = {
      exemption: '',
      standard: '',
      scope: '',
    };
    for (const [name, taskId, paths] of [
      ['exemption', exemption, [IN_SCOPE]],
      ['standard', standard, [IN_SCOPE]],
      ['scope', scope, [IN_SCOPE, STRAY]],
    ] as const) {
      await settle(stack, taskId);
      sessions[name] = await attempt(stack, f, taskId, `landing-${name}`, paths);
    }

    const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
    const kindFor = (key: string) => delivered
      .find((one) => one.criterionSubjectId === criterionSubjectId(f.projectId, key))?.blockerKind;
    assert.deepEqual(
      [kindFor(exemptionKey!), kindFor(standardKey!), kindFor(scopeKey!)],
      ['HUMAN_DECISION_REQUIRED', 'POLICY_MANUAL_HOLD', 'AWAITING_USER_APPROVAL'],
      'the fixture did not raise the three blockers this case is about',
    );

    const keys = {
      exemption: `HUMAN_DECISION_REQUIRED:CRITERION_EXEMPTION_ARGUED:${exemption}`,
      standard: `POLICY_MANUAL_HOLD:ACCEPTANCE_STANDARD_MOVED:${standard}`,
      scope: `AWAITING_USER_APPROVAL:OUTSIDE_DECLARED_SCOPE:${scope}`,
      // The same kind as the argued exemption, about the same task, for a different reason — the
      // missing-judgment-path signal's key. Landing is not what that one is about.
      noJudgment: `HUMAN_DECISION_REQUIRED:TASK_NO_JUDGMENT:${exemption}`,
    };
    await insertBlocker(stack, {
      projectId: f.projectId,
      kind: 'HUMAN_DECISION_REQUIRED',
      subjectType: 'TASK',
      subjectId: exemption,
      dedupeKey: keys.noJudgment,
    });

    const all = [keys.exemption, keys.standard, keys.scope, keys.noJudgment].sort();
    // Narrowed to these four. The receipts below also reach the project's other facts, and the
    // convergence ledger may raise its own blocker over them; that one is not about landing.
    const open = async () => (await stack.db.projectBlocker.findMany({
      where: { projectId: f.projectId, resolvedAt: null, dedupeKey: { in: all } },
      select: { dedupeKey: true },
    })).map((row) => row.dedupeKey).sort();

    await t.test('nothing resolves before the work lands', async () => {
      assert.deepEqual(await open(), all, 'the fixture does not start with four open blockers');

      await stack.router.routeUnlandedCriteria([f.projectId]);
      assert.deepEqual(await open(), all, 'a redelivery of the unlanded fact resolved a blocker');

      await recordMerge(stack, f, sessions.exemption, {
        result: 'MERGED', targetBranch: 'release/elsewhere', targetShaAfter: sha('d'),
      });
      assert.deepEqual(await open(), all, 'a merge into another branch was taken for landing');

      await recordMerge(stack, f, sessions.standard, {
        result: 'CONFLICT', targetBranch: 'main', conflicts: [IN_SCOPE],
      });
      assert.deepEqual(await open(), all, 'a merge git refused was taken for landing');
    });

    await t.test('each resolves when its own work lands, and nothing else does', async () => {
      await recordMerge(stack, f, sessions.exemption, MERGED_INTO_MAIN);
      assert.deepEqual(await open(), [keys.standard, keys.scope, keys.noJudgment].sort(),
        'landing the argued exemption did not resolve exactly its own blocker');

      await recordMerge(stack, f, sessions.standard, {
        result: 'ALREADY_MERGED', targetBranch: 'main', targetShaAfter: sha('c'),
      });
      assert.deepEqual(await open(), [keys.scope, keys.noJudgment].sort(),
        'landing the work under a moved standard did not resolve exactly its own blocker');

      await recordMerge(stack, f, sessions.scope, MERGED_INTO_MAIN);
      assert.deepEqual(await open(), [keys.noJudgment],
        'landing resolved a blocker that is not about landing, or left one that is');
    });

    await t.test('each automatic resolution is recorded as AUTO, with why, and by nobody',
      async () => {
        const rows = await stack.db.projectBlocker.findMany({
          where: { projectId: f.projectId },
          select: { id: true, dedupeKey: true },
        });
        for (const key of [keys.exemption, keys.standard, keys.scope]) {
          const episodes = rows.filter((row) => row.dedupeKey === key);
          assert.equal(episodes.length, 1, `${key}: landing opened another episode`);
          const row = await resolutionOf(stack, episodes[0]!.id);
          assert.ok(row.resolvedAt instanceof Date, `${key}: not resolved`);
          assert.equal(row.resolvedBy, 'AUTO', `${key}: not resolved by the platform`);
          assert.equal(row.resolutionNote, LANDED_NOTE, `${key}: the reason is not written down`);
          assert.equal(row.resolvedByUserId, null, `${key}: an automatic resolution names a person`);
        }

        // And it stays that way: the landed criteria have no unlanded fact left to raise one.
        await stack.router.routeUnlandedCriteria([f.projectId]);
        assert.equal(await stack.db.projectBlocker.count({
          where: { projectId: f.projectId, dedupeKey: { in: all } },
        }), 4, 'a landed criterion raised one of these blockers again');
        assert.deepEqual(await open(), [keys.noJudgment]);
      });
  });
