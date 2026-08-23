/**
 * §13.2's consequences through the door a caller actually has, against a real PostgreSQL.
 *
 * `task-verification-verdict.pg.spec` beside this one proves the EFFECT is right — it builds a
 * lease, plans a decision and calls `ProjectVerificationVerdictService.apply` itself. This one
 * exists because that was the only thing that ever called it. `verificationVerdictPlan` was
 * complete, correct, and consumed in exactly one place: §11.4's condition detector, which turned it
 * into a `VERIFICATION_FAILED` blocker and discarded the rest. So in production a FAIL left its
 * subject DONE, filed no defect subtask, and wrote no row into `task_verification_failure` — the
 * table `ProjectAuthorizationService` reads before it lets a dependent task run — while every spec
 * covering the effect stayed green, because each of them was the caller.
 *
 * It is the same shape `task-verification-doors.pg.spec` was cut for after §13.1's aggregation had
 * it, and 25D's dispatch pass after §7.8 had it. Nothing here calls `apply`. Verdicts are written
 * through `TasksService` — the object the PATCH, the CLI and the MCP tool all end up in — and the
 * only thing that runs afterwards is the event loop, wired the way `ProjectsModule` wires it.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunnerStatus,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { Client } from 'pg';
import { base62ToUuid } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectDecisionService } from './project-decision.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService } from './project-reconcile.service';
import { ProjectVerificationVerdictService } from './project-verification-verdict.service';
import { ProjectsService } from './projects.service';
import {
  VERDICT_APPLY_EXHAUSTED,
  VERDICT_APPLY_MAX_ATTEMPTS,
  verdictApplyAttempt,
  verificationVerdictActionKey,
} from './task-verification-verdict';
import { loadVerificationEpochGates } from '../tasks/verification-epoch-read';
import { prismaClientFor } from '../prisma/prisma-client';

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  ids: Record<string, string>;
}

interface TaskSpec {
  status?: TaskStatus;
  verifies?: string;
  dependsOn?: string[];
}

/**
 * The world one case runs in.
 *
 * `coordinatorEnabled: true` with `GUARDED_AUTO` is not a convenience: it is what every Project
 * created since the feature shipped comes back as, so it is what "the coordinator behaves as it is
 * configured in production" means for a Project. A project whose owner kept the coordinator OFF has
 * no control loop at all — no dispatch, no blockers, no reconcile — and the last case in this file
 * measures that boundary rather than leaving it to be discovered.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  spec: Record<string, TaskSpec>,
  coordinatorEnabled = true,
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc25e.invalid`, name: label, passwordHash: 'x' },
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
      coordinatorEnabled,
      automationPolicy: ProjectAutomationPolicy.GUARDED_AUTO,
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
        verifiesTaskId: one.verifies ? ids[one.verifies] : null,
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

/**
 * Run the loop until it has nothing left to deliver.
 *
 * `tick` rather than `drainOnce` alone: applying a verdict floors this project's `next_wake_at`
 * when more conclusions are owed, and it is `enqueueScheduledWakes` — inside the tick — that turns
 * that clock into the next delivery. Draining without it would measure a loop with its timer
 * removed, which is not the loop production runs.
 */
async function settle(
  events: ProjectEventsService,
  reconciler: ProjectReconcileService,
  limit = 40,
): Promise<void> {
  for (let pass = 0; pass < limit; pass += 1) {
    const result = await events.drainOnce();
    assert.notEqual(result.status, 'DEAD', 'a delivery died instead of reconciling');
    assert.notEqual(result.status, 'RETRY_SCHEDULED', 'a delivery failed and was rescheduled');
    if (result.status === 'IDLE' || result.status === 'NO_HANDLER' || result.status === 'DEFERRED') {
      // The queue is empty; the clock may not be. One tick converts a due wake into a delivery,
      // and a second empty drain after it is the actual fixed point.
      await reconciler.tick(new Date(Date.now() + 1_000));
      const after = await events.drainOnce();
      if (after.status === 'IDLE' || after.status === 'NO_HANDLER' || after.status === 'DEFERRED') {
        return;
      }
    }
  }
  assert.fail(`the loop did not converge within ${limit} delivery passes`);
}

/**
 * `[K5]`: a settled verification run, so §13.3's epoch gets PAST `RUN_NOT_SETTLED`.
 *
 * The cases below are about the clause AFTER it — whether the conclusion was APPLIED — and without
 * a run they would all stop one clause early and measure something else.
 *
 * `dispatch_origin = 'USER'`: migration 0122's boundary refuses a Session written straight onto a
 * COORDINATOR-authority task, and what the epoch reads off the row is identical either way.
 */
async function settledRun(db: PrismaClient, target: Fixture, verifier: string): Promise<void> {
  await db.$executeRawUnsafe(
    `INSERT INTO "session" ("id","owner_id","workspace_id","task_id","title","prompt","creator_id",
       "provider","status","end_reason","completed_at","starts_task_work","dispatch_origin",
       "updated_at")
     VALUES ($1,$2,$3,$4,'check run','run the check',$2,'claude','SUCCEEDED','task_done',now(),
       true,'USER'::"session_dispatch_origin",now())`,
    randomUUID(), target.ownerId, target.workspaceId, target.ids[verifier],
  );
}

/** A verification agent's own write: conclude, through the ordinary task door. */
async function conclude(
  tasks: TasksService,
  target: Fixture,
  verifier: string,
  verdict: TaskVerdict,
): Promise<void> {
  await tasks.update(target.ownerId, target.ids[verifier], {
    status: TaskStatus.DONE,
    verdict,
  } as never);
}

async function verdictActions(db: PrismaClient, projectId: string) {
  return db.projectAction.findMany({
    where: { projectId, type: 'APPLY_VERIFICATION_VERDICT' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

async function defects(db: PrismaClient, target: Fixture) {
  return db.task.findMany({
    where: { projectId: target.projectId, idempotencyKey: { startsWith: 'pc:v1:' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, parentTaskId: true, status: true, title: true, idempotencyKey: true },
  });
}

function tasksService(db: PrismaClient): TasksService {
  const realtime = { publishTaskChanged: () => {}, publishForUser: () => {} };
  // Nothing in this file starts a run: the fixture tasks are unassigned, so `execute` is
  // unreachable. A stub that throws says so loudly if that ever stops being true.
  const sessions = {
    create: () => {
      throw new Error('no fixture in this spec should start a run');
    },
    cancel: async () => {},
  };
  return new TasksService(db as unknown as PrismaService, sessions as never, realtime as never);
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "project_event", "project_decision", "project_action", "project_blocker",
             "project_runtime", "task_verification_failure", "task_dependency", "task",
             "session", "project_member", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

test('a verification verdict reaches production through the reconcile pass',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    await emptyWorld(identity);

    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const events = new ProjectEventsService(prisma);
    const decisions = new ProjectDecisionService(prisma);
    const reconciler = new ProjectReconcileService(prisma, events, decisions);
    const verdicts = new ProjectVerificationVerdictService(prisma, reconciler);
    const projects = new ProjectsService(prisma, {} as unknown as SessionsService);
    const tasks = tasksService(db);
    const unregisterHandler = events.registerHandler(reconciler);
    // THE line under test. `ProjectsModule` provides this service, so Nest calls this at boot; the
    // defect this file was written for is that until now `onModuleInit` did not exist and nothing
    // else reached the verdict effect either.
    verdicts.onModuleInit();

    t.after(async () => {
      verdicts.onModuleDestroy();
      unregisterHandler();
      await db.$disconnect();
      await identity.end();
    });

    try {
      await t.test('FAIL: the subject is reverted, a defect is filed and downstream is blocked',
        async () => {
          const target = await fixture(db, 'fail', {
            s: { status: TaskStatus.DONE },
            d: { dependsOn: ['s'] },
            v: { verifies: 's' },
          });
          await conclude(tasks, target, 'v', TaskVerdict.FAIL);
          await settle(events, reconciler);

          const subject = await db.task.findUniqueOrThrow({ where: { id: target.ids.s } });
          assert.equal(subject.status, 'OPEN', 'the native revert, with nobody applying it');

          const filed = await defects(db, target);
          assert.equal(filed.length, 1, 'exactly one defect subtask');
          assert.equal(filed[0].parentTaskId, target.ids.s, 'filed under the subject');
          assert.equal(filed[0].status, 'OPEN');

          const failures = await db.taskVerificationFailure.findMany({
            where: { projectId: target.projectId },
          });
          assert.equal(failures.length, 1, 'one unresolved condition row');
          assert.equal(failures[0].resolvedAt, null);
          assert.equal(failures[0].blocksDownstream, true);
          assert.equal(failures[0].verifierTaskId, target.ids.v);
          assert.equal(failures[0].subjectTaskId, target.ids.s);
          assert.equal(failures[0].defectTaskId, filed[0].id);
          assert.ok(failures[0].raisedByActionId, 'the row names the action that raised it');

          // The ledger row, and its lineage: a permanent key carrying the REVISION, attributed to
          // the decision that proposed it. Not a write somebody made outside the protocol.
          const actions = await verdictActions(db, target.projectId);
          assert.equal(actions.length, 1);
          assert.equal(actions[0].status, 'APPLIED');
          assert.equal(
            actions[0].idempotencyKey,
            verificationVerdictActionKey(target.projectId, target.ids.v, '1'),
          );
          assert.ok(actions[0].decisionId, 'the action is attributed to a decision');
          assert.equal(actions[0].id, failures[0].raisedByActionId);

          // AC6's read face, which was structurally empty before this: `failures` and
          // `blockedTasks`, with the two reasons §13.2 gives them.
          const surface = await projects.verifications(target.ownerId, target.projectId);
          assert.equal(surface.failures.length, 1);
          assert.equal(surface.failures[0].verdict, 'FAIL');
          assert.equal(surface.failures[0].verdictRevision, '1');
          assert.equal(surface.failures[0].actionStatus, 'APPLIED');
          const blocked = surface.blockedTasks
            .map((row) => `${row.taskId}:${row.reason}`)
            .sort();
          assert.deepEqual(blocked, [
            `${target.ids.d}:UPSTREAM`,
            `${target.ids.s}:SUBJECT_DEFECT_OPEN`,
          ].sort(), 'the subject holds on its open defect, its dependant on the failure itself');
          // AC1. `failureId` is the one id in this payload `PublicIdInterceptor` cannot reach —
          // it is not a field name the codec classifies — so the read publicizes it itself, the
          // way `ProjectAuthorizationService` does for its copy of the same row. Everything else
          // here is still raw at this layer because the interceptor is an HTTP concern and this
          // test calls the service directly; over the wire both spellings come out Base62.
          // Unreachable before this pass existed, because the list was always empty.
          for (const row of surface.blockedTasks) {
            assert.doesNotMatch(
              row.failureId,
              /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
              'failureId is not a raw uuid',
            );
            assert.equal(base62ToUuid(row.failureId), surface.failures[0].id,
              'and it decodes back to the failure row it names');
          }
        });

      await t.test('the same conclusion, delivered again, lands exactly once (V2)', async () => {
        const target = await fixture(db, 'replay', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await conclude(tasks, target, 'v', TaskVerdict.FAIL);
        await settle(events, reconciler);

        const before = {
          actions: (await verdictActions(db, target.projectId)).length,
          defects: (await defects(db, target)).length,
          failures: await db.taskVerificationFailure.count({ where: { projectId: target.projectId } }),
        };
        assert.deepEqual(before, { actions: 1, defects: 1, failures: 1 });

        // Somebody re-completes the subject — the exact move a replay of this verdict would undo a
        // second time if the ledger were not carrying the key.
        await db.task.update({
          where: { id: target.ids.s },
          data: { status: TaskStatus.DONE },
        });
        await settle(events, reconciler);
        await settle(events, reconciler);

        assert.deepEqual({
          actions: (await verdictActions(db, target.projectId)).length,
          defects: (await defects(db, target)).length,
          failures: await db.taskVerificationFailure.count({ where: { projectId: target.projectId } }),
        }, before, 'nothing was applied twice');
        const subject = await db.task.findUniqueOrThrow({ where: { id: target.ids.s } });
        assert.equal(subject.status, 'DONE', 'and the re-completion was not reverted again');
      });

      await t.test('a later PASS resolves the failure and empties the blocked list', async () => {
        const target = await fixture(db, 'pass', {
          s: { status: TaskStatus.DONE },
          d: { dependsOn: ['s'] },
          v: { verifies: 's' },
          w: { verifies: 's' },
        });
        await conclude(tasks, target, 'v', TaskVerdict.FAIL);
        await settle(events, reconciler);
        assert.equal(
          (await projects.verifications(target.ownerId, target.projectId)).blockedTasks.length,
          2,
        );

        // A second, independent check on the same subject concludes that the claim now holds.
        await conclude(tasks, target, 'w', TaskVerdict.PASS);
        await settle(events, reconciler);

        const failures = await db.taskVerificationFailure.findMany({
          where: { projectId: target.projectId },
        });
        assert.equal(failures.length, 1, 'a PASS raises no condition of its own');
        assert.ok(failures[0].resolvedAt, 'the failure is resolved');
        assert.equal(failures[0].resolvedByTaskId, target.ids.w, 'by the check that passed');

        const surface = await projects.verifications(target.ownerId, target.projectId);
        assert.deepEqual(surface.blockedTasks, [], 'nothing is held any more');
        assert.equal(surface.failures[0].resolvedByTaskId, target.ids.w);
      });

      await t.test('the same check failing a second time happens again in full (V4/V7)',
        async () => {
          const target = await fixture(db, 'again', {
            s: { status: TaskStatus.DONE },
            v: { verifies: 's' },
          });
          await conclude(tasks, target, 'v', TaskVerdict.FAIL);
          await settle(events, reconciler);
          await conclude(tasks, target, 'v', TaskVerdict.PASS);
          await settle(events, reconciler);

          // Fixed, re-completed, checked again — and the check fails again. Keyed on the verdict
          // VALUE this would collide with the first FAIL and do nothing at all.
          await db.task.update({ where: { id: target.ids.s }, data: { status: TaskStatus.DONE } });
          await settle(events, reconciler);
          await conclude(tasks, target, 'v', TaskVerdict.FAIL);
          await settle(events, reconciler);

          const subject = await db.task.findUniqueOrThrow({ where: { id: target.ids.s } });
          assert.equal(subject.status, 'OPEN', 'reverted again');
          assert.equal((await defects(db, target)).length, 2, 'a second defect subtask');
          const failures = await db.taskVerificationFailure.findMany({
            where: { projectId: target.projectId },
            orderBy: { verdictRevision: 'asc' },
          });
          assert.equal(failures.length, 2);
          assert.ok(failures[0].resolvedAt, 'the first failure stays resolved');
          assert.equal(failures[1].resolvedAt, null, 'the second one is open');
          assert.deepEqual(
            (await verdictActions(db, target.projectId)).map((row) => row.status),
            ['APPLIED', 'APPLIED', 'APPLIED'],
            'three conclusions, three permanent keys',
          );
        });

      await t.test('two conclusions apply one per pass, and the loop comes back for the second',
        async () => {
          const target = await fixture(db, 'pair', {
            s1: { status: TaskStatus.DONE },
            s2: { status: TaskStatus.DONE },
            v1: { verifies: 's1' },
            v2: { verifies: 's2' },
          });
          await conclude(tasks, target, 'v1', TaskVerdict.FAIL);
          await conclude(tasks, target, 'v2', TaskVerdict.FAIL);

          // One delivery. Two verdicts are due and the pass may write only one of them: the first
          // one's task rows are inside this transaction's own snapshot, so a second action
          // attributed to the same decision would be refused STALE_SNAPSHOT by it (§7.7).
          const delivered = await events.drainOnce();
          assert.equal(delivered.status, 'CONSUMED');
          assert.equal((await verdictActions(db, target.projectId)).length, 1,
            'exactly one conclusion per reconcile');
          const runtime = await db.projectRuntime.findUniqueOrThrow({
            where: { projectId: target.projectId },
          });
          assert.ok(runtime.nextWakeAt, 'the loop scheduled itself for the rest');
          assert.match(String(runtime.nextWakeReason), /verification verdict/);

          await settle(events, reconciler);
          assert.deepEqual(
            (await verdictActions(db, target.projectId)).map((row) => row.status),
            ['APPLIED', 'APPLIED'],
            'both conclusions landed without anybody driving them',
          );
          const subjects = await db.task.findMany({
            where: { id: { in: [target.ids.s1, target.ids.s2] } },
            select: { status: true },
          });
          assert.deepEqual(subjects.map((row) => row.status), ['OPEN', 'OPEN']);
          assert.equal((await defects(db, target)).length, 2);
        });

      // ---- `[K5]` criterion 7: applying a conclusion is bounded, and the bound is visible ----
      //
      // The action key is PERMANENT (§8.2), and until this unit `pendingVerificationVerdicts`
      // treated the mere existence of a row at that key as "already handled". A refusal that was a
      // RACE — a snapshot that moved under the apply — therefore consumed the key for ever: DEP4's
      // gate stayed `VERDICT_NOT_APPLIED`, every dependent stayed blocked, and no pass could
      // propose the action again. The loop woke on its timer and had nothing it could do.
      //
      // Injected as the durable row the executor itself writes for that case, because that is the
      // state a person would find on disk. Nothing here reaches into the effect.
      let injectedDecisionId: string | null = null;
      const injectRefusal = async (target: Fixture, verifier: string, attempt: number) => {
        const revision = (await db.task.findUniqueOrThrow({
          where: { id: target.ids[verifier] },
        })).verdictRevision;
        // Attributed to a REAL decision, which is the half a hand-built row gets wrong and the
        // half that matters: migration 0120 freezes `decision_id` once it is set, so a retry that
        // moved the lineage would be refused by the database. A refusal with a null decision would
        // have let exactly that bug through this test.
        const decision = await db.projectDecision.findFirst({
          where: { projectId: target.projectId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        assert.ok(decision, 'the loop wrote no decision to attribute the refusal to');
        injectedDecisionId = decision.id;
        await db.projectAction.create({
          data: {
            projectId: target.projectId,
            idempotencyKey: verificationVerdictActionKey(
              target.projectId, target.ids[verifier], String(revision),
            ),
            type: 'APPLY_VERIFICATION_VERDICT',
            status: 'REFUSED',
            subjectType: 'TASK',
            subjectId: target.ids[verifier],
            fencingToken: 1n,
            decisionId: decision.id,
            refusalCode: 'STALE_SNAPSHOT',
            reasonCode: 'STALE_SNAPSHOT',
            detail: { v: 1, verdictApplyAttempt: attempt },
          },
        });
      };

      await t.test('a refusal that was a race is retried, and the gate clears', async () => {
        const target = await fixture(db, 'retry', {
          s: { status: TaskStatus.DONE },
          d: { dependsOn: ['s'] },
          v: { verifies: 's' },
        });
        await settledRun(db, target, 'v');
        // One pass before the conclusion exists, so the refusal below can be attributed to a real
        // judgment — which is what a refusal in production always is.
        await settle(events, reconciler);
        await conclude(tasks, target, 'v', TaskVerdict.PASS);
        await injectRefusal(target, 'v', 1);

        await settle(events, reconciler);

        const [action] = await verdictActions(db, target.projectId);
        assert.equal(action.status, 'APPLIED', 'the conclusion was never made durable');
        // ONE row, not two: the retry re-claims the permanent key rather than minting a second.
        assert.equal((await verdictActions(db, target.projectId)).length, 1);
        assert.equal(verdictApplyAttempt(action.detail), 2, 'the attempt was not counted');
        // 0120's lineage is history: the retry records which decision drove it in `detail` rather
        // than re-pointing the row, which the database would refuse outright.
        assert.equal(action.decisionId, injectedDecisionId, 'the retry moved the decision lineage');
        // …and DEP4 is satisfied, which is the whole point of applying it.
        const epochs = await loadVerificationEpochGates(db as never, [target.ids.s]);
        assert.equal(epochs.get(target.ids.s)?.gate, null, 'the epoch did not open');
      });

      await t.test('the retry is BOUNDED, and a spent budget is not tried again', async () => {
        const target = await fixture(db, 'bounded', {
          s: { status: TaskStatus.DONE },
          v: { verifies: 's' },
        });
        await settledRun(db, target, 'v');
        await settle(events, reconciler);
        await conclude(tasks, target, 'v', TaskVerdict.PASS);
        // The state three failed attempts leave behind.
        await injectRefusal(target, 'v', VERDICT_APPLY_MAX_ATTEMPTS);

        for (let round = 0; round < 4; round += 1) await settle(events, reconciler);

        const [action] = await verdictActions(db, target.projectId);
        assert.equal(action.status, 'REFUSED', 'a spent budget bought another attempt');
        assert.equal(verdictApplyAttempt(action.detail), VERDICT_APPLY_MAX_ATTEMPTS);
        // `refusal_code` still says what went wrong; `reason_code` says which bucket it ended in.
        assert.equal(action.refusalCode, 'STALE_SNAPSHOT', 'the audit lost why it failed');
        assert.equal(action.reasonCode, VERDICT_APPLY_EXHAUSTED);
      });

      await t.test('an exhausted apply escalates: one row, an owner, and a clock', async () => {
        const target = await fixture(db, 'escalate', {
          s: { status: TaskStatus.DONE },
          d: { dependsOn: ['s'] },
          v: { verifies: 's' },
        });
        await settledRun(db, target, 'v');
        await settle(events, reconciler);
        await conclude(tasks, target, 'v', TaskVerdict.PASS);
        await injectRefusal(target, 'v', VERDICT_APPLY_MAX_ATTEMPTS);

        // The stamp is written inside a pass whose snapshot was taken before it, so the row lands
        // on the pass AFTER — one wake, which is the bound this escalation is quick within. Three
        // wakes rather than one, because "it appears" and "it appears once" are two claims.
        for (let wake = 1; wake <= 3; wake += 1) {
          await reconciler.tick(new Date(Date.now() + wake * 120_000));
          for (let i = 0; i < 20; i += 1) {
            const result = await events.drainOnce();
            if (result.status === 'IDLE' || result.status === 'NO_HANDLER'
              || result.status === 'DEFERRED') break;
          }
        }

        const blockers = await db.projectBlocker.findMany({
          where: { projectId: target.projectId },
        });
        assert.equal(blockers.length, 1, 'a pass per wake would be one row per wake');
        const [blocker] = blockers;
        assert.equal(blocker.kind, 'VERDICT_APPLY_EXHAUSTED');
        // The check, not the subject: two checks of one subject can each get stuck, and a row per
        // subject would collapse them into one sentence naming the wrong verifier.
        assert.equal(blocker.subjectId, target.ids.v);
        assert.equal(blocker.dedupeKey, `VERDICT_APPLY_EXHAUSTED:TASK:${target.ids.v}`);
        assert.equal(blocker.owner, 'USER');
        assert.equal(blocker.recovery, 'HUMAN');
        assert.ok((blocker.requiredAction ?? '').length > 40, 'no sentence anybody can act on');
        assert.ok(blocker.nextCheckAt, 'no clock: nothing would ever look at it again');

        // …and the epoch says the same thing in its own vocabulary, so a dependent reads
        // BLOCKED_FAILED rather than an ordinary wait it will never come out of.
        const epochs = await loadVerificationEpochGates(db as never, [target.ids.s]);
        assert.equal(epochs.get(target.ids.s)?.gate, 'VERDICT_NOT_APPLIED');
        assert.equal(epochs.get(target.ids.s)?.stalled, true, 'a permanent wait read as a wait');

        // And the row CLEARS when a person does what it asked. This is the half that decides
        // whether the escalation is an instruction or an ornament: the required action is "revoke
        // and re-record the verdict", which advances `verdict_revision` — so the stuck action's
        // key stops being this revision's key, the condition stops holding, and BL3 resolves it.
        // Keyed off the ACTION table instead, the spent row would outlive every fix.
        await tasks.update(target.ownerId, target.ids.v, { verdict: null } as never);
        await conclude(tasks, target, 'v', TaskVerdict.PASS);
        for (let wake = 4; wake <= 6; wake += 1) {
          await reconciler.tick(new Date(Date.now() + wake * 120_000));
          for (let i = 0; i < 20; i += 1) {
            const result = await events.drainOnce();
            if (result.status === 'IDLE' || result.status === 'NO_HANDLER'
              || result.status === 'DEFERRED') break;
          }
        }
        const after = await db.projectBlocker.findMany({
          where: { projectId: target.projectId, kind: 'VERDICT_APPLY_EXHAUSTED' },
        });
        assert.deepEqual(after.map((b) => b.resolvedAt !== null), [true],
          'the escalation outlived the fix it asked for');
        // …and the new revision's apply is a fresh key, so the conclusion actually lands.
        const reopened = await loadVerificationEpochGates(db as never, [target.ids.s]);
        assert.equal(reopened.get(target.ids.s)?.gate, null, 'the epoch never reopened');
      });

      await t.test('a restart and a redelivery do not turn one retry into two applies',
        async () => {
          // The two ways an exactly-once claim is usually lost. The retry re-claims a PERMANENT
          // key, so if it were reachable from `APPLIED` — or if a fresh process could not see the
          // attempt the old one spent — a redelivery would apply §13.2's consequences twice: the
          // subject reverted again, a second defect, a second failure row.
          const target = await fixture(db, 'restart', {
            s: { status: TaskStatus.DONE },
            d: { dependsOn: ['s'] },
            v: { verifies: 's' },
          });
          await settledRun(db, target, 'v');
          await settle(events, reconciler);
          await conclude(tasks, target, 'v', TaskVerdict.FAIL);
          await injectRefusal(target, 'v', 1);
          await settle(events, reconciler);

          const applied = (await verdictActions(db, target.projectId))[0];
          assert.equal(applied.status, 'APPLIED');
          const before = {
            actions: (await verdictActions(db, target.projectId)).length,
            attempt: verdictApplyAttempt(applied.detail),
            defects: (await defects(db, target)).length,
            failures: await db.taskVerificationFailure.count({
              where: { projectId: target.projectId },
            }),
          };
          assert.deepEqual(before, { actions: 1, attempt: 2, defects: 1, failures: 1 });

          // A RESTART: nothing of the loop's in-memory state survives, only what it committed.
          const events2 = new ProjectEventsService(prisma);
          const decisions2 = new ProjectDecisionService(prisma);
          const reconciler2 = new ProjectReconcileService(prisma, events2, decisions2);
          const verdicts2 = new ProjectVerificationVerdictService(prisma, reconciler2);
          const unregister2 = events2.registerHandler(reconciler2);
          verdicts2.onModuleInit();
          try {
            // …and a REDELIVERY: somebody re-completes the subject, which is exactly what a second
            // application of this FAIL would undo a second time.
            await db.task.update({
              where: { id: target.ids.s },
              data: { status: TaskStatus.DONE },
            });
            await settle(events2, reconciler2);
            await settle(events2, reconciler2);
          } finally {
            verdicts2.onModuleDestroy();
            unregister2();
          }

          assert.deepEqual({
            actions: (await verdictActions(db, target.projectId)).length,
            attempt: verdictApplyAttempt(
              (await verdictActions(db, target.projectId))[0].detail,
            ),
            defects: (await defects(db, target)).length,
            failures: await db.taskVerificationFailure.count({
              where: { projectId: target.projectId },
            }),
          }, before, 'the retry path applied a conclusion twice');
          const subject = await db.task.findUniqueOrThrow({ where: { id: target.ids.s } });
          assert.equal(subject.status, 'DONE', 'the re-completion was reverted a second time');
        });

      await t.test('the boundary: a Project with the coordinator off has no loop to run this',
        async () => {
          // Not a hole this file is papering over — it is §AC11's protection, stated as a test.
          // A Project whose owner kept the coordinator OFF gets no dispatch, no blockers and no
          // reconcile; §13.2 is one of the loop's consequences, and reverting a DONE task inside a
          // project that was promised it would not be automatically advanced is not a fix.
          const target = await fixture(db, 'manual', {
            s: { status: TaskStatus.DONE },
            v: { verifies: 's' },
          }, false);
          await conclude(tasks, target, 'v', TaskVerdict.FAIL);
          await settle(events, reconciler);

          const subject = await db.task.findUniqueOrThrow({ where: { id: target.ids.s } });
          assert.equal(subject.status, 'DONE');
          assert.equal((await verdictActions(db, target.projectId)).length, 0);
          assert.equal(
            await db.taskVerificationFailure.count({ where: { projectId: target.projectId } }),
            0,
          );
          // And the conclusion itself is not lost: the column holds it, so turning the coordinator
          // on applies it on the next pass rather than starting from nothing.
          const verifier = await db.task.findUniqueOrThrow({ where: { id: target.ids.v } });
          assert.equal(verifier.verdict, 'FAIL');
          assert.equal(String(verifier.verdictRevision), '1');

          await db.project.update({
            where: { id: target.projectId },
            data: { coordinatorEnabled: true },
          });
          await settle(events, reconciler);
          assert.equal(
            (await db.task.findUniqueOrThrow({ where: { id: target.ids.s } })).status,
            'OPEN',
            'switching the loop on applies the conclusion that was waiting',
          );
        });
    } finally {
      await db.$disconnect().catch(() => undefined);
    }
  });
