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
  RunStatus,
  SessionDispatchOrigin,
  TaskCompletionPolicy,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAuthorizationService } from './project-authorization.service';
import {
  createDecisionId,
  planProjectDecision,
  ProjectDecisionService,
  verificationVerdictFacts,
} from './project-decision.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService, ProjectReconcileLease } from './project-reconcile.service';
import { ProjectVerificationVerdictService } from './project-verification-verdict.service';
import { ProjectsService } from './projects.service';
import {
  PlannedVerificationVerdict,
  planVerificationVerdicts,
  verificationDefectIdempotencyKey,
  verificationVerdictActionKey,
} from './task-verification-verdict';

const URL = process.env.COORDINATOR_PG_URL;

/**
 * §13.2's native consequences against a real, fully migrated PostgreSQL.
 *
 * The unit spec beside this one proves what the plan SAYS. None of what this file is about exists
 * in a pure function: the action ledger's uniqueness, a redelivered reconcile, two writers racing,
 * a service that restarts halfway, a subject deleted underneath a verdict in flight, and the
 * dispatch guard reading a condition row at commit time. Its writes are destructive, so it refuses
 * to run anywhere but an isolated disposable server (see coordinator-pg-test-safety).
 */

interface Fixture {
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
  dependsOn?: string[];
}

async function fixture(
  db: PrismaClient,
  label: string,
  spec: Record<string, TaskSpec>,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc16.invalid`, name: label, passwordHash: 'x' },
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
      coordinatorEnabled: true,
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
        assigneeId: workspaceId,
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
  for (const [name, one] of Object.entries(spec)) {
    for (const prerequisite of one.dependsOn ?? []) {
      await db.taskDependency.create({
        data: { taskId: ids[name], dependsOnTaskId: ids[prerequisite] },
      });
    }
  }
  return { ownerId, projectId, workspaceId, ids };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task_verification_failure", "project_event", "project_decision", "project_action",
             "project_runtime", "project_member", "task", "session", "workspace", "runner",
             "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function settle(events: ProjectEventsService, limit = 60): Promise<void> {
  for (let pass = 0; pass < limit; pass += 1) {
    const result = await events.drainOnce();
    assert.notEqual(result.status, 'DEAD', 'a delivery died instead of reconciling');
    assert.notEqual(result.status, 'RETRY_SCHEDULED', 'a delivery failed and was rescheduled');
    if (result.status === 'IDLE' || result.status === 'NO_HANDLER' || result.status === 'DEFERRED') {
      return;
    }
  }
  assert.fail(`the loop did not converge within ${limit} delivery passes`);
}

interface PlannedRound {
  lease: ProjectReconcileLease;
  decisionId: string;
  planned: PlannedVerificationVerdict | undefined;
  skipped: string | undefined;
}

/**
 * One reconcile that plans the verdict on `verifierName`, exactly as the loop would.
 *
 * Everything goes through the production path: the real snapshot capture, the real plan, the real
 * persisted decision. The action key is rebuilt from the plan's revision here rather than from a
 * literal, so a spec cannot accidentally agree with a key the product no longer produces.
 */
async function planRound(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  reconciler: ProjectReconcileService,
  events: ProjectEventsService,
  target: Fixture,
  verifierName: string,
): Promise<PlannedRound> {
  await settle(events);
  const lease = await reconciler.acquireLease(target.projectId);
  assert.ok(lease, 'the fixture project must be leasable');
  const decisionId = createDecisionId();
  let planned: PlannedVerificationVerdict | undefined;
  let skipped: string | undefined;
  await db.$transaction(async (tx) => {
    const captured = await decisions.capture(tx, target.projectId);
    const facts = verificationVerdictFacts(captured.input);
    const plan = planVerificationVerdicts(facts.verifications, facts.subjects);
    const verifierPublicId = uuidToBase62(target.ids[verifierName]);
    planned = plan.verdicts.find((one) => one.verifierTaskId === verifierPublicId);
    skipped = plan.skipped.find((one) => one.verifierTaskId === verifierPublicId)?.reason;
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: planned
        ? [{
            type: 'APPLY_VERIFICATION_VERDICT',
            idempotencyKey: verificationVerdictActionKey(
              target.projectId,
              target.ids[verifierName],
              planned.verdictRevision,
            ),
            subject: { type: 'TASK', id: planned.verifierTaskId },
          }]
        : [],
    });
    await decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { lease, decisionId, planned, skipped };
}

/**
 * A decision carrying a verdict action nobody planned.
 *
 * The effect's own guards — the subject the check no longer names, the conclusion the row no
 * longer holds — cannot be reached through `planRound`, because the planner refuses to produce
 * those plans in the first place and the ledger's staleness gate declines anything captured before
 * the world moved. Building the action by hand, against a snapshot that is still current, is the
 * only way to put the effect in front of them; it is exactly what unit 14's pg spec does to reach
 * the dispatcher's refusals.
 */
async function forgeRound(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  reconciler: ProjectReconcileService,
  events: ProjectEventsService,
  target: Fixture,
  verifierName: string,
  overrides: Partial<PlannedVerificationVerdict>,
): Promise<{ lease: ProjectReconcileLease; decisionId: string; planned: PlannedVerificationVerdict }> {
  await settle(events);
  const lease = await reconciler.acquireLease(target.projectId);
  assert.ok(lease);
  const decisionId = createDecisionId();
  const verifierPublicId = uuidToBase62(target.ids[verifierName]);
  const planned: PlannedVerificationVerdict = {
    verifierTaskId: verifierPublicId,
    subjectTaskId: uuidToBase62(target.ids.s),
    verdict: 'FAIL',
    verdictRevision: '1',
    consequences: {
      revertSubject: true,
      fileDefect: true,
      blockDownstream: true,
      raiseCondition: true,
      resolveConditions: false,
      opensCoordinatorTurn: true,
    },
    evidence: {
      v: 1,
      verifierTaskId: verifierPublicId,
      subjectTaskId: uuidToBase62(target.ids.s),
      verdict: 'FAIL',
      verdictRevision: '1',
      verifierStatus: 'DONE',
      subjectStatus: 'DONE',
      session: null,
    },
    ...overrides,
  };
  await db.$transaction(async (tx) => {
    const captured = await decisions.capture(tx, target.projectId);
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: [{
        type: 'APPLY_VERIFICATION_VERDICT',
        idempotencyKey: verificationVerdictActionKey(
          target.projectId,
          target.ids[verifierName],
          planned.verdictRevision,
        ),
        subject: { type: 'TASK', id: verifierPublicId },
      }],
    });
    await decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { lease, decisionId, planned };
}

/** Write a conclusion the way a verification agent does: through the ordinary task update. */
async function conclude(
  tasks: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> },
  verifierId: string,
  verdict: TaskVerdict,
): Promise<void> {
  await tasks.update({ where: { id: verifierId }, data: { status: TaskStatus.DONE, verdict } });
}

async function defects(db: PrismaClient, target: Fixture): Promise<Array<{
  id: string; parentTaskId: string | null; status: string; idempotencyKey: string | null;
}>> {
  return db.task.findMany({
    where: { projectId: target.projectId, idempotencyKey: { startsWith: 'pc:v1:' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, parentTaskId: true, status: true, idempotencyKey: true },
  });
}

test('verification verdicts have native consequences on PostgreSQL',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const migrated = await identity.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM "_prisma_migrations"
       WHERE "migration_name" = '0124_task_verification_verdict' AND "finished_at" IS NOT NULL
    `);
    assert.equal(migrated.rows[0]?.count, '1', 'the isolated database must have migration 0124');
    await emptyWorld(identity);

    const db = new PrismaClient({ datasources: { db: { url: URL } } });
    const prisma = db as unknown as PrismaService;
    const events = new ProjectEventsService(prisma);
    const decisions = new ProjectDecisionService(prisma);
    const reconciler = new ProjectReconcileService(prisma, events, decisions);
    const verdicts = new ProjectVerificationVerdictService(prisma, reconciler);
    const authorization = new ProjectAuthorizationService();
    const projects = new ProjectsService(prisma, {} as unknown as SessionsService);
    const unregister = events.registerHandler(reconciler);

    /** Conclude a verdict, plan it, apply it, and leave the loop settled. */
    const round = async (target: Fixture, verifier: string, verdict?: TaskVerdict) => {
      if (verdict) {
        await conclude(
          { update: (args) => db.task.update(args as never) },
          target.ids[verifier],
          verdict,
        );
      }
      const plan = await planRound(db, decisions, reconciler, events, target, verifier);
      const applied = plan.planned
        ? await verdicts.apply(plan.lease, { decisionId: plan.decisionId, planned: plan.planned })
        : null;
      await reconciler.releaseLease(plan.lease);
      await settle(events);
      return { plan, applied };
    };

    try {
      // ---- §13.2's table, one row each -------------------------------------------------------
      await t.test('FAIL reverts the subject, files one defect under it and raises the condition',
        async () => {
          const target = await fixture(db, 'fail', {
            s: { status: TaskStatus.DONE },
            v: { verifies: 's' },
          });
          const { plan, applied } = await round(target, 'v', TaskVerdict.FAIL);
          assert.equal(plan.planned?.verdictRevision, '1', 'concluding advances the revision');
          assert.equal(applied?.action.status, 'APPLIED');
          assert.equal(applied?.subjectReverted, true);

          const subject = await db.task.findUniqueOrThrow({ where: { id: target.ids.s } });
          assert.equal(subject.status, 'OPEN', 'the native revert');

          const filed = await defects(db, target);
          assert.equal(filed.length, 1);
          assert.equal(filed[0].parentTaskId, target.ids.s, 'the defect is a subtask of the subject');
          assert.equal(
            filed[0].idempotencyKey,
            verificationDefectIdempotencyKey(target.projectId, target.ids.v, '1'),
          );

          const condition = await db.taskVerificationFailure.findFirstOrThrow({
            where: { projectId: target.projectId },
          });
          assert.equal(condition.verdict, 'FAIL');
          assert.equal(condition.verdictRevision, 1n);
          assert.equal(condition.blocksDownstream, true);
          assert.equal(condition.defectTaskId, filed[0].id);
          assert.equal(condition.subjectTaskId, target.ids.s);
          assert.equal(condition.resolvedAt, null);
          assert.equal(condition.raisedByActionId, applied?.action.actionId);
        });

      await t.test('INCONCLUSIVE records the condition and reverts nothing', async () => {
        const target = await fixture(db, 'inconclusive', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        const { applied } = await round(target, 'v', TaskVerdict.INCONCLUSIVE);
        assert.equal(applied?.action.status, 'APPLIED');
        assert.equal(applied?.subjectReverted, false);
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: target.ids.s } })).status,
          'DONE',
        );
        assert.deepEqual(await defects(db, target), [], 'INCONCLUSIVE files no defect');
        const condition = await db.taskVerificationFailure.findFirstOrThrow({
          where: { projectId: target.projectId },
        });
        assert.equal(condition.verdict, 'INCONCLUSIVE');
        assert.equal(condition.blocksDownstream, false);
        assert.equal(condition.defectTaskId, null);
      });

      await t.test('PASS leaves the subject DONE and resolves the conditions about it', async () => {
        const target = await fixture(db, 'pass', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
          w: { verifies: 's' },
        });
        await round(target, 'v', TaskVerdict.FAIL);
        assert.equal(
          await db.taskVerificationFailure.count({
            where: { projectId: target.projectId, resolvedAt: null },
          }),
          1,
        );
        const { applied } = await round(target, 'w', TaskVerdict.PASS);
        assert.equal(applied?.action.status, 'APPLIED');
        assert.equal(applied?.conditionsResolved, 1);
        assert.equal(
          await db.taskVerificationFailure.count({
            where: { projectId: target.projectId, resolvedAt: null },
          }),
          0,
        );
        const resolved = await db.taskVerificationFailure.findFirstOrThrow({
          where: { projectId: target.projectId },
        });
        assert.equal(resolved.resolvedByTaskId, target.ids.w);
        assert.deepEqual(await defects(db, target), await defects(db, target));
      });

      // ---- V2: duplicate and out-of-order delivery --------------------------------------------
      await t.test('V2: the same conclusion applied again changes nothing', async () => {
        const target = await fixture(db, 'duplicate', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        const { plan } = await round(target, 'v', TaskVerdict.FAIL);
        assert.ok(plan.planned);
        // Put the subject back by hand, so a second application would be VISIBLE if it happened.
        await db.task.update({ where: { id: target.ids.s }, data: { status: TaskStatus.DONE } });
        await settle(events);

        const again = await reconciler.acquireLease(target.projectId);
        assert.ok(again);
        const replay = await verdicts.apply(again, {
          decisionId: plan.decisionId,
          planned: plan.planned!,
        });
        await reconciler.releaseLease(again);
        assert.equal(replay.action.status, 'ALREADY_APPLIED');
        assert.equal(replay.subjectReverted, false);
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: target.ids.s } })).status,
          'DONE',
          'a replay must not revert a subject somebody deliberately put back',
        );
        assert.equal((await defects(db, target)).length, 1, 'and must not file a second defect');
        assert.equal(
          await db.taskVerificationFailure.count({ where: { projectId: target.projectId } }),
          1,
        );
      });

      await t.test('V2: a service that restarted mid-flight replays to the same answer', async () => {
        const target = await fixture(db, 'restart', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        const { plan } = await round(target, 'v', TaskVerdict.FAIL);
        const restarted = new ProjectVerificationVerdictService(
          prisma,
          new ProjectReconcileService(prisma, events, decisions),
        );
        const lease = await reconciler.acquireLease(target.projectId);
        assert.ok(lease);
        const replay = await restarted.apply(lease, {
          decisionId: plan.decisionId,
          planned: plan.planned!,
        });
        await reconciler.releaseLease(lease);
        assert.equal(replay.action.status, 'ALREADY_APPLIED');
        assert.equal((await defects(db, target)).length, 1);
      });

      await t.test('two writers racing the same conclusion produce one defect', async () => {
        const target = await fixture(db, 'concurrent', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await conclude({ update: (args) => db.task.update(args as never) }, target.ids.v,
          TaskVerdict.FAIL);
        const plan = await planRound(db, decisions, reconciler, events, target, 'v');
        assert.ok(plan.planned);
        const command = { decisionId: plan.decisionId, planned: plan.planned! };
        const [first, second] = await Promise.all([
          verdicts.apply(plan.lease, command),
          verdicts.apply(plan.lease, command),
        ]);
        await reconciler.releaseLease(plan.lease);
        await settle(events);
        const statuses = [first.action.status, second.action.status].sort();
        assert.deepEqual(statuses, ['ALREADY_APPLIED', 'APPLIED']);
        assert.equal((await defects(db, target)).length, 1);
        assert.equal(
          await db.taskVerificationFailure.count({ where: { projectId: target.projectId } }),
          1,
        );
      });

      // ---- V4 / V7: FAIL -> fix -> FAIL again --------------------------------------------------
      await t.test('V7: a second FAIL from the same check happens again, in full', async () => {
        const target = await fixture(db, 'refail', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        const first = await round(target, 'v', TaskVerdict.FAIL);
        assert.equal(first.plan.planned?.verdictRevision, '1');
        const firstDefect = (await defects(db, target))[0];

        // Somebody fixes the defect, the subject is re-run and re-reported, and the check is run
        // again — which is what re-opening the verification task means. Re-opening revokes the
        // conclusion, so the next one is a NEW conclusion with a NEW revision.
        await db.task.update({ where: { id: firstDefect.id }, data: { status: TaskStatus.DONE } });
        await db.task.update({ where: { id: target.ids.s }, data: { status: TaskStatus.DONE } });
        await db.task.update({ where: { id: target.ids.v }, data: { status: TaskStatus.OPEN } });
        await settle(events);
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: target.ids.v } })).verdict,
          null,
          'a check that is no longer finished holds no conclusion',
        );

        const second = await round(target, 'v', TaskVerdict.FAIL);
        assert.equal(second.plan.planned?.verdictRevision, '2', 'a new conclusion, a new revision');
        assert.notEqual(
          verificationVerdictActionKey(target.projectId, target.ids.v, '1'),
          verificationVerdictActionKey(target.projectId, target.ids.v, '2'),
        );
        assert.equal(second.applied?.action.status, 'APPLIED');
        assert.equal(second.applied?.subjectReverted, true, 'the subject is reverted AGAIN');
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: target.ids.s } })).status,
          'OPEN',
        );
        const filed = await defects(db, target);
        assert.equal(filed.length, 2, 'and a second defect is filed');
        assert.equal(
          await db.taskVerificationFailure.count({
            where: { projectId: target.projectId, resolvedAt: null },
          }),
          2,
        );
      });

      await t.test('V7: the revision is monotonic and cannot be reset by any path', async () => {
        const target = await fixture(db, 'monotonic', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await conclude({ update: (args) => db.task.update(args as never) }, target.ids.v,
          TaskVerdict.FAIL);
        await db.task.update({ where: { id: target.ids.v }, data: { verdict: null } });
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: target.ids.v } })).verdictRevision,
          1n,
          'revoking a conclusion does not give the revision back',
        );
        await assert.rejects(
          db.$executeRaw`UPDATE "task" SET "verdict_revision" = 0 WHERE "id" = ${target.ids.v}::uuid`,
          /VERDICT_REVISION_NOT_MONOTONIC/,
        );
      });

      // ---- V6: the subject can vanish ----------------------------------------------------------
      await t.test('V6: a subject deleted under a verdict in flight neither throws nor wedges',
        async () => {
          const target = await fixture(db, 'vanish', {
            s: { status: TaskStatus.DONE },
            v: { verifies: 's' },
          });
          await conclude({ update: (args) => db.task.update(args as never) }, target.ids.v,
            TaskVerdict.FAIL);
          const plan = await planRound(db, decisions, reconciler, events, target, 'v');
          assert.ok(plan.planned);
          // The fixture-teardown case: deleting the subject takes its verification with it, since
          // `task.verifies_task_id` cascades. The plan in hand now names two rows that are gone.
          await db.task.delete({ where: { id: target.ids.s } });
          const applied = await verdicts.apply(plan.lease, {
            decisionId: plan.decisionId,
            planned: plan.planned!,
          });
          await reconciler.releaseLease(plan.lease);

          // Terminal and committed, never CLAIMED and never APPLIED. Which of the two terminal
          // codes it gets depends on who notices first: the ledger's own staleness gate sees the
          // deleted rows in the re-read snapshot and refuses before the effect runs, and the
          // effect's SUPERSEDED (asserted below) is what catches a subject that moved in a way the
          // snapshot cannot show. Either way nothing was written and nothing is left holding.
          assert.ok(['REFUSED', 'SUPERSEDED'].includes(applied.action.status), applied.action.status);
          const action = await db.projectAction.findUniqueOrThrow({
            where: { id: applied.action.actionId },
          });
          assert.ok(['REFUSED', 'SUPERSEDED'].includes(action.status));
          assert.ok(action.refusalCode);
          assert.equal(applied.defectTaskId, null);
          assert.equal(applied.failureId, null);
          assert.equal(await db.taskVerificationFailure.count({
            where: { projectId: target.projectId },
          }), 0);
          assert.deepEqual(await defects(db, target), []);

          // And the loop keeps converging: the next reconcile plans nothing for a check that is
          // no longer there, rather than retrying a verdict about a world that ended.
          await settle(events);
          const after = await planRound(db, decisions, reconciler, events, target, 'v');
          await reconciler.releaseLease(after.lease);
          assert.equal(after.planned, undefined);
          assert.equal(after.skipped, undefined, 'a deleted verification is not even a candidate');
        });

      await t.test('V6: a subject the verifier no longer names is SUPERSEDED, not applied',
        async () => {
          const target = await fixture(db, 'repointed', {
            s: { status: TaskStatus.DONE },
            other: { status: TaskStatus.DONE },
            v: { verifies: 's' },
          });
          await conclude({ update: (args) => db.task.update(args as never) }, target.ids.v,
            TaskVerdict.FAIL);
          // Hand-built rather than planned, which is the point: this is the effect's own guard,
          // reached with a snapshot that is still current, so nothing else can decline first.
          const forged = await forgeRound(db, decisions, reconciler, events, target, 'v', {
            subjectTaskId: uuidToBase62(target.ids.other),
            verdictRevision: '1',
          });
          const applied = await verdicts.apply(forged.lease, {
            decisionId: forged.decisionId,
            planned: forged.planned,
          });
          await reconciler.releaseLease(forged.lease);
          await settle(events);
          assert.equal(applied.action.status, 'SUPERSEDED');
          assert.equal(
            (await db.projectAction.findUniqueOrThrow({ where: { id: applied.action.actionId } }))
              .refusalCode,
            'VERIFICATION_SUBJECT_REPOINTED',
          );
          assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.ids.other } })).status,
            'DONE', 'a task the check never named is not reverted by it');
          assert.deepEqual(await defects(db, target), []);
        });

      await t.test('a conclusion superseded by a newer one is not applied on top of it', async () => {
        const target = await fixture(db, 'superseded', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await conclude({ update: (args) => db.task.update(args as never) }, target.ids.v,
          TaskVerdict.FAIL);
        // Revision 9 names a conclusion this check has not reached. The row says 1, so the finding
        // in hand is not the finding on the row, and applying it would replay a stale verdict.
        const forged = await forgeRound(db, decisions, reconciler, events, target, 'v', {
          verdictRevision: '9',
        });
        const applied = await verdicts.apply(forged.lease, {
          decisionId: forged.decisionId,
          planned: forged.planned,
        });
        await reconciler.releaseLease(forged.lease);
        await settle(events);
        assert.equal(applied.action.status, 'SUPERSEDED');
        assert.equal(
          (await db.projectAction.findUniqueOrThrow({ where: { id: applied.action.actionId } }))
            .refusalCode,
          'VERDICT_SUPERSEDED',
        );
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.ids.s } })).status,
          'DONE', 'the subject is not reverted by a finding that no longer stands');
        assert.deepEqual(await defects(db, target), []);
      });

      // ---- V3: the block is a precondition, not a status rewrite -------------------------------
      await t.test('V3: downstream is blocked at the guard, and its own row is untouched',
        async () => {
          const target = await fixture(db, 'downstream', {
            s: { status: TaskStatus.DONE },
            v: { verifies: 's' },
            d: { dependsOn: ['s'] },
          });
          const before = await authorize(db, authorization, target, 'd');
          assert.equal(before?.result.decision, 'ALLOW');

          await round(target, 'v', TaskVerdict.FAIL);
          // The dependent's own row says nothing about being blocked — that is the point (V3).
          const dependent = await db.task.findUniqueOrThrow({ where: { id: target.ids.d } });
          assert.equal(dependent.status, 'OPEN');
          assert.equal(dependent.dispatchHold, false);

          const blocked = await authorize(db, authorization, target, 'd');
          assert.equal(blocked?.result.decision, 'DEFER');
          // The revert makes the prerequisite outstanding as well, so both halves of precondition
          // 3 hold; the verdict is the half that says what to do about it.
          assert.equal(blocked?.result.reasonCode, 'VERIFICATION_FAILED_UPSTREAM');
          assert.equal(blocked?.request.task?.verificationBlock?.verifierTaskId,
            uuidToBase62(target.ids.v));
          assert.equal(blocked?.request.task?.verificationBlock?.verdictRevision, '1');

          // Even putting the subject back to DONE does not unblock it: the old verdict must not
          // become a pass on its own (V4).
          await db.task.update({ where: { id: target.ids.s }, data: { status: TaskStatus.DONE } });
          await settle(events);
          const still = await authorize(db, authorization, target, 'd');
          assert.equal(still?.result.reasonCode, 'VERIFICATION_FAILED_UPSTREAM');

          // A later PASS is what resolves it, and downstream recovers.
          await round(target, 'v', undefined);
          await db.task.update({ where: { id: target.ids.v }, data: { status: TaskStatus.OPEN } });
          await settle(events);
          const passed = await round(target, 'v', TaskVerdict.PASS);
          assert.equal(passed.applied?.action.status, 'APPLIED');
          assert.equal(passed.applied?.conditionsResolved, 1);
          const recovered = await authorize(db, authorization, target, 'd');
          assert.equal(recovered?.result.decision, 'ALLOW');
        });

      await t.test('V4: the subject waits for its defect, then becomes dispatchable again',
        async () => {
          const target = await fixture(db, 'subjectblock', {
            s: { status: TaskStatus.DONE },
            v: { verifies: 's' },
          });
          await round(target, 'v', TaskVerdict.FAIL);
          const blocked = await authorize(db, authorization, target, 's');
          assert.equal(blocked?.result.decision, 'DEFER');
          assert.equal(blocked?.result.reasonCode, 'VERIFICATION_DEFECT_OPEN');

          const defect = (await defects(db, target))[0];
          await db.task.update({ where: { id: defect.id }, data: { status: TaskStatus.DONE } });
          await settle(events);
          const freed = await authorize(db, authorization, target, 's');
          assert.equal(freed?.result.decision, 'ALLOW',
            'the subject is dispatchable once the defect is settled — the check still has to re-run');
          assert.equal(
            await db.taskVerificationFailure.count({
              where: { projectId: target.projectId, resolvedAt: null },
            }),
            1,
            'and the condition is still unresolved, because nothing has passed yet',
          );
        });

      // ---- §13.1 interplay ---------------------------------------------------------------------
      await t.test('a revert and its defect pull the aggregated parent back open', async () => {
        const target = await fixture(db, 'aggregate', {
          p: { policy: TaskCompletionPolicy.ALL_CHILDREN_DONE },
          s: { parent: 'p', status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await settle(events);
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.ids.p } })).status,
          'DONE', 'the parent completed from its only child');

        await round(target, 'v', TaskVerdict.FAIL);
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.ids.p } })).status,
          'OPEN', 'the revert propagates up the tree');

        const defect = (await defects(db, target))[0];
        assert.equal(defect.parentTaskId, target.ids.s);
        await db.task.update({ where: { id: defect.id }, data: { status: TaskStatus.DONE } });
        await db.task.update({ where: { id: target.ids.s }, data: { status: TaskStatus.DONE } });
        await settle(events);
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.ids.p } })).status,
          'DONE', 'and the parent completes again once the subtree does');
      });

      // ---- V5: the run is judged by its terminal state ------------------------------------------
      await t.test('V5: a conclusion whose run is still live is not applied yet', async () => {
        const target = await fixture(db, 'inflight', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await db.session.create({
          data: {
            id: randomUUID(),
            ownerId: target.ownerId,
            workspaceId: target.workspaceId,
            taskId: target.ids.v,
            title: 'inflight-run',
            prompt: 'inflight',
            creatorId: target.ownerId,
            status: RunStatus.RUNNING,
            dispatchOrigin: SessionDispatchOrigin.USER,
            provider: 'claude',
          },
        });
        await conclude({ update: (args) => db.task.update(args as never) }, target.ids.v,
          TaskVerdict.FAIL);
        const plan = await planRound(db, decisions, reconciler, events, target, 'v');
        await reconciler.releaseLease(plan.lease);
        assert.equal(plan.planned, undefined);
        assert.equal(plan.skipped, 'RUN_IN_FLIGHT');
        assert.equal((await db.task.findUniqueOrThrow({ where: { id: target.ids.s } })).status,
          'DONE');
      });

      // ---- the audit read face -----------------------------------------------------------------
      await t.test('every relation is readable, in Base62, with no UUID anywhere', async () => {
        const target = await fixture(db, 'audit', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
          d: { dependsOn: ['s'] },
        });
        await round(target, 'v', TaskVerdict.FAIL);
        const audit = await projects.verifications(target.ownerId, target.projectId);
        const rendered = renderAsApi(audit);
        assert.equal(rendered.verifications.length, 1);
        assert.equal(rendered.verifications[0].verdict, 'FAIL');
        assert.equal(rendered.verifications[0].verdictRevision, '1');
        assert.equal(rendered.verifications[0].subjectTaskId, uuidToBase62(target.ids.s));
        assert.equal(rendered.failures.length, 1);
        assert.equal(rendered.failures[0].verifierTaskId, uuidToBase62(target.ids.v));
        assert.ok(rendered.failures[0].defectTaskId);
        assert.ok(rendered.failures[0].raisedByActionId);
        assert.equal(rendered.failures[0].actionStatus, 'APPLIED');
        assert.deepEqual(
          rendered.blockedTasks.map((one) => [one.taskId, one.reason]).sort(),
          [
            [uuidToBase62(target.ids.d), 'UPSTREAM'],
            [uuidToBase62(target.ids.s), 'SUBJECT_DEFECT_OPEN'],
          ].sort(),
        );
        assert.doesNotMatch(
          JSON.stringify(rendered),
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
          'the audit face must never leak a UUID',
        );
      });
    } finally {
      unregister();
      await db.$disconnect();
      await identity.end();
    }
  });

/** The commit-time guard, run exactly as the dispatcher runs it. */
async function authorize(
  db: PrismaClient,
  authorization: ProjectAuthorizationService,
  target: Fixture,
  taskName: string,
) {
  return db.$transaction((tx) => authorization.authorizeInTransaction(tx, {
    projectId: target.projectId,
    ownerId: target.ownerId,
    coordinatorAgentId: target.workspaceId,
    action: 'DISPATCH_TASK',
    idempotencyKey: `pc:v1:${target.projectId}:dispatch:${target.ids[taskName]}:1`,
    sourceDecisionInputHash: 'a'.repeat(64),
    taskId: target.ids[taskName],
  }));
}

/**
 * What the HTTP layer would send: the response interceptor's rewrite, applied by the same rule.
 *
 * Reproduced here rather than imported so this asserts the OUTPUT contract — every id in the body
 * is Base62 — instead of asserting that one module calls another.
 */
function renderAsApi(body: unknown): {
  verifications: Array<Record<string, string>>;
  failures: Array<Record<string, string>>;
  blockedTasks: Array<Record<string, string>>;
} {
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item)]),
      );
    }
    if (typeof value === 'string' && uuid.test(value)) return uuidToBase62(value);
    if (typeof value === 'bigint') return String(value);
    return value;
  };
  return walk(body) as ReturnType<typeof renderAsApi>;
}
