import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
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
import {
  CriterionUnlandedProducer,
  type CriterionUnlandedDelivery,
} from './criterion-unlanded.producer';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { integrationDedupeKey, integrationItemTitle } from './project-integration-job';
import { configureProjectIntegration } from './project-integration-line';
import {
  INTEGRATION_RETRY_COORDINATOR_ONLY,
  INTEGRATION_RETRY_OWNER_BLOCKER,
  INTEGRATION_RETRY_OWNER_ITEM,
  INTEGRATION_RETRY_REASON_REQUIRED,
} from './project-integration-retry';
import { readProjectListAttention } from './project-list-attention';
import { OPEN_ITEM_TURN_PREFIX, ownerItemKind, recordIntegrationFailure } from './project-open-item';
import {
  OPEN_ITEM_COORDINATOR_ONLY,
  OPEN_ITEM_NOT_COORDINATOR_ITEM,
  ProjectOpenItemService,
} from './project-open-item.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { WakeDispositionService } from './wake-disposition.service';

/**
 * Who answers what in an Automatic project, from the delivery that raises the question to the
 * ending it reaches (task 34YBYkUc5zDszvHuhYEyh, `blocker-disposition.ts` §4).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/automatic-coordinator-routing.pg.spec.ts
 *
 * THE INCIDENT THIS PINS
 * ======================
 * 2026-10-01, project 34Y7My8sqhKLWtmCQYv1l: task ③'s own acceptance passed, and its delivery
 * changed twenty files its declaration happened not to name. That raised a CRITICAL
 * AWAITING_USER_APPROVAL blocker on the account owner, and the project's coordinator — the
 * conversation the owner had switched on to make exactly that call — could only relay it back to
 * them. The landing then failed the project's full merge check, and while that owner blocker stood
 * the coordinator's `integration_retry` was refused INTEGRATION_RETRY_OWNER_BLOCKER: the failure
 * could only wait for a person.
 *
 * WHAT EACH CASE SHOWS
 * ====================
 *   (a) a path warning in an Automatic project is the coordinator's exception item, not the
 *       owner's blocker — and the owner's surfaces stay dark;
 *   (b) in an Automatic project too, the two readings about the RULER are still the owner's;
 *   (c) the coordinator decides it, its reason is the record, and no other session may;
 *   (d) sending the task back, cancelling it or replacing it ends the item by itself;
 *   (e) an item nobody acts on reaches the owner at its project's window — it never hangs;
 *   (f) a branch git refused is the coordinator's too, and ends when the work lands;
 *   (g) a failed landing under a path warning is the coordinator's to rerun, with a reason — the
 *       hang above is gone, and the legacy owner blocker still holds it, as a control;
 *   (h) the same failure in a project that is not Automatic is the owner's, and the coordinator is
 *       refused with codes that say so;
 *   (i) an OWNER_CONFIRMED task keeps its owner gate in an Automatic project.
 *
 * Every question is raised by the production path: a task settled through the database's DONE
 * fence, its attempt's reported file set, and the router's own unlanded-criterion door — the edge
 * every task write and receipt runs. Not destructive: every case owns freshly generated ids.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'VERIFICATION';
const PROMOTED_METHOD = 'EXECUTABLE';
const CHECK = {
  completionCriterion: 'EXECUTABLE',
  acceptanceCommand: 'true',
  acceptanceExpectedExitCode: 0,
};

const DECLARED_DIR = 'src/apiserver/src/projects';
const IN_SCOPE = `${DECLARED_DIR}/automatic-coordinator-routing.ts`;
const STRAY = 'src/runner-go/worktree.go';
const DECLARATION = `只改 ${DECLARED_DIR}/ 下面的东西，别碰别的目录。`;
const ARGUMENT = '这条判据的阴性一项对本任务不适用：它测的是另一条路径，本任务没有碰那条路径。';
const ESCALATION_SECONDS = 600;

const sha = (nibble: string) => nibble.repeat(40);

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sql: Client;
  router: CompletionInputRouter;
  tasks: TasksService;
  projects: ProjectsService;
  openItems: ProjectOpenItemService;
  receipts: MergeReceiptService;
  escalation: ProjectOpenItemEscalationService;
  confirmations: TaskOwnerConfirmationService;
}

/** The production wiring over one client, with the item service the disposition hands reviews to. */
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
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const convergence = new CoordinatorConvergenceService(prisma);
  const judgments = new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions);
  const deliveries = new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions);
  const router = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries, openItems),
    new CriterionUnlandedProducer(prisma, convergence),
  );
  const tasks = new TasksService(
    prisma, sessions, realtime, undefined, router, undefined, openItems,
  );
  return {
    db,
    prisma,
    sql,
    router,
    tasks,
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma)),
    openItems,
    receipts: new MergeReceiptService(prisma, router),
    escalation: new ProjectOpenItemEscalationService(prisma),
    confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks),
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
  coordinatorSessionId: string;
}

/** One owner, one runner, one project with a standing coordinator conversation. */
async function fixture(
  stack: Stack,
  label: string,
  options: { automatic?: boolean } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@automatic-routing.invalid`,
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
  // A repository, so a case that needs a project branch of its own can bind one (case (g)).
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}-${projectId}.git`,
      workDir: `/srv/${label}`,
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
      title: `${label} 的项目`,
      coordinatorEnabled: options.automatic ?? true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
      exceptionEscalationSeconds: ESCALATION_SECONDS,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  return { ownerId, runnerId, workspaceId, projectId, coordinatorSessionId };
}

/** State the criteria through the owner's own path, and read the stable keys back. */
async function state(
  stack: Stack,
  f: Fixture,
  texts: string[],
  methods: string[] = texts.map(() => METHOD),
): Promise<string[]> {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text, index) => ({ text, verificationMethod: methods[index] })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems).map((item) => item.key);
}

/** Move one criterion's method up the ladder: its revision advances and its id stays. */
async function moveTheStandard(stack: Stack, f: Fixture, texts: string[], moved: string) {
  const before = await stack.projects.get(f.ownerId, f.projectId);
  const items = criteriaFromDefinitions(before.acceptanceCriteriaItems);
  await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: items.map((item, index) => ({
      id: item.key,
      text: texts[index]!,
      verificationMethod: item.key === moved ? PROMOTED_METHOD : METHOD,
    })),
  } as never);
}

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

/** The attempt that produced the work: its branch, its worktree and the file set it reported. */
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
      isolationStatus: 'worktree',
      finishedAt: new Date(),
      changedFiles: paths.map((path) => ({ path, additions: 1, deletions: 0, status: 'A' })),
    },
  });
  return sessionId;
}

/** One settled delivery, and what the router's unlanded-criterion door answered about it. */
async function deliver(
  stack: Stack,
  f: Fixture,
  taskId: string,
  criterionKey: string,
  label: string,
  paths: readonly string[],
): Promise<{ sessionId: string; spent: CriterionUnlandedDelivery | undefined }> {
  await settle(stack, taskId);
  const sessionId = await attempt(stack, f, taskId, label, paths);
  const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
  const spent = delivered.find(
    (one) => one.criterionSubjectId === criterionSubjectId(f.projectId, criterionKey),
  );
  return { sessionId, spent };
}

/** The turns the coordinator conversation was handed, past the prompt it opened with. */
async function turnsTo(stack: Stack, sessionId: string) {
  return stack.db.conversationTurn.findMany({
    where: {
      sessionId,
      clientTurnId: { not: SessionsService.initialTurnClientId(sessionId) },
    },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  }).then((turns) => turns.map((turn) => ({ ...turn, content: turn.content ?? '' })));
}

const itemsOf = (stack: Stack, projectId: string, kind: string) =>
  stack.db.projectOpenItem.findMany({ where: { projectId, kind }, orderBy: { createdAt: 'asc' } });

async function refusedWith(promise: Promise<unknown>, status: number, code?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const failure = error as { getStatus?: () => number; getResponse?: () => unknown };
    assert.equal(failure.getStatus?.(), status, `refused with the wrong status: ${String(error)}`);
    if (code) {
      const body = failure.getResponse?.() as { code?: string } | undefined;
      assert.equal(body?.code, code, `refused for another reason: ${JSON.stringify(body)}`);
    }
    return true;
  });
}

/**
 * Move an item back in time by `minutes`: it was opened that long ago, and its window started then —
 * every instant it carries, and the delivery that put it on the conversation, moved together.
 */
async function age(stack: Stack, itemId: string, minutes: number): Promise<void> {
  await stack.sql.query(
    `UPDATE "project_open_item"
        SET "waiting_since" = "waiting_since" - make_interval(mins => $2),
            "assigned_at" = "assigned_at" - make_interval(mins => $2),
            "escalate_at" = "escalate_at" - make_interval(mins => $2),
            "created_at" = "created_at" - make_interval(mins => $2)
      WHERE "id" = $1::uuid`,
    [itemId, minutes],
  );
  await stack.sql.query(
    `UPDATE "project_open_item_delivery"
        SET "created_at" = "created_at" - make_interval(mins => $2)
      WHERE "item_id" = $1::uuid`,
    [itemId, minutes],
  );
}

// (a)(c) -------------------------------------------------------------------------------------
test('an Automatic project hands a path warning to its coordinator as a delivery review, never '
  + 'to its owner as a blocker, and the coordinator settles it with its reason on the row',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    const f = await fixture(stack, 'scope');
    const [criterionKey] = await state(stack, f, ['这条标准的活改了没让它改的东西']);
    const taskId = await fileWork(stack, f, criterionKey!, 'scope 的交付：只动 projects 目录', {
      description: DECLARATION,
    });
    const { sessionId, spent } = await deliver(
      stack, f, taskId, criterionKey!, 'scope', [IN_SCOPE, STRAY],
    );

    await t.test('the delivery stops on a review, not on a blocker and not on a merge', async () => {
      assert.equal(spent?.outcome, 'CONSUMED', 'the unlanded fact took the wrong terminal');
      assert.equal(spent?.blockerKind, undefined, 'a path warning still raised a blocker');
      assert.equal(spent?.action, undefined, 'a delivery under review chose a mechanical action');
      assert.equal(spent?.review?.reason, 'OUTSIDE_DECLARED_SCOPE');
      assert.ok(spent?.review?.itemId, 'the review names no item');
      assert.equal(await stack.db.projectBlocker.count({ where: { projectId: f.projectId } }), 0,
        'the owner was handed a blocker for a mechanical path warning');
      assert.equal(await stack.db.projectCoordinatorWake.count({
        where: { projectId: f.projectId, event: 'PROJECT_BLOCKER_RAISED' },
      }), 0, 'the review was relayed to the coordinator as an owner blocker as well');
    });

    const [item] = await itemsOf(stack, f.projectId, 'DELIVERY_REVIEW');

    await t.test('the review is the coordinator’s, with the project’s window and the paths',
      async () => {
        assert.ok(item, 'no delivery review was filed');
        assert.equal(item.id, spent?.review?.itemId);
        assert.equal(item.state, 'OPEN');
        assert.equal(item.assignee, 'COORDINATOR');
        assert.equal(item.assigneeReason, 'DEFAULT');
        assert.equal(item.taskId, taskId);
        assert.equal(item.sessionId, sessionId, 'the review is not about the attempt that delivered');
        assert.equal(item.dedupeKey, `DR:OUTSIDE_DECLARED_SCOPE:${taskId}`);
        assert.equal(item.title, 'Changed files it didn’t declare: scope 的交付：只动 projects 目录');
        assert.equal(
          item.escalateAt!.getTime() - item.waitingSince.getTime(), ESCALATION_SECONDS * 1_000,
          'the review does not wait the project’s own window before it goes to the owner',
        );
        const payload = item.payload as { reason?: string; paths?: string[]; declaredPaths?: string[] };
        assert.equal(payload.reason, 'OUTSIDE_DECLARED_SCOPE');
        assert.deepEqual(payload.paths, [STRAY]);
        assert.deepEqual(payload.declaredPaths, [DECLARED_DIR]);
      });

    await t.test('the coordinator conversation is told, in words that ask for its decision',
      async () => {
        const turns = await turnsTo(stack, f.coordinatorSessionId);
        assert.equal(turns.length, 1, 'the coordinator was not handed exactly one message');
        assert.ok(turns[0]!.clientTurnId?.startsWith(OPEN_ITEM_TURN_PREFIX),
          'the message is not the item’s own delivery');
        const text = turns[0]!.content;
        for (const want of [
          'Changed files it didn’t declare', STRAY, DECLARED_DIR, '机械的范围告警', 'open_item_resolve',
          'task_reopen', 'supersedesTaskId', 'integration_retry', '不要为它 ask_owner',
          'exceptionEscalationSeconds',
        ]) {
          assert.ok(text.includes(want), `the review message does not say ${JSON.stringify(want)}`);
        }
        assert.ok(!text.includes('合并到 main'), 'the review was sent as an order to merge');
        assert.ok(!text.includes('需要账号所有者裁决'), 'the review was worded as the owner’s decision');
        assert.equal(await stack.db.projectOpenItemDelivery.count({
          where: { itemId: item!.id, sessionId: f.coordinatorSessionId, purpose: 'ITEM' },
        }), 1, 'the hand-over was not recorded against the item');
      });

    await t.test('the owner’s surfaces stay dark; the coordinator’s show what it is holding',
      async () => {
        const read = await stack.openItems.list(f.ownerId, f.projectId);
        assert.deepEqual(read.needsYou, [], 'a coordinator review was put in front of the owner');
        const [row] = read.withCoordinator;
        assert.equal(row?.kind, 'DELIVERY_REVIEW');
        assert.deepEqual(row?.facts?.files, [STRAY]);
        assert.equal(row?.facts?.review?.reason, 'OUTSIDE_DECLARED_SCOPE');
        assert.deepEqual(row?.facts?.review?.declaredPaths, [DECLARED_DIR]);
        assert.match(row?.detailLine ?? '', /1 file outside its declaration/);
        assert.ok(row?.actions.includes('OPEN_TASK_SESSION'));
        assert.equal(ownerItemKind(item!), null, 'the review counts as something the owner is asked');

        const attention = (await readProjectListAttention(stack.prisma, f.ownerId)).get(f.projectId);
        assert.equal(attention?.userBlockers ?? 0, 0, 'the project list asks the owner anyway');
        assert.deepEqual(attention?.ownerItems ?? [], []);
        assert.equal(attention?.coordinatorItems?.leadKind, 'DELIVERY_REVIEW');
        assert.equal(attention?.coordinatorItems?.count, 1);
      });

    await t.test('the same fact delivered again asks nothing twice', async () => {
      await stack.router.routeUnlandedCriteria([f.projectId]);
      assert.equal((await itemsOf(stack, f.projectId, 'DELIVERY_REVIEW')).length, 1);
      assert.equal((await turnsTo(stack, f.coordinatorSessionId)).length, 1);
    });

    const judgment = '接受范围：worktree.go 是这份交付注入作业状态必需的一处改动，任务描述要求的正是它。';

    await t.test('a task’s own session may not close it for the coordinator', async () => {
      await refusedWith(
        stack.openItems.resolveOpenItem(f.ownerId, f.projectId, item!.id, { note: judgment }, {
          kind: 'SESSION', sessionId,
        }),
        403,
        OPEN_ITEM_COORDINATOR_ONLY,
      );
      assert.equal((await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item!.id } })).state,
        'OPEN');
    });

    await t.test('the coordinator accepts the scope, and its judgment is the record', async () => {
      await refusedWith(
        stack.openItems.resolveOpenItem(f.ownerId, f.projectId, item!.id, { note: '   ' }, {
          kind: 'SESSION', sessionId: f.coordinatorSessionId,
        }),
        400,
      );
      const resolved = await stack.openItems.resolveOpenItem(
        f.ownerId, f.projectId, item!.id, { note: judgment },
        { kind: 'SESSION', sessionId: f.coordinatorSessionId },
      );
      assert.deepEqual(resolved, { itemId: item!.id, state: 'RESOLVED', resolution: 'HANDLED' });
      const row = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item!.id } });
      assert.equal(row.resolvedBy, 'COORDINATOR');
      assert.equal(row.resolvedBySessionId, f.coordinatorSessionId);
      assert.equal(row.resolvedByUserId, null, 'the coordinator’s judgment was put in the owner’s name');
      assert.equal(row.resolutionNote, judgment);
      // An ending is final, whoever presses next.
      await refusedWith(
        stack.openItems.resolveOpenItem(f.ownerId, f.projectId, item!.id, { note: 'again' }, {
          kind: 'OWNER',
        }),
        409,
      );
    });
  });

// (b) ----------------------------------------------------------------------------------------
test('an argued exemption and a moved standard are the owner’s blockers even in an Automatic '
  + 'project: questions about the ruler are never the coordinator’s to decide',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'ruler');
      const texts = ['这条标准的活声称某条判据不适用', '这条标准的活要通过就得改验收标准'];
      const [exemptionKey, standardKey] = await state(stack, f, texts);
      const exemption = await fileWork(stack, f, exemptionKey!, 'ruler：写了豁免理由的交付', {
        completionCriterionOverrideReason: ARGUMENT,
      });
      const standard = await fileWork(stack, f, standardKey!, 'ruler：开工后标准被改过的交付');
      await moveTheStandard(stack, f, texts, standardKey!);
      // Neither declaration names a path, so no path reading can fire: what stops these two is the
      // ruler, and only the ruler.
      await settle(stack, exemption);
      await attempt(stack, f, exemption, 'ruler-exemption', [IN_SCOPE]);
      await settle(stack, standard);
      await attempt(stack, f, standard, 'ruler-standard', [IN_SCOPE]);
      const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
      const spentFor = (key: string) => delivered.find(
        (one) => one.criterionSubjectId === criterionSubjectId(f.projectId, key),
      );
      assert.equal(spentFor(exemptionKey!)?.blockerKind, 'HUMAN_DECISION_REQUIRED');
      assert.equal(spentFor(standardKey!)?.blockerKind, 'POLICY_MANUAL_HOLD');
      assert.equal(spentFor(exemptionKey!)?.review, undefined);
      assert.equal(spentFor(standardKey!)?.review, undefined);

      const blockers = await stack.db.projectBlocker.findMany({
        where: { projectId: f.projectId, resolvedAt: null },
        select: { owner: true, detail: true },
      });
      assert.deepEqual(
        blockers.map((row) => [(row.detail as { reason?: string }).reason, row.owner]).sort(),
        [['ACCEPTANCE_STANDARD_MOVED', 'USER'], ['CRITERION_EXEMPTION_ARGUED', 'USER']],
        'a question about the ruler was not put to the owner',
      );
      assert.equal((await itemsOf(stack, f.projectId, 'DELIVERY_REVIEW')).length, 0,
        'a question about the ruler was handed to the coordinator to decide');
      // The coordinator is TOLD — it is the conversation the owner switched on — but what it is told
      // is that the owner decides, and it is handed no item it could close itself.
      const turns = await turnsTo(stack, f.coordinatorSessionId);
      assert.ok(turns.length > 0, 'the coordinator was not told that its project is waiting on the owner');
      for (const turn of turns) {
        assert.ok(!turn.clientTurnId?.startsWith(OPEN_ITEM_TURN_PREFIX),
          'the coordinator was handed an exception item about the ruler');
        assert.ok(turn.content.includes('需要账号所有者裁决'),
          'the coordinator was told about the ruler as something other than the owner’s decision');
      }
    } finally {
      await disconnect(stack);
    }
  });

// (d)(e) -------------------------------------------------------------------------------------
test('a review ends when its task is sent back, cancelled or replaced, and one nobody acts on '
  + 'reaches the owner at the project’s window instead of hanging',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    const f = await fixture(stack, 'endings');
    const [returnKey, cancelKey, replaceKey, silentKey] = await state(stack, f, [
      '这条标准的活被退回', '这条标准的活被取消', '这条标准的活被取代', '这条标准的活没人管',
    ]);
    const returned = await fileWork(stack, f, returnKey!, 'endings：会被退回的交付', { description: DECLARATION });
    const cancelled = await fileWork(stack, f, cancelKey!, 'endings：会被取消的交付', { description: DECLARATION });
    const replaced = await fileWork(stack, f, replaceKey!, 'endings：会被取代的交付', { description: DECLARATION });
    const silent = await fileWork(stack, f, silentKey!, 'endings：没人管的交付', { description: DECLARATION });
    for (const [taskId, key, label] of [
      [returned, returnKey!, 'endings-returned'],
      [cancelled, cancelKey!, 'endings-cancelled'],
      [replaced, replaceKey!, 'endings-replaced'],
      [silent, silentKey!, 'endings-silent'],
    ] as const) {
      const { spent } = await deliver(stack, f, taskId, key, label, [IN_SCOPE, STRAY]);
      assert.equal(spent?.review?.reason, 'OUTSIDE_DECLARED_SCOPE', `${label}: no review was filed`);
    }
    const reviewOf = async (taskId: string) => (await stack.db.projectOpenItem.findMany({
      where: { projectId: f.projectId, kind: 'DELIVERY_REVIEW', taskId },
    }))[0]!;

    await t.test('sending the task back answers its review', async () => {
      // What `task_reopen` sends: the status write with any retirement cleared in the same request.
      await stack.tasks.update(f.ownerId, returned, {
        status: 'OPEN', supersededByTaskId: null, terminalReason: null,
      } as never);
      const row = await reviewOf(returned);
      assert.equal(row.state, 'RESOLVED');
      assert.equal(row.resolution, 'RETRIED');
      assert.equal(row.resolvedBy, 'PLATFORM');
    });

    await t.test('cancelling the task answers its review', async () => {
      await stack.tasks.update(f.ownerId, cancelled, { status: 'CANCELLED' } as never);
      const row = await reviewOf(cancelled);
      assert.equal(row.state, 'RESOLVED');
      assert.equal(row.resolution, 'TASK_CLOSED');
      assert.equal(row.resolvedBy, 'PLATFORM');
    });

    await t.test('replacing the task — cancel, then a successor — answers its review', async () => {
      await stack.tasks.update(f.ownerId, replaced, { status: 'CANCELLED' } as never);
      const successor = await fileWork(stack, f, replaceKey!, 'endings：取代它的交付', {
        description: `${DECLARATION} 还要改 ${STRAY}。`,
        supersedesTaskId: replaced,
      });
      const before = await stack.db.task.findUniqueOrThrow({ where: { id: replaced } });
      assert.equal(before.supersededByTaskId, successor, 'the successor was not recorded');
      const row = await reviewOf(replaced);
      assert.equal(row.state, 'RESOLVED');
      assert.ok(['TASK_CLOSED', 'SUCCESSOR_FILED'].includes(row.resolution ?? ''),
        `the replaced task's review ended as ${row.resolution}`);
      assert.equal(row.resolvedBy, 'PLATFORM');
    });

    await t.test('a review nobody acts on goes to the owner when its window runs out', async () => {
      const before = await reviewOf(silent);
      assert.equal(before.state, 'OPEN');
      // Not yet: the window is ten minutes, and nothing has moved the clock.
      assert.deepEqual((await stack.escalation.sweep()).filter((one) => one.itemId === before.id), []);
      await age(stack, before.id, 20);
      const escalated = await stack.escalation.sweep();
      assert.ok(escalated.some((one) => one.itemId === before.id), 'the silent review did not escalate');
      const after = await reviewOf(silent);
      assert.equal(after.state, 'OPEN');
      assert.equal(after.assignee, 'OWNER');
      assert.equal(after.assigneeReason, 'ESCALATED');
      assert.equal(ownerItemKind(after), 'ESCALATED');
      const read = await stack.openItems.list(f.ownerId, f.projectId);
      assert.deepEqual(read.needsYou.map((row) => row.itemId), [before.id]);
      // Escalated, it is the owner's: the coordinator's press is refused, the owner's is not.
      await refusedWith(
        stack.openItems.resolveOpenItem(f.ownerId, f.projectId, before.id, { note: 'mine' }, {
          kind: 'SESSION', sessionId: f.coordinatorSessionId,
        }),
        409,
        OPEN_ITEM_NOT_COORDINATOR_ITEM,
      );
      const closed = await stack.openItems.resolveOpenItem(
        f.ownerId, f.projectId, before.id, { note: '我看过了，这些改动是对的。' }, { kind: 'OWNER' },
      );
      assert.equal(closed.resolution, 'HANDLED');
    });
  });

// (f) ----------------------------------------------------------------------------------------
test('a branch git refused is the coordinator’s review too, and it ends when the work lands',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'refused');
      const [criterionKey] = await state(stack, f, ['这条标准的活合不进去']);
      const taskId = await fileWork(stack, f, criterionKey!, 'refused：合不进去的交付');
      const sessionId = await attempt(stack, f, taskId, 'refused', [IN_SCOPE]);
      // Recorded while the task is still running, the way a runner's merge of the session's branch
      // reports it — so the fact this is read from is derived by the DONE below, once.
      const conflict = await stack.receipts.record(f.ownerId, sessionId, {
        sourceSha: sha('a'),
        targetShaBefore: sha('b'),
        targetBranch: 'main',
        result: 'CONFLICT',
        conflicts: [IN_SCOPE],
      } as never, 'AGENT');
      assert.equal(conflict.created, true);
      await settle(stack, taskId);
      const delivered = await stack.router.routeUnlandedCriteria([f.projectId]);
      const spent = delivered.find(
        (one) => one.criterionSubjectId === criterionSubjectId(f.projectId, criterionKey!),
      );
      assert.equal(spent?.review?.reason, 'MERGE_REFUSED_BY_GIT');
      assert.equal(spent?.blockerKind, undefined);
      assert.equal(await stack.db.projectBlocker.count({ where: { projectId: f.projectId } }), 0);
      const [item] = await itemsOf(stack, f.projectId, 'DELIVERY_REVIEW');
      assert.equal(item?.assignee, 'COORDINATOR');
      assert.equal(item?.dedupeKey, `DR:MERGE_REFUSED_BY_GIT:${taskId}`);
      assert.deepEqual((item?.payload as { paths?: string[] }).paths, [IN_SCOPE]);
      const [turn] = await turnsTo(stack, f.coordinatorSessionId);
      for (const want of ['Git refused to merge it', 'git 拒绝了合并', IN_SCOPE, 'task_reopen',
        'merge_receipt', '不要原样重跑']) {
        assert.ok(turn?.content.includes(want), `the refused-merge message does not say ${want}`);
      }

      // The coordinator untangles it and merges by hand; the receipt is what ends the question.
      await stack.receipts.record(f.ownerId, sessionId, {
        sourceSha: sha('a'),
        targetShaBefore: sha('b'),
        targetBranch: 'main',
        result: 'MERGED',
        targetShaAfter: sha('c'),
      } as never, 'AGENT');
      const after = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: item!.id } });
      assert.equal(after.state, 'RESOLVED');
      assert.equal(after.resolution, 'LANDED');
      assert.equal(after.resolvedBy, 'PLATFORM');
      assert.equal(after.resolutionNote, 'the work landed on main');
    } finally {
      await disconnect(stack);
    }
  });

/** The project's own integration line, bound the way the owner's settings bind it (§1.2). */
async function projectBranch(stack: Stack, f: Fixture): Promise<string> {
  await stack.db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId: f.ownerId,
    projectId: f.projectId,
    settings: { line: 'PROJECT_BRANCH' },
  }));
  const codebase = await stack.db.projectCodebase.findFirstOrThrow({
    where: { projectId: f.projectId, slot: 'primary' },
    select: { id: true, integrationRef: true, upstreamRef: true },
  });
  assert.notEqual(codebase.integrationRef, codebase.upstreamRef, 'the project has no branch of its own');
  return codebase.id;
}

/** A finished landing generation of the task, the way the result route leaves a red merge check. */
async function failedLandingJob(
  stack: Stack,
  f: Fixture,
  row: { codebaseId: string; taskId: string; sessionId: string; generation: number; label: string },
): Promise<string> {
  const codebase = await stack.db.projectCodebase.findUniqueOrThrow({ where: { id: row.codebaseId } });
  const jobId = randomUUID();
  await stack.db.projectIntegrationJob.create({
    data: {
      id: jobId,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: row.codebaseId,
      kind: 'LAND_TASK',
      generation: row.generation,
      taskId: row.taskId,
      sessionId: row.sessionId,
      serialKey: `${codebase.canonicalRepoUrl}#${codebase.integrationRef}`,
      targetRef: codebase.integrationRef,
      upstreamRef: codebase.upstreamRef,
      sourceRef: `refs/heads/orbit/${row.label}`,
      state: 'CHECK_FAILED',
      phase: 'CHECK',
      checks: [{
        name: 'MERGE_CHECK',
        command: 'go test ./...',
        expectedExitCode: 0,
        exitCode: 1,
        timedOut: false,
        durationMs: 1_609_148,
        outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel (1.47s)',
      }],
      finishedAt: new Date(),
      idempotencyKey: `ij:v1:LAND_TASK:${row.taskId}:${row.generation}`,
    },
  });
  return jobId;
}

/** The item a red MERGE_CHECK opens, through the function the job's result transaction calls. */
async function openCheckFailure(
  stack: Stack,
  f: Fixture,
  row: { taskId: string; sessionId: string; jobId: string; title: string },
): Promise<string> {
  const opened = await recordIntegrationFailure(stack.db as unknown as Prisma.TransactionClient, {
    projectId: f.projectId,
    ownerId: f.ownerId,
    jobId: row.jobId,
    taskId: row.taskId,
    sessionId: row.sessionId,
    state: 'CHECK_FAILED',
    title: integrationItemTitle('CHECK_FAILED', 'LAND_TASK', row.title),
    dedupeKey: integrationDedupeKey('CHECK_FAILED', row.jobId),
    payload: {
      jobKind: 'LAND_TASK',
      check: {
        name: 'MERGE_CHECK',
        command: 'go test ./...',
        exitCode: 1,
        expectedExitCode: 0,
        timedOut: false,
        durationMs: 1_609_148,
        outputTail: '--- FAIL: TestRealClaudeAcceptsASetModel (1.47s)',
      },
      branchUnchanged: true,
      failureClass: 'CHECK_FAILED',
      generation: 1,
    },
  });
  assert.ok(opened, 'the failed landing opened no item');
  return opened.itemId;
}

/** One finished delivery outside its declaration whose landing then failed the merge check. */
async function scopedFailedLanding(stack: Stack, f: Fixture, label: string, criterionKey: string) {
  const codebaseId = await projectBranch(stack, f);
  const title = `${label}：改了声明外文件、落地检查又没过的交付`;
  const taskId = await fileWork(stack, f, criterionKey, title, { description: DECLARATION });
  const { sessionId, spent } = await deliver(stack, f, taskId, criterionKey, label, [IN_SCOPE, STRAY]);
  const jobId = await failedLandingJob(stack, f, { codebaseId, taskId, sessionId, generation: 1, label });
  const itemId = await openCheckFailure(stack, f, { taskId, sessionId, jobId, title });
  return { taskId, sessionId, spent, jobId, itemId };
}

// (g) ----------------------------------------------------------------------------------------
test('a failed landing under a path warning is the coordinator’s to rerun with a reason: the '
  + 'warning no longer parks it behind the owner, and the platform reruns nothing by itself',
  { skip, timeout: 300_000 }, async (t) => {
    const stack = await connect();
    t.after(() => disconnect(stack));

    const f = await fixture(stack, 'rerun');
    const [criterionKey] = await state(stack, f, ['rerun 的那条标准']);
    const landing = await scopedFailedLanding(stack, f, 'rerun', criterionKey!);
    const reason = 'MERGE_CHECK 红在 TestRealClaude*：主干上同样红，是引擎版本漂移，修复任务已落地。';

    await t.test('both questions are the coordinator’s, and none is the owner’s', async () => {
      assert.equal(landing.spent?.review?.reason, 'OUTSIDE_DECLARED_SCOPE');
      assert.equal(await stack.db.projectBlocker.count({
        where: { projectId: f.projectId, owner: 'USER', resolvedAt: null },
      }), 0, 'the path warning still parked the task behind an owner blocker');
      const read = await stack.openItems.list(f.ownerId, f.projectId);
      assert.deepEqual(read.needsYou, []);
      assert.deepEqual(read.withCoordinator.map((row) => row.kind).sort(),
        ['DELIVERY_REVIEW', 'INTEGRATION_CHECK_FAILED']);
      // The platform queued nothing on its own: one generation, the failed one.
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: landing.taskId } }), 1);
    });

    await t.test('nobody but the coordinator conversation may ask, and never without a reason',
      async () => {
        await refusedWith(
          stack.openItems.retryIntegration(
            f.ownerId, f.projectId, landing.taskId, { reason }, landing.sessionId,
          ),
          403,
          INTEGRATION_RETRY_COORDINATOR_ONLY,
        );
        await refusedWith(
          stack.openItems.retryIntegration(
            f.ownerId, f.projectId, landing.taskId, { reason: '  ' }, f.coordinatorSessionId,
          ),
          400,
          INTEGRATION_RETRY_REASON_REQUIRED,
        );
        assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId: landing.taskId } }), 1,
          'a refused rerun queued a landing anyway');
      });

    await t.test('the legacy owner blocker is what used to hold it: with one open, the rerun is refused',
      async () => {
        // The control: the row the old routing raised for this very delivery. With it open the
        // coordinator is refused — exactly the hang of 2026-10-01 — so the green case below is green
        // because the warning became a review, not because the door stopped asking.
        const legacy = randomUUID();
        await stack.sql.query(
          `INSERT INTO "project_blocker" (
             "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
             "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
             "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at", "updated_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'AWAITING_USER_APPROVAL', 'USER', 'HUMAN', 'CRITICAL', 'decide',
             now(), 'TASK', $3, $4::jsonb, $5, 1, $6, now(), now(), now()
           )`,
          [
            legacy, f.projectId, landing.taskId,
            JSON.stringify({ reason: 'OUTSIDE_DECLARED_SCOPE', paths: [STRAY] }),
            `AWAITING_USER_APPROVAL:OUTSIDE_DECLARED_SCOPE:${landing.taskId}`, 'c'.repeat(64),
          ],
        );
        await refusedWith(
          stack.openItems.retryIntegration(
            f.ownerId, f.projectId, landing.taskId, { reason }, f.coordinatorSessionId,
          ),
          409,
          INTEGRATION_RETRY_OWNER_BLOCKER,
        );
        await stack.sql.query(
          `UPDATE "project_blocker" SET "resolved_at" = now(), "resolved_by" = 'USER',
                  "resolution_note" = 'the control is over', "updated_at" = now()
            WHERE "id" = $1::uuid`,
          [legacy],
        );
      });

    await t.test('the coordinator reruns it: the next generation is queued and the item carries why',
      async () => {
        const rerun = await stack.openItems.retryIntegration(
          f.ownerId, f.projectId, landing.taskId, { reason }, f.coordinatorSessionId,
        );
        assert.equal(rerun.generation, 2);
        assert.equal(rerun.retryOfJobId, landing.jobId);
        assert.equal(rerun.failureClass, 'CHECK_FAILED');
        assert.deepEqual(rerun.supersededItemIds, [landing.itemId]);
        const job = await stack.db.projectIntegrationJob.findUniqueOrThrow({ where: { id: rerun.jobId } });
        assert.equal(job.kind, 'LAND_TASK');
        assert.equal(job.state, 'QUEUED');
        assert.equal(job.retryReason, reason);
        assert.equal(job.retryRequestedBySessionId, f.coordinatorSessionId);
        const item = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: landing.itemId } });
        assert.equal(item.state, 'SUPERSEDED');
        assert.equal(item.resolution, 'RETRIED');
        assert.equal(item.resolvedBy, 'COORDINATOR');
        assert.equal(item.resolvedBySessionId, f.coordinatorSessionId);
        assert.equal(item.resolutionNote, reason);
        // A rerun says nothing about whether the files outside the declaration belong to the work:
        // the review is still the coordinator's to decide.
        const [review] = await itemsOf(stack, f.projectId, 'DELIVERY_REVIEW');
        assert.equal(review?.state, 'OPEN');
        assert.equal(review?.assignee, 'COORDINATOR');
      });
  });

// (h) ----------------------------------------------------------------------------------------
test('in a project that is not Automatic the failed landing is the owner’s, the coordinator is '
  + 'refused with codes that say so, and a path warning reaches nobody',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'manual', { automatic: false });
      const [landingKey] = await state(stack, f, ['manual 的那条标准']);
      const codebaseId = await projectBranch(stack, f);
      const title = 'manual：落地检查没过的交付';
      const taskId = await fileWork(stack, f, landingKey!, title, { description: DECLARATION });
      // A delivery outside its declaration reaches nobody automatically: the switch refuses the
      // fact before any question is asked.
      const { sessionId, spent } = await deliver(stack, f, taskId, landingKey!, 'manual', [IN_SCOPE, STRAY]);
      assert.equal(spent?.outcome, 'REFUSED');
      assert.equal(spent?.review, undefined);
      assert.equal(spent?.blockerKind, undefined);
      assert.equal((await itemsOf(stack, f.projectId, 'DELIVERY_REVIEW')).length, 0);
      assert.equal(await stack.db.projectBlocker.count({ where: { projectId: f.projectId } }), 0);

      const jobId = await failedLandingJob(stack, f, { codebaseId, taskId, sessionId, generation: 1, label: 'manual' });
      const itemId = await openCheckFailure(stack, f, { taskId, sessionId, jobId, title });
      const item = await stack.db.projectOpenItem.findUniqueOrThrow({ where: { id: itemId } });
      assert.equal(item.assignee, 'OWNER');
      assert.equal(item.assigneeReason, 'NO_COORDINATOR');
      assert.equal(item.escalateAt, null, 'an item that is the owner’s from birth has a clock');
      await refusedWith(
        stack.openItems.retryIntegration(f.ownerId, f.projectId, taskId, { reason: 'x' }, f.coordinatorSessionId),
        409,
        INTEGRATION_RETRY_OWNER_ITEM,
      );
      await refusedWith(
        stack.openItems.resolveOpenItem(f.ownerId, f.projectId, itemId, { note: 'x' }, {
          kind: 'SESSION', sessionId: f.coordinatorSessionId,
        }),
        409,
        OPEN_ITEM_NOT_COORDINATOR_ITEM,
      );
      assert.equal(await stack.db.projectIntegrationJob.count({ where: { taskId } }), 1,
        'a refused rerun queued a landing anyway');
      assert.deepEqual(await turnsTo(stack, f.coordinatorSessionId), [],
        'a switched-off coordinator was handed something about a landing');
    } finally {
      await disconnect(stack);
    }
  });

// (i) ----------------------------------------------------------------------------------------
test('an OWNER_CONFIRMED task keeps its owner gate in an Automatic project: the coordinator '
  + 'cannot confirm it for the owner, through either door',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'owner-gate');
      const [criterionKey] = await state(
        stack, f, ['上线由账号所有者在 app 里确认'], ['OWNER_CONFIRMED: the owner checks it on their phone'],
      );
      const created = await stack.tasks.create(f.ownerId, {
        title: 'owner-gate：上线',
        projectId: f.projectId,
        criterionKey,
        completionCriterion: 'OWNER_CONFIRMED',
      } as never);
      for (const door of ['USER', 'RUNNER'] as const) {
        await refusedWith(
          stack.confirmations.decide(
            f.ownerId,
            created.id,
            { door, userId: f.ownerId, actingSessionId: f.coordinatorSessionId },
            { decision: 'CONFIRM' } as never,
          ),
          403,
        );
      }
      const task = await stack.db.task.findUniqueOrThrow({ where: { id: created.id } });
      assert.equal(task.status, 'OPEN', 'a coordinator session settled an OWNER_CONFIRMED task');
      assert.equal(task.completionCriterion, 'OWNER_CONFIRMED');
    } finally {
      await disconnect(stack);
    }
  });
