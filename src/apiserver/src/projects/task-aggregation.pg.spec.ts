import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunnerStatus,
  TaskCompletionPolicy,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  createDecisionId,
  planProjectDecision,
  ProjectDecisionOutcome,
  ProjectDecisionService,
} from './project-decision.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService } from './project-reconcile.service';
import { prismaClientFor } from '../prisma/prisma-client';

const URL = process.env.COORDINATOR_PG_URL;

/**
 * Parent aggregation against a real, fully migrated PostgreSQL (contract AC7 / §13.1).
 *
 * Everything here goes through the production path — the outbox trigger that fires on the task
 * write, the delivery transaction, the lease, the decision snapshot and the compare-and-set — for
 * the reason the unit spec beside this one cannot: the properties under test are about duplicated
 * signals, concurrent writers and a process that stops halfway, and none of those exist in a pure
 * function. The writes it makes are destructive, so it refuses to run anywhere but an isolated
 * disposable server (see coordinator-pg-test-safety).
 */

interface Tree {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  ids: Record<string, string>;
}

interface TaskSpec {
  status?: TaskStatus;
  parent?: string;
  policy?: TaskCompletionPolicy;
  verifies?: string;
  verdict?: TaskVerdict;
}

/**
 * One project and the tasks named in `spec`, created in declaration order so a parent always
 * exists before the child that names it.
 */
async function tree(
  db: PrismaClient,
  label: string,
  spec: Record<string, TaskSpec>,
  options: { coordinatorEnabled?: boolean } = {},
): Promise<Tree> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc15.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: label,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      automationPolicy: ProjectAutomationPolicy.AUTO,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.projectMember.create({
    data: { projectId, agentId: workspaceId, role: ProjectRole.COORDINATOR },
  });

  const ids: Record<string, string> = {};
  for (const name of Object.keys(spec)) ids[name] = randomUUID();
  for (const [name, one] of Object.entries(spec)) {
    await db.task.create({
      data: {
        id: ids[name],
        ownerId,
        projectId,
        title: `${label}-${name}`,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        status: one.status ?? TaskStatus.OPEN,
        parentTaskId: one.parent ? ids[one.parent] : null,
        completionPolicy: one.policy ?? TaskCompletionPolicy.MANUAL,
        verifiesTaskId: one.verifies ? ids[one.verifies] : null,
        verdict: one.verdict ?? null,
      },
    });
  }
  return { ownerId, projectId, workspaceId, ids };
}

/**
 * An empty world before each spec.
 *
 * `drainOnce` picks whichever Project has the oldest pending signal, so a row left behind by an
 * earlier run makes these assertions depend on what happened before them. Truncating is safe only
 * because the identity probe above has already proved this is the disposable server.
 */
async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "project_event", "project_decision", "project_action", "project_runtime",
             "project_member", "task", "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

/** Every pending signal, delivered, until nothing is left. Returns how many passes that took. */
async function settle(events: ProjectEventsService, limit = 60): Promise<number> {
  for (let pass = 0; pass < limit; pass += 1) {
    const result = await events.drainOnce();
    assert.notEqual(result.status, 'DEAD', 'a delivery died instead of reconciling');
    assert.notEqual(result.status, 'RETRY_SCHEDULED', 'a delivery failed and was rescheduled');
    if (result.status === 'IDLE' || result.status === 'NO_HANDLER') return pass;
    if (result.status === 'DEFERRED') return pass;
  }
  assert.fail(`aggregation did not converge within ${limit} delivery passes`);
}

async function statuses(db: PrismaClient, target: Tree): Promise<Record<string, string>> {
  const rows = await db.task.findMany({
    where: { projectId: target.projectId },
    select: { id: true, status: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row.status as string]));
  return Object.fromEntries(Object.entries(target.ids).map(([name, id]) => [name, byId.get(id)!]));
}

/** The aggregations this Project's decisions actually recorded, oldest first. */
async function auditedAggregations(
  db: PrismaClient,
  target: Tree,
): Promise<ProjectDecisionOutcome['aggregations']> {
  const decisions = await db.projectDecision.findMany({
    where: { projectId: target.projectId },
    orderBy: { createdAt: 'asc' },
    select: { outcome: true },
  });
  return decisions.flatMap((decision) =>
    (decision.outcome as unknown as ProjectDecisionOutcome).aggregations ?? []);
}

test('parent aggregation converges on PostgreSQL', { skip: !URL, timeout: 180_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);
  const migrated = await identity.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM "_prisma_migrations"
     WHERE "migration_name" = '0123_task_completion_policy' AND "finished_at" IS NOT NULL
  `);
  assert.equal(migrated.rows[0]?.count, '1', 'the isolated database must have migration 0123');
  await emptyWorld(identity);

  const db = prismaClientFor(URL);
  const prisma = db as unknown as PrismaService;
  const events = new ProjectEventsService(prisma);
  const decisions = new ProjectDecisionService(prisma);
  const reconciler = new ProjectReconcileService(prisma, events, decisions);
  let unregister = events.registerHandler(reconciler);

  try {
    // ---- compatibility -------------------------------------------------------------------------
    await t.test('MANUAL leaves a parent alone however finished its children are', async () => {
      const target = await tree(db, 'manual', {
        p: {},
        a: { parent: 'p', status: TaskStatus.DONE },
        b: { parent: 'p', status: TaskStatus.DONE },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');
      assert.deepEqual(await auditedAggregations(db, target), []);
    });

    await t.test('a Project outside the control loop never aggregates', async () => {
      const target = await tree(db, 'legacy', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p', status: TaskStatus.DONE },
      }, { coordinatorEnabled: false });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');
      assert.deepEqual(await auditedAggregations(db, target), []);
    });

    await t.test('AG4: a childless task is never completed by its own policy', async () => {
      const target = await tree(db, 'empty', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        q: { policy: TaskCompletionPolicy.VERIFICATION_PASSED },
        v: { verifies: 'q', status: TaskStatus.DONE, verdict: TaskVerdict.PASS },
      });
      await settle(events);
      const now = await statuses(db, target);
      assert.equal(now.p, 'OPEN');
      assert.equal(now.q, 'OPEN');
      assert.deepEqual(await auditedAggregations(db, target), []);
    });

    // ---- ALL_CHILDREN_DONE ----------------------------------------------------------------------
    await t.test('a child finishing completes the parent through the outbox', async () => {
      const target = await tree(db, 'complete', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p' },
        b: { parent: 'p' },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');

      await db.task.update({ where: { id: target.ids.a }, data: { status: TaskStatus.DONE } });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN', 'one outstanding child still holds it');

      await db.task.update({ where: { id: target.ids.b }, data: { status: TaskStatus.CANCELLED } });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'DONE');

      const audited = await auditedAggregations(db, target);
      assert.equal(audited.length, 1);
      assert.deepEqual(audited[0], {
        taskId: uuidToBase62(target.ids.p),
        from: 'OPEN',
        to: 'DONE',
        policy: 'ALL_CHILDREN_DONE',
        reason: 'ALL_CHILDREN_DONE',
        evidence: {
          children: { total: 2, done: 1, cancelled: 1, outstanding: 0 },
          verifications: { total: 0, passed: 0, outstanding: 0 },
        },
      });
      assert.equal(base62ToUuid(audited[0].taskId), target.ids.p);
    });

    await t.test('a failed child holds the parent open', async () => {
      const target = await tree(db, 'failed', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p', status: TaskStatus.DONE },
        b: { parent: 'p', status: TaskStatus.FAILED },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');
      assert.deepEqual(await auditedAggregations(db, target), []);
    });

    await t.test('AG5: aggregation claims no action-ledger row', async () => {
      const target = await tree(db, 'noledger', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p', status: TaskStatus.DONE },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'DONE');
      assert.equal(await db.projectAction.count({ where: { projectId: target.projectId } }), 0);
    });

    // ---- AG3: reopen ------------------------------------------------------------------------------
    await t.test('AG3: reopening a child pulls the parent back, and finishing it again re-completes',
      async () => {
        const target = await tree(db, 'reopen', {
          p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          a: { parent: 'p', status: TaskStatus.DONE },
        });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'DONE');

        await db.task.update({ where: { id: target.ids.a }, data: { status: TaskStatus.OPEN } });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'OPEN');

        // The third pass is the one a permanent idempotency key would have swallowed: the world is
        // byte-identical to the first, so a ledger keyed on the child digest would call it done
        // already and strand the parent OPEN (PC-CX-17).
        await db.task.update({ where: { id: target.ids.a }, data: { status: TaskStatus.DONE } });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'DONE');

        assert.deepEqual(
          (await auditedAggregations(db, target)).map((one) => `${one.from}->${one.to}`),
          ['OPEN->DONE', 'DONE->OPEN', 'OPEN->DONE'],
        );
      });

    await t.test('a new subtask reopens the parent it is filed under', async () => {
      const target = await tree(db, 'newchild', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p', status: TaskStatus.DONE },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'DONE');

      const fresh = randomUUID();
      await db.task.create({
        data: {
          id: fresh,
          ownerId: target.ownerId,
          projectId: target.projectId,
          title: 'newchild-late',
          creatorType: CreatorType.USER,
          creatorId: target.ownerId,
          parentTaskId: target.ids.p,
        },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');
    });

    await t.test('cancelling a parent stops aggregation from resurrecting it', async () => {
      const target = await tree(db, 'cancelled', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE, status: TaskStatus.CANCELLED },
        a: { parent: 'p', status: TaskStatus.DONE },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'CANCELLED');
    });

    // ---- AG2: multi-level --------------------------------------------------------------------------
    await t.test('AG2: three levels settle in one delivery pass', async () => {
      const target = await tree(db, 'deep', {
        gp: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        p: { parent: 'gp', policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        leaf: { parent: 'p' },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).gp, 'OPEN');

      const before = await db.projectDecision.count({ where: { projectId: target.projectId } });
      await db.task.update({ where: { id: target.ids.leaf }, data: { status: TaskStatus.DONE } });
      await events.drainOnce();
      const now = await statuses(db, target);
      assert.equal(now.p, 'DONE');
      assert.equal(now.gp, 'DONE', 'the grandparent must not need a second pass');
      assert.equal(
        await db.projectDecision.count({ where: { projectId: target.projectId } }),
        before + 1,
        'one delivery, one decision',
      );
      await settle(events);
      assert.deepEqual(await statuses(db, target), { gp: 'DONE', p: 'DONE', leaf: 'DONE' });
    });

    await t.test('AG2: a reopened leaf unwinds the whole chain', async () => {
      const target = await tree(db, 'unwind', {
        gp: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        p: { parent: 'gp', policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        leaf: { parent: 'p', status: TaskStatus.DONE },
      });
      await settle(events);
      assert.deepEqual(await statuses(db, target), { gp: 'DONE', p: 'DONE', leaf: 'DONE' });

      await db.task.update({ where: { id: target.ids.leaf }, data: { status: TaskStatus.FAILED } });
      await settle(events);
      assert.deepEqual(await statuses(db, target), { gp: 'OPEN', p: 'OPEN', leaf: 'FAILED' });
    });

    // ---- VERIFICATION_PASSED ------------------------------------------------------------------------
    await t.test('VERIFICATION_PASSED waits for a PASS and reopens when it is revoked', async () => {
      const target = await tree(db, 'verified', {
        p: { policy: TaskCompletionPolicy.VERIFICATION_PASSED },
        a: { parent: 'p', status: TaskStatus.DONE },
        v: { verifies: 'p' },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN', 'children alone are not enough');

      // A verification that merely finished is not a pass. This is the case that decides whether
      // the policy means anything: DONE is the verifier reporting it ran.
      await db.task.update({ where: { id: target.ids.v }, data: { status: TaskStatus.DONE } });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');

      await db.task.update({ where: { id: target.ids.v }, data: { verdict: TaskVerdict.PASS } });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'DONE');

      await db.task.update({ where: { id: target.ids.v }, data: { verdict: null } });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN', 'a revoked verdict reopens the subject');

      await db.task.update({ where: { id: target.ids.v }, data: { verdict: TaskVerdict.FAIL } });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'OPEN');

      const audited = await auditedAggregations(db, target);
      assert.deepEqual(audited.map((one) => `${one.from}->${one.to}:${one.reason}`), [
        'OPEN->DONE:VERIFICATION_PASSED',
        'DONE->OPEN:VERIFICATION_OUTSTANDING',
      ]);
    });

    await t.test('a verdict cannot be recorded on a task that verifies nothing', async () => {
      const target = await tree(db, 'verdictguard', { p: {} });
      await assert.rejects(
        db.$executeRawUnsafe(
          `UPDATE "task" SET "verdict" = 'PASS' WHERE "id" = '${target.ids.p}'::uuid`,
        ),
        /task_verdict_requires_subject/,
      );
    });

    // ---- duplicate, out-of-order, concurrent, restarted --------------------------------------------
    await t.test('duplicated and out-of-order signals converge to one answer', async () => {
      const target = await tree(db, 'dupes', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p', status: TaskStatus.DONE },
      });
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'DONE');
      const afterFirst = await auditedAggregations(db, target);
      assert.equal(afterFirst.length, 1);

      // Replay the same fact five times, including one envelope that describes a transition the
      // world has already moved past. A recomputation reads the row, not the payload.
      for (let repeat = 0; repeat < 5; repeat += 1) {
        await db.$executeRawUnsafe(`
          SELECT "project_event_enqueue_signal"(
            '${target.projectId}'::uuid, 'task.status_changed', 'TASK', '${target.ids.a}'::uuid,
            '{"from":"OPEN","to":"DONE","stale":true}'::jsonb, 'replay:${repeat}'
          )
        `);
      }
      await settle(events);
      assert.equal((await statuses(db, target)).p, 'DONE');
      assert.deepEqual(await auditedAggregations(db, target), afterFirst,
        'replayed signals must not produce a second aggregation');
    });

    await t.test('two children completing concurrently complete the parent exactly once', async () => {
      const target = await tree(db, 'concurrent', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p' },
        b: { parent: 'p' },
      });
      await settle(events);

      const writers = [target.ids.a, target.ids.b].map((id) => db.$transaction(async (tx) => {
        await tx.task.update({ where: { id }, data: { status: TaskStatus.DONE } });
      }));
      await Promise.all(writers);

      // Two deliveries racing the same Project: the outbox takes the row FOR NO KEY UPDATE with
      // SKIP LOCKED, so the loser does no work rather than duplicating the winner's.
      await Promise.all([events.drainOnce(), events.drainOnce()]);
      await settle(events);

      assert.equal((await statuses(db, target)).p, 'DONE');
      assert.equal((await auditedAggregations(db, target)).length, 1);
    });

    await t.test('a stale plan matches zero rows and overwrites nothing', async () => {
      const target = await tree(db, 'stale', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p', status: TaskStatus.DONE },
      });
      // Plan against a world where the parent is OPEN...
      const decisionId = createDecisionId();
      const captured = await db.$transaction((tx) => decisions.capture(tx, target.projectId),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      const outcome = planProjectDecision(captured.input, { decisionId });
      assert.deepEqual(outcome.aggregations.map((one) => `${one.from}->${one.to}`), ['OPEN->DONE']);

      // ...then let somebody else move it before the plan lands.
      await db.task.update({
        where: { id: target.ids.p },
        data: { status: TaskStatus.CANCELLED },
      });
      const applied = await db.$transaction((tx) =>
        reconciler.applyAggregations(tx, target.projectId, outcome.aggregations, new Date()));
      assert.equal(applied, 0, 'the compare-and-set must not match a row that moved');
      assert.equal((await statuses(db, target)).p, 'CANCELLED');

      // Re-planning against the new truth is the recovery path, and it agrees: a cancelled parent
      // is nobody's to complete.
      const replanned = await db.$transaction(async (tx) => {
        const fresh = await decisions.capture(tx, target.projectId);
        return planProjectDecision(fresh.input, { decisionId: createDecisionId() });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      assert.deepEqual(replanned.aggregations, []);
    });

    await t.test('an interrupted pass leaves nothing half-applied and re-derives the same answer',
      async () => {
        const target = await tree(db, 'restart', {
          gp: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          p: { parent: 'gp', policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          leaf: { parent: 'p', status: TaskStatus.DONE },
        });

        // Roll back a transaction that had already written both levels: this is the crash, and the
        // point is that a partially aggregated tree is not a durable state anyone can observe.
        await assert.rejects(db.$transaction(async (tx) => {
          const captured = await decisions.capture(tx, target.projectId);
          const outcome = planProjectDecision(captured.input, { decisionId: createDecisionId() });
          assert.equal(outcome.aggregations.length, 2);
          const applied = await reconciler.applyAggregations(
            tx, target.projectId, outcome.aggregations, new Date(),
          );
          assert.equal(applied, 2);
          throw new Error('simulated crash before commit');
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
        /simulated crash/);
        assert.deepEqual(await statuses(db, target), { gp: 'OPEN', p: 'OPEN', leaf: 'DONE' });

        // A fresh service, as a restarted process would have. The pending signals are still there,
        // and the answer they produce is the one the lost pass had computed.
        unregister();
        const restarted = new ProjectReconcileService(
          prisma, events, new ProjectDecisionService(prisma),
        );
        const rebind = events.registerHandler(restarted);
        try {
          await settle(events);
        } finally {
          rebind();
          unregister = events.registerHandler(reconciler);
        }
        assert.deepEqual(await statuses(db, target), { gp: 'DONE', p: 'DONE', leaf: 'DONE' });
      });

    // ---- structural refusals ------------------------------------------------------------------------
    await t.test('AG2: a parent cycle stored past the service stops aggregation instead of hanging',
      async () => {
        const target = await tree(db, 'cycle', {
          x: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          y: { parent: 'x', policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          done: { parent: 'y', status: TaskStatus.DONE },
        });
        // TasksService refuses this link (task-hierarchy.spec.ts); raw SQL is how a cycle could
        // still reach the table, and the loop has to survive one rather than spin on it.
        await db.$executeRawUnsafe(
          `UPDATE "task" SET "parent_task_id" = '${target.ids.y}'::uuid
            WHERE "id" = '${target.ids.x}'::uuid`,
        );
        await settle(events);
        const now = await statuses(db, target);
        assert.equal(now.x, 'OPEN');
        assert.equal(now.y, 'OPEN');
        assert.deepEqual(await auditedAggregations(db, target), []);

        const latest = await db.projectDecision.findFirstOrThrow({
          where: { projectId: target.projectId },
          orderBy: { createdAt: 'desc' },
          select: { outcome: true },
        });
        const outcome = latest.outcome as unknown as ProjectDecisionOutcome;
        assert.deepEqual(outcome.aggregationCycleTaskIds,
          [target.ids.x, target.ids.y].map(uuidToBase62).sort());
      });

    await t.test('a child in another Project cannot complete this one’s parent', async () => {
      const parent = await tree(db, 'crossparent', {
        p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        a: { parent: 'p' },
      });
      const other = await tree(db, 'crosschild', { c: { status: TaskStatus.DONE } });
      // Same refusal as the cycle above: the service rejects a cross-project parent outright, so
      // this is the shape a stray write would leave, and the snapshot must not act on half a tree.
      await db.$executeRawUnsafe(
        `UPDATE "task" SET "parent_task_id" = '${parent.ids.p}'::uuid
          WHERE "id" = '${other.ids.c}'::uuid`,
      );
      await db.task.update({ where: { id: parent.ids.a }, data: { status: TaskStatus.DONE } });
      await settle(events);
      // The visible children of `p` inside its own Project are all DONE, so it completes — the
      // point is that the invisible foreign child neither blocks it nor is counted as evidence.
      assert.equal((await statuses(db, parent)).p, 'DONE');
      const audited = await auditedAggregations(db, parent);
      assert.equal(audited.length, 1);
      assert.equal(audited[0].evidence.children.total, 1);
    });
  } finally {
    unregister();
    await db.$disconnect();
    await identity.end();
  }
});

test('migration 0123 is compatible with tasks that predate it', { skip: !URL, timeout: 60_000 },
  async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await emptyWorld(identity);
    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const events = new ProjectEventsService(prisma);
    const decisions = new ProjectDecisionService(prisma);
    const reconciler = new ProjectReconcileService(prisma, events, decisions);
    const unregister = events.registerHandler(reconciler);
    try {
      await t.test('the column defaults to MANUAL and the verdict is born null', async () => {
        const target = await tree(db, 'defaults', {});
        const id = randomUUID();
        // No completion_policy, no verdict — an INSERT written by a binary that predates 0123.
        await db.$executeRawUnsafe(`
          INSERT INTO "task" ("id", "title", "owner_id", "creator_type", "creator_id",
                              "project_id", "updated_at")
          VALUES ('${id}'::uuid, 'legacy row', '${target.ownerId}'::uuid, 'USER',
                  '${target.ownerId}'::uuid, '${target.projectId}'::uuid, CURRENT_TIMESTAMP)
        `);
        const row = await db.task.findUniqueOrThrow({
          where: { id },
          select: { completionPolicy: true, verdict: true },
        });
        assert.equal(row.completionPolicy, TaskCompletionPolicy.MANUAL);
        assert.equal(row.verdict, null);
      });

      await t.test('a tree that predates the migration is not auto-completed by it', async () => {
        const target = await tree(db, 'nobackfill', {
          p: {},
          a: { parent: 'p', status: TaskStatus.DONE },
          b: { parent: 'p', status: TaskStatus.CANCELLED },
        });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'OPEN');
        assert.deepEqual(await auditedAggregations(db, target), []);

        // Opting in is a deliberate write, and it takes effect on the next reconcile.
        await db.task.update({
          where: { id: target.ids.p },
          data: { completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
        });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'DONE');
      });

      await t.test('switching back to MANUAL stops aggregation without undoing it', async () => {
        const target = await tree(db, 'optout', {
          p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          a: { parent: 'p', status: TaskStatus.DONE },
        });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'DONE');

        await db.task.update({
          where: { id: target.ids.p },
          data: { completionPolicy: TaskCompletionPolicy.MANUAL },
        });
        await db.task.update({ where: { id: target.ids.a }, data: { status: TaskStatus.OPEN } });
        await settle(events);
        assert.equal((await statuses(db, target)).p, 'DONE',
          'MANUAL means nobody recomputes it, not that it is recomputed to OPEN');
      });

      await t.test('a decision captured before 0123 still replays', async () => {
        const target = await tree(db, 'oldsnapshot', {
          p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          a: { parent: 'p', status: TaskStatus.DONE },
        });
        const decisionId = createDecisionId();
        const captured = await db.$transaction((tx) => decisions.capture(tx, target.projectId),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
        // Strip the two columns 0123 added, exactly as a row written by the previous binary has
        // them, and re-hash so the snapshot is internally consistent.
        const legacy = JSON.parse(JSON.stringify(captured.input));
        for (const task of legacy.world.tasks) {
          delete task.completionPolicy;
          delete task.verdict;
        }
        const { hashDecisionInput } = await import('./project-decision.service.js');
        legacy.decisionInputHash = hashDecisionInput(legacy);
        const outcome = planProjectDecision(legacy, { decisionId });
        assert.deepEqual(outcome.aggregations, [],
          'a snapshot with no policy column reads as MANUAL, not as today’s rules');
        assert.deepEqual(outcome.aggregationCycleTaskIds, []);
      });
    } finally {
      unregister();
      await db.$disconnect();
      await identity.end();
    }
  });
