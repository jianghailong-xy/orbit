import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunStatus,
  RunnerStatus,
  TaskCompletionPolicy,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  createDecisionId,
  planProjectDecision,
  ProjectDecisionService,
} from './project-decision.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService } from './project-reconcile.service';
import { ProjectTaskDispatcherService } from './project-task-dispatcher.service';
import { openBlockersStoppingDispatch } from './project-blocker-guard';
import { prismaClientFor } from '../prisma/prisma-client';

/**
 * Unit 18: independent verification of units 15–17 against a real, private PostgreSQL server.
 *
 * The three units each proved their own half. What no single one of them owns is the CLOSED LOOP
 * between them — a blocker whose condition is written by the dispatch ledger, guarded by a rule
 * that decides whether the ledger can ever say anything else. The first scenario here is the
 * counterexample that found: a `recovery = EVENT` blocker that §11.2 says the world can end on its
 * own, which the guard made impossible to falsify.
 *
 * Destructive: it refuses to run anywhere but the disposable server (coordinator-pg-test-safety).
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Services {
  db: PrismaClient;
  events: ProjectEventsService;
  decisions: ProjectDecisionService;
  reconciler: ProjectReconcileService;
  dispatcher: ProjectTaskDispatcherService;
}

interface Fixture {
  ownerId: string;
  projectId: string;
  agentId: string;
  runnerId: string;
  taskId: string;
}

function servicesOn(db: PrismaClient): Services {
  const prisma = db as unknown as PrismaService;
  const events = new ProjectEventsService(prisma);
  const decisions = new ProjectDecisionService(prisma);
  const reconciler = new ProjectReconcileService(prisma, events, decisions);
  const dispatcher = new ProjectTaskDispatcherService(
    prisma,
    reconciler,
    new ProjectAuthorizationService(),
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    { publishSessionCreated: () => undefined } as unknown as RealtimeService,
  );
  return { db, events, decisions, reconciler, dispatcher };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "project_blocker", "project_event", "project_decision", "project_action",
             "project_runtime", "project_member", "task_verification_failure", "task", "session",
             "workspace", "runner", "model_provider", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function fixture(
  db: PrismaClient,
  label: string,
  options: { provider?: string; runnerStatus?: RunnerStatus; assign?: boolean } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc18.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x',
      status: options.runnerStatus ?? RunnerStatus.ONLINE,
      capabilities: ['session-orchestration-credential-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: label, coordinatorEnabled: true,
      automationPolicy: ProjectAutomationPolicy.AUTO, maxConcurrentTasks: 3,
    },
  });
  await db.projectMember.create({
    data: { projectId, agentId, role: ProjectRole.COORDINATOR },
  });
  await db.task.create({
    data: {
      id: taskId, ownerId, projectId,
      assigneeId: options.assign === false ? null : agentId,
      title: `${label}-task`, creatorType: CreatorType.USER, creatorId: ownerId,
      provider: options.provider ?? 'codex',
    },
  });
  return { ownerId, projectId, agentId, runnerId, taskId };
}

/** Plan and execute one real dispatch, exactly as the loop would. Returns the refusal code. */
async function attemptDispatch(
  services: Services,
  target: Fixture,
  attempt: number,
): Promise<string | null> {
  const lease = await services.reconciler.acquireLease(target.projectId);
  assert.ok(lease, 'the fixture Project must be leasable');
  const decisionId = createDecisionId();
  const idempotencyKey = `pc:v1:${target.projectId}:dispatch:${target.taskId}:${attempt}`;
  await services.db.$transaction(async (tx) => {
    const captured = await services.decisions.capture(tx, target.projectId);
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: [{
        type: 'DISPATCH_TASK',
        idempotencyKey,
        subject: { type: 'TASK', id: uuidToBase62(target.taskId) },
      }],
    });
    await services.decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const result = await services.dispatcher.dispatch(lease!, {
    decisionId, taskId: target.taskId, idempotencyKey,
  });
  await services.reconciler.releaseLease(lease!);
  const action = await services.db.projectAction.findUniqueOrThrow({
    where: { id: result.action.actionId },
  });
  return action.reasonCode;
}

/** One delivery of the real loop: capture, plan, publish blockers, publish the runtime row. */
async function reconcile(services: Services, target: Fixture): Promise<void> {
  await services.db.$transaction(
    async (tx) => services.reconciler.handle(tx, target.projectId, []),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

async function blockers(db: PrismaClient, projectId: string): Promise<Array<{
  kind: string; dedupeKey: string; generation: string; occurrences: number;
  resolvedAt: Date | null; resolvedBy: string | null; escalatedAt: Date | null;
}>> {
  const rows = await db.projectBlocker.findMany({
    where: { projectId },
    orderBy: [{ dedupeKey: 'asc' }, { lifecycleGeneration: 'asc' }],
  });
  return rows.map((row) => ({
    kind: row.kind,
    dedupeKey: row.dedupeKey,
    generation: String(row.lifecycleGeneration),
    occurrences: row.occurrences,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    escalatedAt: row.escalatedAt,
  }));
}

test('unit 18: the blocker loop closes on a real PostgreSQL', { skip, timeout: 240_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);
  const migrated = await identity.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM "_prisma_migrations"
     WHERE "migration_name" IN ('0123_task_completion_policy', '0124_task_verification_verdict',
                               '0125_project_blocker')
       AND "finished_at" IS NOT NULL
  `);
  assert.equal(migrated.rows[0]?.count, '3', 'the isolated database must carry migrations 0123-0125');
  await emptyWorld(identity);

  const services = servicesOn(prismaClientFor(URL));
  const unregister = services.events.registerHandler(services.reconciler);

  try {
    await t.test('§11.4 BL3: an EVENT blocker raised by a refusal clears when the world recovers',
      async () => {
        // No provider row exists for `pcc18-gone`, so the resolution chain refuses the dispatch with
        // PROVIDER_UNAVAILABLE — §11.2's row for it says `recovery = EVENT`: the world can end this
        // one without anybody's help.
        const target = await fixture(services.db, 'recover', { provider: `pcc18-gone-${randomUUID().slice(0, 8)}` });
        assert.equal(await attemptDispatch(services, target, 1), 'PROVIDER_UNAVAILABLE');
        await reconcile(services, target);
        const raised = await blockers(services.db, target.projectId);
        assert.equal(raised.length, 1, 'the refusal must open exactly one blocker');
        assert.equal(raised[0].kind, 'PROVIDER_UNAVAILABLE');
        assert.equal(raised[0].generation, '1');
        assert.equal(raised[0].resolvedAt, null);

        // While the outage lasts, a retry must be REFUSED AGAIN — with the real code, not with the
        // guard's own — and must not open a second episode. That is what makes the condition
        // recomputable without flapping `lifecycle_generation` once per tick.
        assert.equal(await attemptDispatch(services, target, 2), 'PROVIDER_UNAVAILABLE',
          'the guard must not hide the refusal that recomputes this blocker');
        await reconcile(services, target);
        const during = await blockers(services.db, target.projectId);
        assert.equal(during.length, 1, 'a repeat of the same cause must not open a second episode');
        assert.equal(during[0].generation, '1');
        assert.equal(during[0].resolvedAt, null);
        assert.ok(during[0].occurrences >= 2, 'the repeat must be visible on the display counter');

        // The world recovers: the provider is registered and enabled. Nothing tells the loop so —
        // §11.4 BL3 forbids clearing on an event — it has to find out by recomputing.
        await services.db.modelProvider.create({
          data: {
            slug: (await services.db.task.findUniqueOrThrow({ where: { id: target.taskId } })).provider!,
            label: 'unit 18 provider',
            runtime: 'codex',
            baseUrl: 'https://pcc18.invalid/v1',
            apiKeyEnc: 'iv:tag:ct',
            enabled: true,
            models: [{ value: 'gpt-test', label: 'gpt-test' }] as unknown as Prisma.InputJsonValue,
            defaultModel: 'gpt-test',
          },
        });
        const recovered = await attemptDispatch(services, target, 3);
        assert.notEqual(recovered, 'PROVIDER_UNAVAILABLE',
          'the dispatch must be re-litigated once the provider is back');
        assert.notEqual(recovered, 'PROJECT_BLOCKED',
          'a blocker the chain re-answers must not stop the attempt that would clear it');

        await reconcile(services, target);
        const after = await blockers(services.db, target.projectId);
        assert.equal(after.length, 1, 'clearing must resolve the row, never delete it (BE1)');
        assert.ok(after[0].resolvedAt, 'the blocker did not auto-clear after the world recovered');
        assert.equal(after[0].resolvedBy, 'AUTO', '§11.4: nobody did anything, the world changed');

        // §11.4 also requires run_state and the clock to be recomputed in the SAME pass.
        const runtime = await services.db.projectRuntime.findUniqueOrThrow({
          where: { projectId: target.projectId },
        });
        assert.notEqual(runtime.runState, 'BLOCKED',
          'the state must be recomputed in the pass that cleared the blocker, not on the next tick');
        assert.ok(runtime.nextWakeAt, 'an OPEN project that is no longer blocked still needs a clock');

        // BE1: a recurrence after a clear is a NEW episode, and MAX + 1 is why the row is kept.
        await services.db.modelProvider.updateMany({ where: {}, data: { enabled: false } });
        // Retire the Session rather than deleting it: `project_action.result_session_id` points at
        // it, and the ledger is append-only by design.
        await services.db.session.updateMany({
          where: { taskId: target.taskId },
          data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
        });
        await services.db.task.update({
          where: { id: target.taskId }, data: { status: TaskStatus.OPEN },
        });
        assert.equal(await attemptDispatch(services, target, 4), 'PROVIDER_UNAVAILABLE');
        await reconcile(services, target);
        const episodes = await blockers(services.db, target.projectId);
        assert.equal(episodes.length, 2, 'a recurrence must be a second row, not a revived one');
        assert.deepEqual(episodes.map((row) => row.generation), ['1', '2']);
        assert.ok(episodes[0].resolvedAt && !episodes[1].resolvedAt);
      });

    await t.test('the guard still stops every dispatch the resolution chain does NOT re-answer',
      async () => {
        const target = await fixture(services.db, 'guard');
        const other = randomUUID();
        await services.db.task.create({
          data: {
            id: other, ownerId: target.ownerId, projectId: target.projectId,
            assigneeId: target.agentId, title: 'other', creatorType: CreatorType.USER,
            creatorId: target.ownerId,
          },
        });
        const guard = async (taskId: string): Promise<string[]> => {
          const sql = openBlockersStoppingDispatch(target.projectId, taskId);
          const rows = await identity.query<{ kind: string }>(sql.text, sql.values as unknown[]);
          return rows.rows.map((row) => row.kind).sort();
        };
        const raise = async (kind: string, subjectType: string, subjectId: string) => {
          await identity.query(`
            INSERT INTO "project_blocker" (
              "id", "project_id", "kind", "owner", "recovery", "severity", "required_action",
              "next_check_at", "subject_type", "subject_id", "detail", "dedupe_key",
              "lifecycle_generation", "condition_version", "first_seen_at", "last_seen_at",
              "occurrences", "created_at", "updated_at")
            VALUES ($1::uuid, $2::uuid, $3, 'USER', 'HUMAN', 'CRITICAL', 'do the thing',
                    now(), $4, $5, '{}'::jsonb, $6, 1, 'v', now(), now(), 1, now(), now())
          `, [randomUUID(), target.projectId, kind, subjectType, subjectId,
            `${kind}:${subjectType}:${subjectId}`]);
        };

        assert.deepEqual(await guard(target.taskId), []);
        // A merge conflict, an exhausted retry budget, a failed check and an unclassified failure
        // are conditions §7.4 knows nothing about, so the row IS the gate.
        await raise('MERGE_CONFLICT', 'TASK', target.taskId);
        assert.deepEqual(await guard(target.taskId), ['MERGE_CONFLICT']);
        assert.deepEqual(await guard(other), [], 'a task-scoped row stops its own task only');
        await raise('UNKNOWN_FAILURE', 'TASK', other);
        assert.deepEqual(await guard(other), ['UNKNOWN_FAILURE'], 'BL2 must stop an unclassified failure');
        // A resolution-chain kind on a TASK is a description of the last answer; §7.4 gives the
        // next one, and stopping the attempt would freeze the condition (BL3).
        await raise('WHO_UNRESOLVED', 'TASK', other);
        assert.deepEqual(await guard(other), ['UNKNOWN_FAILURE'],
          'a chain-derived row must not gate the attempt that recomputes it');
        // A SESSION row belongs to one conversation and stops nothing else.
        await raise('AWAITING_USER_INPUT', 'SESSION', randomUUID());
        assert.deepEqual(await guard(other), ['UNKNOWN_FAILURE']);
        // A PROJECT row stops everything, chain-derived or not.
        await raise('NO_PROJECT_WORKSPACE', 'PROJECT', target.projectId);
        assert.deepEqual(await guard(other), ['NO_PROJECT_WORKSPACE', 'UNKNOWN_FAILURE']);
        assert.deepEqual(await guard(target.taskId), ['MERGE_CONFLICT', 'NO_PROJECT_WORKSPACE']);
      });

    await t.test('ES5: the same cause across a restart is one row, one episode, one notification',
      async () => {
        const target = await fixture(services.db, 'restart', { assign: false });
        assert.equal(await attemptDispatch(services, target, 1), 'WHO_UNRESOLVED');
        await reconcile(services, target);
        const first = await blockers(services.db, target.projectId);
        assert.equal(first.length, 1);
        const frozen = { ...first[0], occurrences: 0 };

        // A fresh set of services over a fresh client is what a process restart looks like from
        // the database's side: nothing in memory carries over.
        for (let delivery = 0; delivery < 4; delivery += 1) {
          const restarted = servicesOn(prismaClientFor(URL));
          await reconcile(restarted, target);
          await restarted.db.$disconnect();
        }
        const after = await blockers(services.db, target.projectId);
        assert.equal(after.length, 1, 'redelivery across restarts must not open a second episode');
        assert.deepEqual({ ...after[0], occurrences: 0 }, frozen,
          'a column ES5 freezes moved with the number of deliveries');
        const escalations = await services.db.projectEvent.count({
          where: { projectId: target.projectId, kind: 'blocker.escalated' },
        });
        assert.equal(escalations, 0, 'nothing was due, so nothing may have been escalated');
        const raises = await services.db.projectAction.count({
          where: { projectId: target.projectId, type: 'RAISE_BLOCKER' },
        });
        assert.equal(raises, 1, 'BE3: one key per row, however many times the cause was delivered');
      });

    await t.test('§13.1 + §13.2: a revoked verdict rolls the whole chain back through the outbox',
      async () => {
        const target = await fixture(services.db, 'verdict');
        const ids = {
          root: randomUUID(), mid: randomUUID(), leaf: randomUUID(), verifier: randomUUID(),
        };
        for (const [name, id] of Object.entries(ids)) {
          await services.db.task.create({
            data: {
              id, ownerId: target.ownerId, projectId: target.projectId, title: name,
              creatorType: CreatorType.USER, creatorId: target.ownerId,
              status: name === 'verifier' ? TaskStatus.DONE : TaskStatus.OPEN,
              parentTaskId: name === 'mid' ? ids.root : name === 'leaf' ? ids.mid : null,
              completionPolicy: name === 'root'
                ? TaskCompletionPolicy.VERIFICATION_PASSED
                : name === 'mid'
                  ? TaskCompletionPolicy.ALL_CHILDREN_DONE
                  : TaskCompletionPolicy.MANUAL,
              verifiesTaskId: name === 'verifier' ? ids.root : null,
              verdict: name === 'verifier' ? TaskVerdict.PASS : null,
            },
          });
        }
        await services.db.task.update({
          where: { id: ids.leaf }, data: { status: TaskStatus.DONE },
        });
        for (let pass = 0; pass < 12; pass += 1) {
          const result = await services.events.drainOnce();
          if (result.status === 'IDLE' || result.status === 'NO_HANDLER') break;
          assert.notEqual(result.status, 'DEAD');
        }
        const settled = await services.db.task.findMany({
          where: { id: { in: [ids.root, ids.mid] } }, select: { id: true, status: true },
        });
        assert.deepEqual(settled.sort((a, b) => (a.id < b.id ? -1 : 1)).map((row) => row.status).sort(),
          ['DONE', 'DONE'],
          'a leaf finishing must settle the whole chain above it, verification included');

        // Revoking the PASS is the case §13.1 AG3 exists for: the parent asserted a completion its
        // own evidence no longer supports.
        await services.db.task.update({
          where: { id: ids.verifier }, data: { verdict: null },
        });
        for (let pass = 0; pass < 12; pass += 1) {
          const result = await services.events.drainOnce();
          if (result.status === 'IDLE' || result.status === 'NO_HANDLER') break;
          assert.notEqual(result.status, 'DEAD');
        }
        const root = await services.db.task.findUniqueOrThrow({ where: { id: ids.root } });
        const mid = await services.db.task.findUniqueOrThrow({ where: { id: ids.mid } });
        assert.equal(root.status, TaskStatus.OPEN, 'a revoked verdict must reopen its subject');
        assert.equal(mid.status, TaskStatus.DONE,
          'the level below is still finished; only the level the verdict answered for rolls back');
      });
  } finally {
    unregister();
    await services.db.$disconnect();
    await identity.end();
  }
});
