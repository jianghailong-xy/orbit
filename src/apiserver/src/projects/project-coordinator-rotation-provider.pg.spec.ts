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
import { ProjectReconcileLease, ProjectReconcileService } from './project-reconcile.service';
import { ProjectCoordinatorSessionService } from './project-coordinator-session.service';
import { PlannedCoordinatorRotation } from './project-coordinator-session';
import { prismaClientFor } from '../prisma/prisma-client';

// §7.5 · what a rotated coordination run OPENS ON, on a real PostgreSQL server.
//
// The run that replaces a coordination run continues on its provider. That is a property of the
// committed row, which is why it is asserted here rather than against a stub: the provider the
// rotation writes has to survive `session_coordinator_snapshot_guard`, which refuses any session
// whose provider disagrees with the frozen `execution_context` — so a rotation that resolved one
// provider and wrote another could not commit at all, and a test that never reached the database
// could not tell the two apart.
//
// It replaced a query for "the newest top-level session in the landing workspace", which is
// `workspaces/workspace-provider.ts`'s Agent DEFAULT — the provider a NEW conversation starts on.
// The two questions coincide exactly while nothing else runs in that Agent, which is why this file
// spends most of its length on the case where something else does.
//
//   docker run -d --name pccrp-pg -e POSTGRES_USER=pccrp_admin -e POSTGRES_PASSWORD=… \
//     -e POSTGRES_DB=pccrp_rotation -p 127.0.0.1:55631:5432 postgres:16-alpine
//   psql … -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public'
//   DATABASE_URL=… npx prisma migrate deploy
//   COORDINATOR_PG_URL=… COORDINATOR_PG_EXPECTED_{DATABASE,USER,SYSTEM_IDENTIFIER}=… \
//     node --test build/projects/project-coordinator-rotation-provider.pg.spec.js

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  runnerId: string;
  coordinatorSessionId: string;
}

/**
 * A project whose coordination run has ENDED, so the next pass has a rotation to plan.
 *
 * `provider`/`providerBuiltin` describe the run being replaced — the whole subject of this file.
 */
async function fixture(
  db: PrismaClient,
  label: string,
  options: { provider?: string; providerBuiltin?: boolean } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${ownerId}@pccrp.invalid`, name: label, passwordHash: 'x',
    },
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
      status: RunStatus.SUCCEEDED, finishedAt: new Date(),
      provider: options.provider ?? 'claude',
      providerBuiltin: options.providerBuiltin ?? true,
      usesRuntimeDefaultModel: true, source: 'user',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: label, coordinatorEnabled: true,
      automationPolicy: ProjectAutomationPolicy.GUARDED_AUTO,
      coordinatorSessionId, coordinatorWorkspaceId: workspaceId,
    },
  });
  await db.projectRuntime.findUniqueOrThrow({ where: { projectId } });
  const seat = await db.projectMember.findFirstOrThrow({
    where: { projectId, role: ProjectRole.COORDINATOR },
  });
  assert.equal(seat.agentId, workspaceId, 'the landing seats the coordinator identity');
  return { ownerId, projectId, workspaceId, runnerId, coordinatorSessionId };
}

/**
 * A configured (non built-in) provider slug — the incident's `anthropic`, billed by API key.
 *
 * Suffixed because `model_provider.slug` is unique across the whole deployment, which is also why
 * a real one gets suffixed when the name is taken; nothing here depends on the spelling.
 */
function configuredSlug(): string {
  return `anthropic-${randomUUID().slice(0, 8)}`;
}

/** The `model_provider` row that makes that slug resolvable for this owner. */
async function configureProvider(
  db: PrismaClient,
  ownerId: string,
  slug: string,
): Promise<void> {
  await db.modelProvider.create({
    data: {
      id: randomUUID(), ownerId, slug, label: slug, runtime: 'claude',
      baseUrl: 'https://api.invalid', apiKeyEnc: 'iv:tag:ct', enabled: true,
    },
  });
}

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

async function planUnderLease(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  reconciler: ProjectReconcileService,
  projectId: string,
): Promise<{ lease: ProjectReconcileLease; decisionId: string; outcome: ProjectDecisionOutcome }> {
  const lease = await reconciler.acquireLease(projectId);
  assert.ok(lease, 'the project must be leasable');
  return { lease, ...(await decide(db, decisions, projectId)) };
}

interface Harness {
  db: PrismaClient;
  decisions: ProjectDecisionService;
  reconciler: ProjectReconcileService;
  rotations: ProjectCoordinatorSessionService;
  dispose: () => Promise<void>;
}

/**
 * The production wiring, per case.
 *
 * Each case owns its harness so that one failing assertion cannot decide whether the next case
 * ran: these are independent claims about the same effect, and a matrix that collapses to the
 * first failure cannot say which of them a change broke.
 */
async function harness(): Promise<Harness> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
  await identity.connect();
  await verifyCoordinatorPgIdentity(identity);
  const db = prismaClientFor(URL);
  const prisma = db as unknown as PrismaService;
  const events = new ProjectEventsService(prisma);
  const decisions = new ProjectDecisionService(prisma);
  const reconciler = new ProjectReconcileService(prisma, events, decisions);
  const unregister = events.registerHandler(reconciler);
  const rotations = new ProjectCoordinatorSessionService(
    prisma,
    reconciler,
    new ProjectAuthorizationService(),
    { notifySessionQueued: () => {} } as unknown as QueueService,
    { publishSessionCreated: () => {} } as unknown as RealtimeService,
  );
  rotations.onModuleInit();
  return {
    db,
    decisions,
    reconciler,
    rotations,
    dispose: async () => {
      rotations.onModuleDestroy();
      unregister();
      await db.$disconnect();
      await identity.end();
    },
  };
}

test('a rotation continues on the configured provider its source run declared',
  { skip: !URL, timeout: 120_000 }, async () => {
    const h = await harness();
    const { db, decisions, reconciler, rotations } = h;
    try {
    // ── 1 · the run it replaces was on a CONFIGURED provider, and so is the replacement ──────
    //
    // `anthropic` here is an owner-configured `model_provider` row billed by API key, not the
    // built-in `claude` slug billed against a Claude subscription. Those are different accounts
    // with different limits, so `provider_builtin` flipping to `true` is not a detail: it is the
    // run being moved onto a quota nobody chose for it.
    const slug = configuredSlug();
    const configured = await fixture(db, 'configured', { provider: slug, providerBuiltin: false });
    await configureProvider(db, configured.ownerId, slug);
    const plan = await planUnderLease(db, decisions, reconciler, configured.projectId);
    const rotated = await rotations.rotate(plan.lease, {
      decisionId: plan.decisionId, planned: rotation(plan.outcome),
    });
    assert.equal(rotated.action.status, 'APPLIED');
    const opened = await db.session.findUniqueOrThrow({ where: { id: rotated.sessionId! } });
    assert.equal(opened.provider, slug);
    assert.equal(opened.providerBuiltin, false);
    // The frozen context agrees, which is the only reason the row above was allowed to commit.
    const rotatedAction = await db.projectAction.findUniqueOrThrow({
      where: { id: rotated.action.actionId },
    });
    assert.equal(
      (rotatedAction.executionContext as unknown as { result?: { provider?: string } })
        .result?.provider,
      slug,
    );
    // §7.5 历史可追溯: WHERE the provider came from is on the record, not inferred later from a
    // column that anybody may since have changed.
    const resolution = opened.resolution as unknown as {
      with: { provider: string; providerBuiltin: boolean; source: string };
      rotation: { fromSessionId: string | null };
    };
    assert.equal(resolution.with.source, 'coordinator-rotation-source');
    assert.equal(resolution.with.provider, slug);
    assert.equal(resolution.with.providerBuiltin, false);
    assert.equal(resolution.rotation.fromSessionId,
      uuidToBase62(configured.coordinatorSessionId));
    assert.equal(await reconciler.releaseLease(plan.lease), true);
    } finally {
      await h.dispose();
    }
  });

test('an unrelated session in the same Agent does not re-point a rotation',
  { skip: !URL, timeout: 120_000 }, async () => {
    const h = await harness();
    const { db, decisions, reconciler, rotations } = h;
    try {
    // ── 2 · an unrelated session in the same Agent does NOT re-point the rotation ────────────
    //
    // The production shape: one Agent is the landing for several projects, another project's
    // coordinator rotates seconds earlier, and its brand-new run is now the newest top-level
    // session in the workspace. Reading the landing's newest session took THAT run's provider —
    // so a project's coordinator was re-pointed by a project it has nothing to do with. Any
    // top-level session does it; a person opening one by hand is the same fact.
    const slug = configuredSlug();
    const shared = await fixture(db, 'shared', { provider: slug, providerBuiltin: false });
    await configureProvider(db, shared.ownerId, slug);
    const intruder = await db.session.create({
      data: {
        id: randomUUID(), ownerId: shared.ownerId, creatorId: shared.ownerId,
        workspaceId: shared.workspaceId, assignedRunnerId: shared.runnerId,
        title: '协调：another project', prompt: 'coordinate',
        status: RunStatus.RUNNING, provider: 'claude', providerBuiltin: true,
        usesRuntimeDefaultModel: true, source: 'user',
        createdAt: new Date(Date.now() + 1_000),
      },
    });
    assert.equal(intruder.taskId, null);
    assert.equal(intruder.parentSessionId, null,
      'the intruder must satisfy the old seed predicate, or this proves nothing');
    const sharedPlan = await planUnderLease(db, decisions, reconciler, shared.projectId);
    const sharedRotation = await rotations.rotate(sharedPlan.lease, {
      decisionId: sharedPlan.decisionId, planned: rotation(sharedPlan.outcome),
    });
    assert.equal(sharedRotation.action.status, 'APPLIED');
    const sharedOpened = await db.session.findUniqueOrThrow({
      where: { id: sharedRotation.sessionId! },
    });
    assert.equal(sharedOpened.provider, slug,
      'the rotation continues its OWN run, not whatever ran last in the Agent');
    assert.equal(sharedOpened.providerBuiltin, false);
    assert.equal(await reconciler.releaseLease(sharedPlan.lease), true);
    } finally {
      await h.dispose();
    }
  });

test('the source is the run being replaced, not the newest run in the Agent',
  { skip: !URL, timeout: 120_000 }, async () => {
    const h = await harness();
    const { db, decisions, reconciler, rotations } = h;
    try {
    // ── 3 · the run it replaces is the SOURCE even when it is not the newest, and not alive ──
    //
    // The rotation triggers are `ENDED`, `FAILED` and `DELETED`: by the time this runs, the run
    // being continued is over, and anything opened in that Agent since is newer than it. Reading
    // "the newest" therefore did not merely risk the wrong answer in a busy Agent — it read the
    // wrong ROW by construction whenever anything else had happened in between.
    const slug = configuredSlug();
    const ended = await fixture(db, 'ended', { provider: slug, providerBuiltin: false });
    await configureProvider(db, ended.ownerId, slug);
    await db.session.update({
      where: { id: ended.coordinatorSessionId },
      data: { deletedAt: new Date() },
    });
    const endedPlan = await planUnderLease(db, decisions, reconciler, ended.projectId);
    const endedRotation = await rotations.rotate(endedPlan.lease, {
      decisionId: endedPlan.decisionId, planned: rotation(endedPlan.outcome),
    });
    assert.equal(endedRotation.action.status, 'APPLIED');
    const endedOpened = await db.session.findUniqueOrThrow({
      where: { id: endedRotation.sessionId! },
    });
    assert.equal(endedOpened.provider, slug,
      'a coordination run in the Trash still says what its replacement continues on');
    assert.equal(endedOpened.providerBuiltin, false);
    assert.equal(await reconciler.releaseLease(endedPlan.lease), true);
    } finally {
      await h.dispose();
    }
  });

test('an unresolvable provider row never re-homes the run on the built-in provider',
  { skip: !URL, timeout: 120_000 }, async () => {
    const h = await harness();
    const { db, decisions, reconciler, rotations } = h;
    try {
    // ── 4 · the built-in floor is unreachable while there is a run to continue ───────────────
    //
    // The source names a configured provider whose `model_provider` row is not there — removed,
    // disabled, or never this owner's. The old `?? AgentProvider.CLAUDE` / `?? true` pair had no
    // way to distinguish that from "nothing matched my query" and answered both with the
    // built-in subscription. The replacement must still be the provider the run it continues
    // declared: the runtime is a separate question, and being unable to answer it is not licence
    // to move the run onto somebody else's quota.
    const slug = configuredSlug();
    const stranded = await fixture(db, 'stranded', { provider: slug, providerBuiltin: false });
    const strandedPlan = await planUnderLease(db, decisions, reconciler, stranded.projectId);
    const strandedRotation = await rotations.rotate(strandedPlan.lease, {
      decisionId: strandedPlan.decisionId, planned: rotation(strandedPlan.outcome),
    });
    assert.equal(strandedRotation.action.status, 'APPLIED');
    const strandedOpened = await db.session.findUniqueOrThrow({
      where: { id: strandedRotation.sessionId! },
    });
    assert.equal(strandedOpened.provider, slug);
    assert.equal(strandedOpened.providerBuiltin, false,
      'an unresolvable runtime must not re-home the run on the built-in provider');
    assert.equal(
      (strandedOpened.resolution as unknown as { with: { source: string } }).with.source,
      'coordinator-rotation-source',
    );
    assert.equal(await reconciler.releaseLease(strandedPlan.lease), true);
    } finally {
      await h.dispose();
    }
  });

test('a first binding falls back to the Agent default and records that it did',
  { skip: !URL, timeout: 120_000 }, async () => {
    const h = await harness();
    const { db, decisions, reconciler, rotations } = h;
    try {
    // ── 5 · a FIRST binding has no run to continue, and says so ──────────────────────────────
    //
    // The one case the Agent default is the right answer: nothing is being continued, so the
    // question really is "where does a new conversation in this Agent start". It is RECORDED
    // rather than assumed — `with.source` names it — so a provider that came from the workspace
    // can never again be mistaken for one a previous run chose.
    const first = await fixture(db, 'first');
    await db.session.update({
      where: { id: first.coordinatorSessionId },
      data: { provider: 'codex', providerBuiltin: true },
    });
    await db.project.update({
      where: { id: first.projectId }, data: { coordinatorSessionId: null },
    });
    const firstPlan = await planUnderLease(db, decisions, reconciler, first.projectId);
    assert.equal(rotation(firstPlan.outcome).fromSessionId, null);
    const firstRotation = await rotations.rotate(firstPlan.lease, {
      decisionId: firstPlan.decisionId, planned: rotation(firstPlan.outcome),
    });
    assert.equal(firstRotation.action.status, 'APPLIED');
    const firstOpened = await db.session.findUniqueOrThrow({
      where: { id: firstRotation.sessionId! },
    });
    assert.equal(firstOpened.provider, 'codex');
    assert.equal(
      (firstOpened.resolution as unknown as { with: { source: string } }).with.source,
      'coordination-workspace-default',
    );
    assert.equal(await reconciler.releaseLease(firstPlan.lease), true);
    } finally {
      await h.dispose();
    }
  });
