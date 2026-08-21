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
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import { ProjectDecisionService } from './project-decision.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectEventsService } from './project-events.service';
import {
  ProjectReconcileService,
  ProjectRotationExecutor,
} from './project-reconcile.service';
import { ProjectCoordinatorSessionService } from './project-coordinator-session.service';
import { COORDINATOR_ROTATION_REASON_CODE } from './project-coordinator-session';
import { prismaClientFor } from '../prisma/prisma-client';

// §7.5 · §8.4, driven the way production drives it, on a DISPOSABLE PostgreSQL server.
//
// The distinction this file exists to make: nothing below ever calls `rotate()`. Every rotation
// here starts as a Session write that some other part of Orbit made, becomes a `project_event` row
// because a trigger said so, and is picked up by `drainAvailable()` — the same consumer the
// orchestration service's timer and its LISTEN/NOTIFY path call. If the wiring between "the loop
// decided a rotation" and "a rotation happened" were missing, every assertion here would fail.
//
// Setup (the migration chain must be deployed, which is also this suite's compat-window evidence):
//
//   docker run -d --name pcc19r-pg16 -e POSTGRES_USER=pcc19r_admin -e POSTGRES_PASSWORD=… \
//     -e POSTGRES_DB=pcc19r_rotation -p 127.0.0.1:55622:5432 postgres:16-alpine
//   psql … -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public'
//   DATABASE_URL=… npx prisma migrate deploy
//   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_{DATABASE,USER,SYSTEM_IDENTIFIER}=… \
//     node --test build/projects/project-coordinator-driver.pg.spec.js

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  runnerId: string;
  coordinatorSessionId: string;
}

/** One whole orchestration instance: its own connection, its own id, its own registrations. */
interface Loop {
  db: PrismaClient;
  events: ProjectEventsService;
  decisions: ProjectDecisionService;
  reconciler: ProjectReconcileService;
  rotations: ProjectCoordinatorSessionService;
  announced: string[];
  stop: () => Promise<void>;
}

function loop(url: string): Loop {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const announced: string[] = [];
  const events = new ProjectEventsService(prisma);
  const decisions = new ProjectDecisionService(prisma);
  const reconciler = new ProjectReconcileService(prisma, events, decisions);
  const rotations = new ProjectCoordinatorSessionService(
    prisma,
    reconciler,
    new ProjectAuthorizationService(),
    { notifySessionQueued: () => announced.push('queue') } as unknown as QueueService,
    { publishSessionCreated: (id: string) => announced.push(id) } as unknown as RealtimeService,
  );
  const unregisterHandler = events.registerHandler(reconciler);
  // The production wiring, done the way Nest does it. Everything else in this file goes through it.
  rotations.onModuleInit();
  return {
    db,
    events,
    decisions,
    reconciler,
    rotations,
    announced,
    stop: async () => {
      unregisterHandler();
      rotations.onModuleDestroy();
      await db.$disconnect();
    },
  };
}

async function fixture(
  db: PrismaClient,
  label: string,
  options: { coordinatorStatus?: RunStatus } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc19r.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x',
      status: RunnerStatus.ONLINE,
      capabilities: ['session-orchestration-credential-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-landing`, enabled: true,
      canCreateTasks: true, canDelegate: true,
    },
  });
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
      id: projectId, ownerId, title: label, coordinatorEnabled: true,
      automationPolicy: ProjectAutomationPolicy.GUARDED_AUTO,
      coordinatorSessionId, coordinatorWorkspaceId: workspaceId,
    },
  });
  const seat = await db.projectMember.findFirstOrThrow({
    where: { projectId, role: ProjectRole.COORDINATOR },
  });
  assert.equal(seat.agentId, workspaceId);
  return { ownerId, projectId, workspaceId, runnerId, coordinatorSessionId };
}

/** The coordination run this project currently names, and the ledger row that opened it. */
async function coordination(db: PrismaClient, projectId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const runtime = await db.projectRuntime.findUniqueOrThrow({ where: { projectId } });
  const rotations = await db.projectAction.findMany({
    where: { projectId, type: 'ROTATE_COORDINATOR_SESSION' },
    orderBy: { createdAt: 'asc' },
  });
  const runs = await db.session.findMany({
    where: { ownerId: project.ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR },
    orderBy: { createdAt: 'asc' },
  });
  return { project, runtime, rotations, runs };
}

test('the loop itself rotates a coordination run, from the event its death produced',
  { skip: !URL, timeout: 240_000 }, async (t) => {
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
    await identity.end();

    const primary = loop(URL!);
    const { db, events } = primary;
    try {
      await t.test('a run that dies wakes the loop, and the loop opens the next one', async () => {
        const target = await fixture(db, 'driver');
        // The ONLY thing this test does by hand: the Session write any other part of Orbit makes
        // when a run dies. Everything after it is the control loop.
        await db.session.update({
          where: { id: target.coordinatorSessionId },
          data: { status: RunStatus.FAILED, finishedAt: new Date(), error: 'runtime died' },
        });
        const signal = await db.projectEvent.findFirstOrThrow({
          where: { projectId: target.projectId, consumedAt: null, sourceId: target.coordinatorSessionId },
        });
        assert.equal(signal.kind, 'session.failed');

        assert.ok(await events.drainAvailable() >= 1);

        const after = await coordination(db, target.projectId);
        assert.equal(after.rotations.length, 1, 'the loop applied exactly one rotation');
        assert.equal(after.rotations[0].status, 'APPLIED');
        assert.ok(after.rotations[0].reasonCode?.startsWith(`${COORDINATOR_ROTATION_REASON_CODE}:`));
        assert.equal(after.runs.length, 1, 'and it opened exactly one run');
        const run = after.runs[0];
        assert.equal(run.status, RunStatus.PENDING, 'the new run is queued for the runner');
        assert.equal(run.taskId, null);
        assert.equal(run.workspaceId, target.workspaceId, '§7.5 落点固定');
        assert.equal(run.runSource, SessionRunSource.PROJECT_COORDINATOR);
        assert.equal(run.projectActionId, after.rotations[0].id);
        assert.equal(after.rotations[0].resultSessionId, run.id);
        assert.equal(after.project.coordinatorSessionId, run.id, 'the project names it now');
        assert.equal(after.runtime.coordinatorGeneration, 1n);
        assert.equal(after.runtime.coordinatorSessionId, run.id);
        assert.equal(after.runtime.leaseHolder, null, 'the pass released its lease');
        assert.ok(after.runtime.nextWakeAt, 'and left a durable clock behind (§10.4)');

        // The event was consumed by the same commit that made all of this true.
        const consumed = await db.projectEvent.findUniqueOrThrow({ where: { id: signal.id } });
        assert.ok(consumed.consumedAt);
        assert.equal(consumed.disposition, 'RECONCILED');

        // The runner was told, after the commit and not inside it.
        assert.deepEqual(primary.announced, ['queue', run.id]);
        primary.announced.length = 0;

        // The identity did not move, and the dead run is history rather than garbage.
        const seat = await db.projectMember.findFirstOrThrow({
          where: { projectId: target.projectId, role: ProjectRole.COORDINATOR },
        });
        assert.equal(seat.agentId, target.workspaceId);
        const dead = await db.session.findUniqueOrThrow({
          where: { id: target.coordinatorSessionId },
        });
        assert.equal(dead.status, RunStatus.FAILED);
        assert.equal(dead.deletedAt, null);
      });

      await t.test('a redelivered, out-of-order or restarted delivery opens no second run',
        async () => {
          const target = await fixture(db, 'exactly-once');
          await db.session.update({
            where: { id: target.coordinatorSessionId },
            data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
          });
          await events.drainAvailable();
          const first = await coordination(db, target.projectId);
          assert.equal(first.runs.length, 1);

          // The same cause, delivered again — late, and out of order with respect to the rotation
          // that already answered it.
          for (const occurredAt of [
            new Date(Date.now() - 60_000),
            new Date(Date.now() - 3_600_000),
            new Date(),
          ]) {
            await db.$transaction(async (tx) => {
              await events.enqueue(tx, {
                projectId: target.projectId,
                kind: 'session.ended',
                source: { type: 'SESSION', id: target.coordinatorSessionId },
                dedupeKey: `session.ended:replay:${randomUUID()}`,
                occurredAt,
              });
            });
          }
          await events.drainAvailable();

          // A restarted process: new instance id, new lease, same durable facts.
          const restarted = loop(URL!);
          try {
            await db.$transaction(async (tx) => {
              await restarted.events.enqueue(tx, {
                projectId: target.projectId,
                kind: 'session.failed',
                source: { type: 'SESSION', id: target.coordinatorSessionId },
                dedupeKey: `session.failed:restart:${randomUUID()}`,
              });
            });
            await restarted.events.drainAvailable();
          } finally {
            await restarted.stop();
          }

          const after = await coordination(db, target.projectId);
          assert.equal(after.rotations.length, 1, 'still one ledger row');
          assert.equal(after.runs.length, 1, 'still one run');
          assert.equal(after.runs[0].id, first.runs[0].id, 'and it is the same run');
          assert.equal(after.runtime.coordinatorGeneration, 1n, 'counted once');
          assert.equal(
            await db.projectEvent.count({ where: { projectId: target.projectId, consumedAt: null } }),
            0,
            'every redelivery was answered rather than left pending',
          );
        });

      await t.test('two instances racing the same project produce one rotation between them',
        async () => {
          const target = await fixture(db, 'race');
          const second = loop(URL!);
          try {
            await db.session.update({
              where: { id: target.coordinatorSessionId },
              data: { status: RunStatus.FAILED, finishedAt: new Date() },
            });
            // Both drains see the same pending event. `FOR NO KEY UPDATE … SKIP LOCKED` gives the
            // Project to one of them, and the fence gives the ledger to that one only.
            await Promise.all([events.drainAvailable(), second.events.drainAvailable()]);
            await Promise.all([events.drainAvailable(), second.events.drainAvailable()]);

            const after = await coordination(db, target.projectId);
            assert.equal(after.rotations.length, 1);
            assert.equal(after.runs.length, 1);
            assert.equal(after.runtime.coordinatorGeneration, 1n);
            assert.equal(after.project.coordinatorSessionId, after.runs[0].id);
          } finally {
            await second.stop();
          }
        });

      await t.test('a pass that dies before its commit leaves nothing, and the retry rotates once',
        async () => {
          const target = await fixture(db, 'crash');
          await db.session.update({
            where: { id: target.coordinatorSessionId },
            data: { status: RunStatus.FAILED, finishedAt: new Date() },
          });

          // Fault injection at the one instant that matters: everything the rotation does has been
          // written, and the transaction never reaches COMMIT.
          const real = primary.rotations;
          primary.rotations.onModuleDestroy();
          const crashing: ProjectRotationExecutor = {
            idempotencyKey: (projectId, generation) => real.idempotencyKey(projectId, generation),
            actionDetail: (planned) => real.actionDetail(planned),
            announce: () => {},
            rotateInTransaction: async (tx, lease, command, actionId, now) => {
              await real.rotateInTransaction(tx, lease, command, actionId, now);
              throw new Error('injected crash before commit');
            },
          };
          const restore = primary.reconciler.registerRotationExecutor(crashing);
          await events.drainAvailable();
          restore();

          const crashed = await coordination(db, target.projectId);
          assert.equal(crashed.rotations.length, 0, 'no ledger row survived the rollback');
          assert.equal(crashed.runs.length, 0, 'and no run');
          assert.equal(crashed.project.coordinatorSessionId, target.coordinatorSessionId,
            'the pointer still names the dead run');
          assert.equal(crashed.runtime.leaseHolder, null, 'and no lease was left held');
          const pending = await db.projectEvent.findFirstOrThrow({
            where: { projectId: target.projectId, consumedAt: null, sourceId: target.coordinatorSessionId },
          });
          assert.equal(pending.attempts, 1, 'the signal is still there, backed off (§5.4)');
          assert.ok(pending.nextAttemptAt);

          // Recovery is "look again", not "replay a log" (§8.4 Y1).
          primary.rotations.onModuleInit();
          await db.projectEvent.update({
            where: { id: pending.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) },
          });
          await events.drainAvailable();

          const recovered = await coordination(db, target.projectId);
          assert.equal(recovered.rotations.length, 1);
          assert.equal(recovered.rotations[0].status, 'APPLIED');
          assert.equal(recovered.runs.length, 1);
          assert.equal(recovered.runtime.coordinatorGeneration, 1n);
        });

      await t.test('a second run on facts the first did not change is a blocker, not a third run',
        async () => {
          const target = await fixture(db, 'noprogress');
          await db.session.update({
            where: { id: target.coordinatorSessionId },
            data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
          });
          await events.drainAvailable();
          const first = await coordination(db, target.projectId);
          assert.equal(first.runs.length, 1);

          // The run the loop opened ends having changed nothing. §7.6 TR3: opening another one
          // would be a project that burns a session every time one finishes.
          await db.session.update({
            where: { id: first.runs[0].id },
            data: { status: RunStatus.SUCCEEDED, finishedAt: new Date() },
          });
          await events.drainAvailable();

          const stalled = await coordination(db, target.projectId);
          assert.equal(stalled.rotations.length, 1, 'no second rotation');
          assert.equal(stalled.runs.length, 1);
          const blocker = await db.projectBlocker.findFirstOrThrow({
            where: {
              projectId: target.projectId, resolvedAt: null, kind: 'COORDINATOR_NO_PROGRESS',
            },
          });
          assert.equal(blocker.owner, 'USER');
          assert.equal(blocker.recovery, 'HUMAN');
          assert.equal(stalled.runtime.runState, 'AWAITING_HUMAN');

          // …and it is not a wedge. The world moving is what the row was waiting for.
          await db.task.create({
            data: {
              ownerId: target.ownerId, projectId: target.projectId, title: 'new work',
              creatorType: 'USER', creatorId: target.ownerId,
            },
          });
          await events.drainAvailable();

          const moved = await coordination(db, target.projectId);
          assert.ok(
            (await db.projectBlocker.findUniqueOrThrow({ where: { id: blocker.id } })).resolvedAt,
            'the condition stopped holding, so §11.4 resolved it',
          );
          assert.equal(moved.rotations.length, 2, 'and a run was opened for the new facts');
          assert.equal(moved.runs.length, 2);
          assert.equal(moved.runtime.coordinatorGeneration, 2n);
          assert.equal(moved.project.coordinatorSessionId, moved.runs[1].id);
          assert.notEqual(
            moved.rotations[0].reasonCode,
            moved.rotations[1].reasonCode,
            'a new run is opened on a new world, and says which one',
          );
        });
    } finally {
      await primary.stop();
    }
  });
