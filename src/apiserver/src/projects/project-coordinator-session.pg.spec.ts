import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  Prisma,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import {
  createDecisionId,
  planProjectDecision,
  ProjectDecisionOutcome,
  ProjectDecisionService,
} from './project-decision.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectEventsService } from './project-events.service';
import {
  ProjectLeaseLostError,
  ProjectReconcileLease,
  ProjectReconcileService,
} from './project-reconcile.service';
import { ProjectCoordinatorSessionService } from './project-coordinator-session.service';
import {
  PlannedCoordinatorRotation,
  rotateCoordinatorSessionIdempotencyKey,
} from './project-coordinator-session';

// §7.5 · §8.4 · §12.4 on a real PostgreSQL server, against a DISPOSABLE one.
//
// Everything asserted here is a property of the DATABASE and of the committed sequence, not of the
// planner: the trigger that makes a coordinator session's death visible at all, the guards that
// decide what a coordinator pointer may name whichever binary writes it, the fence that makes a
// replaced process physically unable to rotate, and the one-transaction clear-and-write that keeps
// `coordinator_session_id`'s unique index from stranding a project with no coordinator.
//
// The server is disposable and proved so before the first write (`coordinator-pg-test-safety.ts`).
// It must carry the whole migration chain, which is how this suite also covers "the compat window
// is migratable": `prisma migrate deploy` against an empty database, then this.
//
//   docker run -d --name pcc19-pg16 -e POSTGRES_USER=pcc19_admin -e POSTGRES_PASSWORD=… \
//     -e POSTGRES_DB=pcc19_rotation -p 127.0.0.1:55619:5432 postgres:16-alpine
//   psql … -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public'
//   DATABASE_URL=… npx prisma migrate deploy
//   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_{DATABASE,USER,SYSTEM_IDENTIFIER}=… \
//     node --test build/projects/project-coordinator-session.pg.spec.js

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  otherWorkspaceId: string;
  runnerId: string;
  coordinatorSessionId: string;
}

async function fixture(
  db: PrismaClient,
  label: string,
  options: {
    policy?: ProjectAutomationPolicy;
    coordinatorStatus?: RunStatus;
    coordinatorEnabled?: boolean;
  } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc19.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x',
      status: RunnerStatus.ONLINE,
      capabilities: ['session-orchestration-credential-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  for (const [id, name] of [[workspaceId, 'landing'], [otherWorkspaceId, 'elsewhere']] as const) {
    await db.workspace.create({
      data: {
        id, ownerId, runnerId, name: `${label}-${name}`, enabled: true,
        canCreateTasks: true, canDelegate: true,
      },
    });
  }
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId,
      assignedRunnerId: runnerId, title: `协调：${label}`, prompt: 'coordinate',
      status: options.coordinatorStatus ?? RunStatus.RUNNING,
      provider: 'claude', providerBuiltin: true, usesRuntimeDefaultModel: true, source: 'user',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: label,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      automationPolicy: options.policy ?? ProjectAutomationPolicy.GUARDED_AUTO,
      coordinatorSessionId, coordinatorWorkspaceId: workspaceId,
    },
  });
  // 0112/0113's AFTER INSERT trigger writes `project_runtime` and seats the coordinator from the
  // landing, so creating either here would collide rather than set anything up.
  await db.projectRuntime.findUniqueOrThrow({ where: { projectId } });
  const seat = await db.projectMember.findFirstOrThrow({
    where: { projectId, role: ProjectRole.COORDINATOR },
  });
  assert.equal(seat.agentId, workspaceId, 'the landing seats the coordinator identity');
  return { ownerId, projectId, workspaceId, otherWorkspaceId, runnerId, coordinatorSessionId };
}

/** Capture, plan and persist one decision, exactly as a reconcile pass does. */
async function decide(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  projectId: string,
  overrideActions?: ProjectDecisionOutcome['actions'],
): Promise<{ decisionId: string; outcome: ProjectDecisionOutcome }> {
  const decisionId = createDecisionId();
  const outcome = await db.$transaction(async (tx) => {
    const captured = await decisions.capture(tx, projectId);
    const planned = planProjectDecision(captured.input, {
      decisionId,
      ...(overrideActions ? { actions: overrideActions } : {}),
    });
    await decisions.persist(tx, captured, planned, decisionId);
    return planned;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { decisionId, outcome };
}

function rotation(outcome: ProjectDecisionOutcome): PlannedCoordinatorRotation {
  assert.equal(outcome.coordinator?.status, 'ROTATE', 'this snapshot must plan a rotation');
  return outcome.coordinator as PlannedCoordinatorRotation;
}

async function leaseFor(
  reconciler: ProjectReconcileService,
  projectId: string,
): Promise<ProjectReconcileLease> {
  const lease = await reconciler.acquireLease(projectId);
  assert.ok(lease, 'the project must be leasable');
  return lease;
}

/**
 * A lease, then a decision made under it — in that order, always.
 *
 * Acquiring a lease advances `fencing_token`, and the token is part of the snapshot (§6.1 S3), so a
 * decision captured BEFORE the lease describes a world that has since moved and every action
 * claimed against it is correctly refused `STALE_SNAPSHOT`. That is the §7.7 gate working; it is
 * also the reason a takeover re-plans instead of finishing the loser's plan (§8.4 Y1).
 */
async function planUnderLease(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  reconciler: ProjectReconcileService,
  projectId: string,
): Promise<{ lease: ProjectReconcileLease; decisionId: string; outcome: ProjectDecisionOutcome }> {
  const lease = await leaseFor(reconciler, projectId);
  return { lease, ...(await decide(db, decisions, projectId)) };
}

/**
 * Capture and plan without persisting — for the cases where only the JUDGMENT is under test.
 *
 * A persisted decision must carry the fencing token of a lease that was actually held
 * (`project_decision_fencing_token_chk`), and a project that is out of the loop cannot be leased at
 * all. Reading what it decides about such a project is still meaningful; writing an audit row for a
 * pass that never ran would not be.
 */
async function planOnly(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  projectId: string,
): Promise<ProjectDecisionOutcome> {
  return db.$transaction(async (tx) => {
    const captured = await decisions.capture(tx, projectId);
    return planProjectDecision(captured.input, { decisionId: createDecisionId() });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

async function rejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
    return true;
  });
}

test('Coordinator Session rotation, takeover and mixed-version compatibility on PostgreSQL',
  { skip: !URL, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const migrated = await identity.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM "_prisma_migrations"
       WHERE "migration_name" = '0126_project_coordinator_session_lifecycle'
         AND "finished_at" IS NOT NULL
    `);
    assert.equal(migrated.rows[0]?.count, '1', 'the isolated database must have migration 0126');

    const db = new PrismaClient({ datasources: { db: { url: URL } } });
    const prisma = db as unknown as PrismaService;
    const events = new ProjectEventsService(prisma);
    const decisions = new ProjectDecisionService(prisma);
    const reconciler = new ProjectReconcileService(prisma, events, decisions);
    const unregister = events.registerHandler(reconciler);
    const notifications: string[] = [];
    const rotations = new ProjectCoordinatorSessionService(
      prisma,
      reconciler,
      new ProjectAuthorizationService(),
      { notifySessionQueued: () => notifications.push('queue') } as unknown as QueueService,
      { publishSessionCreated: (id: string) => notifications.push(id) } as unknown as RealtimeService,
    );
    // The production wiring, so that a drain in this file rotates exactly as it does in the
    // orchestration service. The direct `rotate()` calls below are guard tests of the effect's own
    // re-checks; the DRIVER is proved in `project-coordinator-driver.pg.spec.ts`, which never calls
    // it at all.
    rotations.onModuleInit();

    try {
      // ── §8.4 · a run that ends wakes its project, and the loop opens the next one ────────────
      const normal = await fixture(db, 'normal');
      await db.session.update({
        where: { id: normal.coordinatorSessionId },
        data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
      });
      // Named by its source, not merely "the pending event": recording the project already
      // enqueued a `user.project_edited`, and a test that read whichever row came back first would
      // pass for the wrong reason.
      const woke = await db.projectEvent.findFirstOrThrow({
        where: {
          projectId: normal.projectId,
          consumedAt: null,
          sourceId: normal.coordinatorSessionId,
        },
      });
      assert.equal(woke.kind, 'session.ended');
      assert.equal(woke.sourceType, 'SESSION');

      assert.ok(await events.drainAvailable() >= 1);
      const consumed = await db.projectEvent.findUniqueOrThrow({ where: { id: woke.id } });
      assert.ok(consumed.consumedAt);
      assert.equal(consumed.disposition, 'RECONCILED');

      // One drain, and the rotation has happened — no second entry point was involved.
      const applied = await db.projectAction.findFirstOrThrow({
        where: { projectId: normal.projectId, type: 'ROTATE_COORDINATOR_SESSION' },
      });
      assert.equal(applied.status, 'APPLIED');
      const opened = await db.session.findUniqueOrThrow({ where: { id: applied.resultSessionId! } });
      assert.equal(opened.taskId, null);
      assert.equal(opened.workspaceId, normal.workspaceId, '§7.5 落点固定');
      assert.equal(opened.dispatchOrigin, SessionDispatchOrigin.PROJECT_COORDINATOR);
      assert.equal(opened.runSource, SessionRunSource.PROJECT_COORDINATOR);
      assert.equal(opened.status, RunStatus.PENDING);
      assert.ok(opened.resolution && opened.snapshotFrozenAt && opened.projectActionId);
      assert.deepEqual(notifications, ['queue', opened.id]);
      notifications.length = 0;

      const afterRotation = await db.project.findUniqueOrThrow({ where: { id: normal.projectId } });
      assert.equal(afterRotation.coordinatorSessionId, opened.id);
      assert.equal(afterRotation.coordinatorWorkspaceId, normal.workspaceId);
      const runtime = await db.projectRuntime.findUniqueOrThrow({
        where: { projectId: normal.projectId },
      });
      assert.equal(runtime.coordinatorGeneration, 1n, 'a rotation is counted exactly once');
      assert.equal(runtime.coordinatorSessionId, opened.id, 'the baseline moved with it');
      // Identity is stable across the rotation: same agent, same seat row, untouched.
      const seatAfter = await db.projectMember.findFirstOrThrow({
        where: { projectId: normal.projectId, role: ProjectRole.COORDINATOR },
      });
      assert.equal(seatAfter.agentId, normal.workspaceId);
      // The previous run is history, not garbage: append-only, never rewritten by a rotation.
      const previous = await db.session.findUniqueOrThrow({
        where: { id: normal.coordinatorSessionId },
      });
      assert.equal(previous.status, RunStatus.SUCCEEDED);
      assert.equal(previous.deletedAt, null);

      // §7.5 历史可追溯: the decision that planned it keeps the session that was current WHEN it
      // was made, so a rotated-away run is still the attribution of everything it decided.
      const decisionRow = await db.projectDecision.findUniqueOrThrow({
        where: { id: applied.decisionId! },
      });
      assert.equal(decisionRow.coordinatorSessionId, normal.coordinatorSessionId);
      assert.equal(decisionRow.coordinatorAgentId, normal.workspaceId);

      // ── §8.5 C2 · the out-of-loop entry lands on the row the loop already wrote ──────────────
      const replayLease = await leaseFor(reconciler, normal.projectId);
      const replayOutcome = (await db.projectDecision.findUniqueOrThrow({
        where: { id: applied.decisionId! },
      })).outcome as unknown as ProjectDecisionOutcome;
      const replay = await rotations.rotate(replayLease, {
        decisionId: applied.decisionId!,
        planned: rotation(replayOutcome),
      });
      assert.equal(replay.action.status, 'ALREADY_APPLIED');
      assert.equal(replay.sessionId, opened.id);
      assert.equal(await db.projectAction.count({
        where: { projectId: normal.projectId, type: 'ROTATE_COORDINATOR_SESSION' },
      }), 1);
      assert.equal(await reconciler.releaseLease(replayLease), true);

      // ── §8.4 · the replaced process cannot rotate, and leaves nothing behind ─────────────────
      const takeover = await fixture(db, 'takeover', { coordinatorStatus: RunStatus.FAILED });
      const loser = await planUnderLease(db, decisions, reconciler, takeover.projectId);
      // The crash, injected as the database would record it: the holder stopped heartbeating and
      // its lease lapsed. Both columns move together — `project_runtime_lease_shape_chk` (0119)
      // refuses an expiry that precedes its own heartbeat, which is what stops a "lease" that was
      // never really held from existing.
      const lapsed = new Date(Date.now() - 1_000);
      await db.projectRuntime.update({
        where: { projectId: takeover.projectId },
        data: { leaseExpiresAt: lapsed, leaseHeartbeatAt: lapsed },
      });
      const successor = await planUnderLease(db, decisions, reconciler, takeover.projectId);
      assert.equal(successor.lease.fencingToken, loser.lease.fencingToken + 1n);
      await assert.rejects(
        rotations.rotate(loser.lease, {
          decisionId: loser.decisionId, planned: rotation(loser.outcome),
        }),
        ProjectLeaseLostError,
      );
      assert.equal(await db.projectAction.count({ where: { projectId: takeover.projectId } }), 0,
        'a fenced-out rotation writes no ledger row');
      assert.equal(await db.session.count({
        where: { ownerId: takeover.ownerId, taskId: null, projectActionId: { not: null } },
      }), 0, 'and no session');
      assert.equal(
        (await db.project.findUniqueOrThrow({ where: { id: takeover.projectId } }))
          .coordinatorSessionId,
        takeover.coordinatorSessionId,
        'the pointer the successor inherited is untouched',
      );
      // §8.4 Y1: the successor recovers by looking at the world again, not by replaying the loser's
      // plan — and it completes the rotation the loser could not.
      const successorRotation = await rotations.rotate(successor.lease, {
        decisionId: successor.decisionId, planned: rotation(successor.outcome),
      });
      assert.equal(successorRotation.action.status, 'APPLIED');
      assert.ok(successorRotation.sessionId);
      assert.equal(await reconciler.releaseLease(successor.lease), true);

      // ── §7.7 · a plan whose world has moved is refused, with the reason on the ledger ────────
      const late = await fixture(db, 'late', { coordinatorStatus: RunStatus.CANCELLED });
      const latePlan = await planUnderLease(db, decisions, reconciler, late.projectId);
      await db.project.update({ where: { id: late.projectId }, data: { title: 'renamed' } });
      const staleResult = await rotations.rotate(latePlan.lease, {
        decisionId: latePlan.decisionId, planned: rotation(latePlan.outcome),
      });
      assert.equal(staleResult.action.status, 'REFUSED');
      assert.equal(staleResult.sessionId, null);
      assert.equal(
        (await db.projectAction.findUniqueOrThrow({ where: { id: staleResult.action.actionId } }))
          .refusalCode,
        'STALE_SNAPSHOT',
      );
      assert.equal(await reconciler.releaseLease(latePlan.lease), true);

      // The effect's own re-checks, reached by claiming a rotation that disagrees with a world that
      // has NOT moved — which is the shape a late reply from a replaced planner has.
      const disagree = await fixture(db, 'disagree', { coordinatorStatus: RunStatus.SUCCEEDED });
      const truth = await planUnderLease(db, decisions, reconciler, disagree.projectId);
      const wrongGeneration = await decide(db, decisions, disagree.projectId, [{
        type: 'ROTATE_COORDINATOR_SESSION',
        idempotencyKey: rotateCoordinatorSessionIdempotencyKey(uuidToBase62(disagree.projectId), '9'),
        subject: { type: 'PROJECT', id: uuidToBase62(disagree.projectId) },
      }]);
      const movedGeneration = await rotations.rotate(truth.lease, {
        decisionId: wrongGeneration.decisionId,
        planned: { ...rotation(truth.outcome), generation: '9' },
      });
      assert.equal(movedGeneration.action.status, 'REFUSED');
      assert.equal(
        (await db.projectAction.findUniqueOrThrow({ where: { id: movedGeneration.action.actionId } }))
          .reasonCode,
        'COORDINATOR_GENERATION_MOVED',
      );

      const wrongLanding = await decide(db, decisions, disagree.projectId, [{
        type: 'ROTATE_COORDINATOR_SESSION',
        idempotencyKey: rotateCoordinatorSessionIdempotencyKey(uuidToBase62(disagree.projectId), '1'),
        subject: { type: 'PROJECT', id: uuidToBase62(disagree.projectId) },
      }]);
      const moved = await rotations.rotate(truth.lease, {
        decisionId: wrongLanding.decisionId,
        planned: {
          ...rotation(truth.outcome),
          landingWorkspaceId: uuidToBase62(disagree.otherWorkspaceId),
        },
      });
      assert.equal(moved.action.status, 'REFUSED');
      assert.equal(
        (await db.projectAction.findUniqueOrThrow({ where: { id: moved.action.actionId } }))
          .reasonCode,
        'COORDINATION_WORKSPACE_MOVED',
      );
      assert.equal(await db.session.count({
        where: { ownerId: disagree.ownerId, taskId: null, projectActionId: { not: null } },
      }), 0, 'a refused rotation opens no run at all');
      assert.equal(await reconciler.releaseLease(truth.lease), true);

      // ── §7.5 · an unusable landing is a blocker with an owner, never another workspace ───────
      const homeless = await fixture(db, 'homeless', { coordinatorStatus: RunStatus.FAILED });
      await db.workspace.update({
        where: { id: homeless.workspaceId }, data: { enabled: false },
      });
      const blockedPlan = await planOnly(db, decisions, homeless.projectId);
      assert.deepEqual(blockedPlan.actions, []);
      assert.equal(blockedPlan.coordinator?.status, 'UNAVAILABLE');
      await db.$transaction(async (tx) => {
        await events.enqueue(tx, {
          projectId: homeless.projectId,
          kind: 'session.failed',
          source: { type: 'SESSION', id: homeless.coordinatorSessionId },
          dedupeKey: `session.failed:${randomUUID()}`,
        });
      });
      assert.ok(await events.drainAvailable() >= 1);
      const blocker = await db.projectBlocker.findFirstOrThrow({
        where: { projectId: homeless.projectId, resolvedAt: null, kind: 'COORDINATOR_UNAVAILABLE' },
      });
      assert.equal(blocker.owner, 'USER');
      assert.equal(blocker.recovery, 'HUMAN');
      assert.equal(await db.projectAction.count({
        where: { projectId: homeless.projectId, type: 'ROTATE_COORDINATOR_SESSION' },
      }), 0, 'the loop opened no run somewhere else');
      assert.equal(
        (await db.projectRuntime.findUniqueOrThrow({ where: { projectId: homeless.projectId } }))
          .runState,
        'AWAITING_HUMAN',
      );
      // The owner rebinds by making the landing usable again; §11.4 recomputes and clears the row
      // without anybody resolving it by hand, and the loop opens the run it could not open before.
      await db.workspace.update({ where: { id: homeless.workspaceId }, data: { enabled: true } });
      await db.$transaction(async (tx) => {
        await events.enqueue(tx, {
          projectId: homeless.projectId,
          kind: 'user.project_edited',
          source: { type: 'USER', id: homeless.ownerId },
          dedupeKey: `user.project_edited:${randomUUID()}`,
        });
      });
      assert.ok(await events.drainAvailable() >= 1);
      assert.ok((await db.projectBlocker.findUniqueOrThrow({ where: { id: blocker.id } })).resolvedAt);
      assert.equal(await db.projectAction.count({
        where: {
          projectId: homeless.projectId, type: 'ROTATE_COORDINATOR_SESSION', status: 'APPLIED',
        },
      }), 1, 'and the recovery is a run, not a second blocker');

      // ── §12.4 · the guarantees hold for a writer that never ran any of the code above ────────
      const mixed = await fixture(db, 'mixed', { coordinatorStatus: RunStatus.SUCCEEDED });

      // An old binary opening a "coordinator session" of its own, with no action behind it.
      await rejects(db.session.create({
        data: {
          ownerId: mixed.ownerId, creatorId: mixed.ownerId, workspaceId: mixed.workspaceId,
          assignedRunnerId: mixed.runnerId, title: 'forged', prompt: 'forged',
          status: RunStatus.PENDING, provider: 'claude', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
          dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
          runSource: SessionRunSource.PROJECT_COORDINATOR,
          resolution: {}, snapshotFrozenAt: new Date(),
        },
      }), /DISPATCH_AUTHORITY_VIOLATION|EXECUTION_CONTEXT_INVALID/);

      // …and one that borrows another project's applied rotation to look legitimate.
      await rejects(db.session.create({
        data: {
          ownerId: mixed.ownerId, creatorId: mixed.ownerId, workspaceId: mixed.workspaceId,
          assignedRunnerId: mixed.runnerId, title: 'borrowed', prompt: 'borrowed',
          status: RunStatus.PENDING, provider: 'claude', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
          projectActionId: applied.id,
          dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
          runSource: SessionRunSource.PROJECT_COORDINATOR,
          resolution: {}, snapshotFrozenAt: new Date(),
        },
      }), /DISPATCH_AUTHORITY_VIOLATION|Unique constraint/);

      // Raw SQL — the 0110-era binary's actual shape — relocating the coordinator.
      const stranger = await db.session.create({
        data: {
          ownerId: mixed.ownerId, creatorId: mixed.ownerId, workspaceId: mixed.otherWorkspaceId,
          assignedRunnerId: mixed.runnerId, title: 'elsewhere', prompt: 'elsewhere',
          status: RunStatus.RUNNING, provider: 'claude', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
        },
      });
      await rejects(db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "coordinator_session_id" = ${stranger.id}::uuid
         WHERE "id" = ${mixed.projectId}::uuid
      `), /COORDINATOR_POINTER_RELOCATED/);

      // Moving the landing out from under a live pointer is the same contradiction, said the other
      // way round, so it is refused by the same rule.
      await rejects(db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "coordinator_workspace_id" = ${mixed.otherWorkspaceId}::uuid
         WHERE "id" = ${mixed.projectId}::uuid
      `), /COORDINATOR_POINTER_RELOCATED/);

      await rejects(db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "coordinator_session_id" = ${normal.coordinatorSessionId}::uuid
         WHERE "id" = ${mixed.projectId}::uuid
      `), /COORDINATOR_POINTER_INVALID: session .* belongs to another owner/);
      await rejects(db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "coordinator_session_id" = ${randomUUID()}::uuid
         WHERE "id" = ${mixed.projectId}::uuid
      `), /COORDINATOR_POINTER_INVALID: session .* does not exist/);
      assert.equal(
        (await db.project.findUniqueOrThrow({ where: { id: mixed.projectId } }))
          .coordinatorSessionId,
        mixed.coordinatorSessionId,
        'four refused writes and the project still names the run it named',
      );

      // What the guard deliberately does NOT refuse: a pointer that names a conversation in Trash.
      // A bound coordinator can be soft-deleted at any time — an UPDATE on `session`, which never
      // passes through this guard — so the state exists whether or not it may be written, and both
      // `ProjectsService.coordinator` and §7.5's planner are built to leave it. Refusing the write
      // would only break the paths that repair it.
      const trashed = await db.session.create({
        data: {
          ownerId: mixed.ownerId, creatorId: mixed.ownerId, workspaceId: mixed.workspaceId,
          assignedRunnerId: mixed.runnerId, title: 'trashed', prompt: 'trashed',
          status: RunStatus.SUCCEEDED, provider: 'claude', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user', deletedAt: new Date(),
        },
      });
      await db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "coordinator_session_id" = ${trashed.id}::uuid
         WHERE "id" = ${mixed.projectId}::uuid
      `);
      assert.equal(
        (await db.project.findUniqueOrThrow({ where: { id: mixed.projectId } }))
          .coordinatorSessionId,
        trashed.id,
      );
      await db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "coordinator_session_id" = ${mixed.coordinatorSessionId}::uuid
         WHERE "id" = ${mixed.projectId}::uuid
      `);

      // Emptying the pointer stays legal — it is what the foreign key does when the conversation is
      // hard-deleted, and a project waiting for its next coordinator is a recoverable state that
      // says so with an event of its own, which the loop answers with a run.
      await db.session.delete({ where: { id: mixed.coordinatorSessionId } });
      const cleared = await db.project.findUniqueOrThrow({ where: { id: mixed.projectId } });
      assert.equal(cleared.coordinatorSessionId, null);
      assert.equal(cleared.coordinatorWorkspaceId, mixed.workspaceId, 'the landing is remembered');
      const clearedEvent = await db.projectEvent.findFirstOrThrow({
        where: { projectId: mixed.projectId, consumedAt: null, kind: 'session.ended' },
        orderBy: { occurredAt: 'desc' },
      });
      assert.equal((clearedEvent.payload as { cleared?: boolean }).cleared, true);
      assert.ok(await events.drainAvailable() >= 1);
      const reopened = await db.projectAction.findFirstOrThrow({
        where: {
          projectId: mixed.projectId, type: 'ROTATE_COORDINATOR_SESSION', status: 'APPLIED',
        },
      });
      assert.equal(
        (await db.project.findUniqueOrThrow({ where: { id: mixed.projectId } }))
          .coordinatorSessionId,
        reopened.resultSessionId,
      );
      assert.equal(
        (JSON.parse(JSON.stringify(reopened.detail)) as { trigger?: string }).trigger,
        'NO_COORDINATOR_SESSION',
      );

      // ── AC11 · a project nobody opted in stays exactly as silent as it was ──────────────────
      const legacy = await fixture(db, 'legacy', {
        coordinatorEnabled: false, coordinatorStatus: RunStatus.FAILED,
      });
      await db.session.update({
        where: { id: legacy.coordinatorSessionId },
        data: { status: RunStatus.CANCELLED },
      });
      assert.ok(await events.drainAvailable() >= 1);
      const discarded = await db.projectEvent.findFirstOrThrow({
        where: { projectId: legacy.projectId },
        orderBy: { occurredAt: 'desc' },
      });
      assert.equal(discarded.disposition, 'DISCARDED_OUT_OF_LOOP');
      assert.equal(await db.projectAction.count({ where: { projectId: legacy.projectId } }), 0);
      assert.equal(await db.projectBlocker.count({ where: { projectId: legacy.projectId } }), 0);
      const legacyDecision = await planOnly(db, decisions, legacy.projectId);
      assert.deepEqual(legacyDecision.actions, []);
      assert.equal(legacyDecision.coordinator?.status, 'OUT_OF_LOOP');
      assert.equal(await reconciler.acquireLease(legacy.projectId), null,
        'a project nobody opted in is not even leasable');
    } finally {
      rotations.onModuleDestroy();
      unregister();
      await db.$disconnect();
      await identity.end();
    }
  });
