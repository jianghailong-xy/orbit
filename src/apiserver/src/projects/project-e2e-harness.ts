import { randomUUID } from 'node:crypto';
import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import { ProjectAvailabilityReaperService } from './project-availability-reaper.service';
import { ProjectCoordinatorSessionService } from './project-coordinator-session.service';
import {
  ProjectDecisionService,
  createDecisionId,
  planProjectDecision,
  publicIdempotencyKey,
} from './project-decision.service';
import { ProjectDispatchPassService } from './project-dispatch-pass.service';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileService } from './project-reconcile.service';
import { ProjectTaskDispatcherService } from './project-task-dispatcher.service';
import { ProjectVerificationVerdictService } from './project-verification-verdict.service';
import { ProjectsService } from './projects.service';

/**
 * Unit 22's shared rig: the production service graph, wired the way `ProjectsModule` wires it, over
 * a real PostgreSQL that `prisma migrate deploy` built.
 *
 * The rule this file exists to enforce is the one unit 22 is about — **drive the doors, not the
 * helpers**. Every scenario reaches the system through something a request, a timer or an event
 * would reach: `ProjectsService` for what a user does, `ProjectEventsService.drainOnce` for what an
 * outbox delivery does, `ProjectReconcileService.tick` for what the clock does, and the three
 * action services for what a pass performs. Nothing here reimplements a decision, and nothing
 * short-circuits a gate; a scenario that cannot be reached from a door is a scenario that cannot
 * happen in production either.
 *
 * Destructive: `coordinator-pg-test-safety` proves the target is disposable before the first write.
 */

export interface E2eServices {
  db: PrismaClient;
  events: ProjectEventsService;
  decisions: ProjectDecisionService;
  reconciler: ProjectReconcileService;
  coordinatorSessions: ProjectCoordinatorSessionService;
  dispatcher: ProjectTaskDispatcherService;
  /** §7.8's pass — the production caller of `dispatcher`, driven by `reconciler.afterCommit`. */
  dispatchPass: ProjectDispatchPassService;
  verdicts: ProjectVerificationVerdictService;
  reaper: ProjectAvailabilityReaperService;
  acceptance: ProjectAcceptanceService;
  projects: ProjectsService;
  sessions: SessionsService;
  /** Post-commit announcements the loop made, so "it told the runner" is observable. */
  announced: { queued: number; sessions: string[] };
  dispose: () => Promise<void>;
}

/** Every table the control loop can write, in dependency order. */
const WORLD_TABLES = [
  'project_acceptance_audit', 'project_acceptance_criterion', 'project_merge_evidence',
  'project_blocker', 'project_event', 'project_decision', 'project_action',
  // Before `project`, because `project.accepted_run_id` references it (migration 0127).
  'project_acceptance_run', 'project_runtime',
  'project_member', 'task_verification_failure', 'task_dependency', 'task_comment', 'task',
  'task_list', 'session', 'workspace', 'runner', 'model_provider', 'project', 'user',
];

export async function connectIsolatedPg(url: string | undefined): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(url);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  // A `docker stop` on the server under test terminates this socket, and an unhandled 'error' on a
  // pg Client is an uncaught exception that takes the whole runner down. The restart scenario is
  // SUPPOSED to break this connection, so the break is reported and then owned by the caller,
  // which reconnects.
  client.on('error', (error) => {
    console.log(`coordinator-pg-connection-lost ${error instanceof Error ? error.message : error}`);
  });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/** Truncate everything this suite can touch, after re-proving the server is the disposable one. */
export async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(
    `TRUNCATE ${WORLD_TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

/**
 * The service graph, with the two things a module cannot give a test: a queue and a realtime bus
 * that record rather than transmit. Both are post-commit announcement sinks by contract (§8.3), so
 * recording them keeps every gate intact while making "the runner was told" an assertion.
 */
export function servicesOn(
  url: string,
  options: { registerHandler?: boolean; registerDispatchPass?: boolean } = {},
): E2eServices {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const prisma = db as unknown as PrismaService;
  const announced = { queued: 0, sessions: [] as string[] };
  const queue = {
    notifySessionQueued: () => { announced.queued += 1; },
  } as unknown as QueueService;
  // A recording bus: every `publish*` is a no-op that returns undefined, except the one this
  // suite asserts on. A Proxy rather than a hand-written list, so a service that grows a new
  // notification does not fail this rig for a reason that has nothing to do with the loop.
  const realtime = new Proxy({}, {
    get: (_target, property: string) => (property === 'publishSessionCreated'
      ? (sessionId: string) => { announced.sessions.push(sessionId); }
      : () => undefined),
  }) as unknown as RealtimeService;

  const events = new ProjectEventsService(prisma);
  const decisions = new ProjectDecisionService(prisma);
  const reconciler = new ProjectReconcileService(prisma, events, decisions);
  const authorization = new ProjectAuthorizationService();
  const coordinatorSessions = new ProjectCoordinatorSessionService(
    prisma, reconciler, authorization, queue, realtime,
  );
  const dispatcher = new ProjectTaskDispatcherService(
    prisma, reconciler, authorization, queue, realtime,
  );
  const dispatchPass = new ProjectDispatchPassService(prisma, reconciler, decisions, dispatcher);
  const verdicts = new ProjectVerificationVerdictService(prisma, reconciler);
  const reaper = new ProjectAvailabilityReaperService(prisma);
  const sessions = new SessionsService(prisma, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma);
  const projects = new ProjectsService(prisma, sessions, acceptance);

  // The production wiring, minus the timers: `onModuleInit` would also start §10.2's clock, and a
  // suite that asserts on exact pass counts cannot share the world with a background ticker.
  // `registerHandler: false` is for a scenario that installs its own wrapper around the same
  // reconciler — §5.4 allows exactly one handler, and that is itself a property worth keeping.
  const unregisterHandler = options.registerHandler === false
    ? () => undefined
    : events.registerHandler(reconciler);
  const unregisterRotation = reconciler.registerRotationExecutor(coordinatorSessions);
  // §7.8's production wiring. `registerDispatchPass: false` is for the scenarios that predate the
  // pass and count decisions by hand — with it installed, a drain that reconciles a project with a
  // ready task also dispatches it, which is the point of the unit and a surprise to a rig that was
  // written when nothing did.
  const unregisterDispatchPass = options.registerDispatchPass === false
    ? () => undefined
    : reconciler.registerDispatchPass(dispatchPass);

  return {
    db, events, decisions, reconciler, coordinatorSessions, dispatcher, dispatchPass, verdicts,
    reaper, acceptance, projects, sessions, announced,
    dispose: async () => {
      unregisterDispatchPass();
      unregisterRotation();
      unregisterHandler();
      events.onModuleDestroy();
      reconciler.onModuleDestroy();
      reaper.onModuleDestroy();
      await db.$disconnect();
    },
  };
}

export interface WorldOptions {
  policy?: ProjectAutomationPolicy;
  maxConcurrentTasks?: number;
  sessionBudgetPerDay?: number | null;
  runnerStatus?: RunnerStatus;
  runnerCapabilities?: string[];
  /** Register a `model_provider` row for this slug, so a dispatch of it can be authorized. */
  providers?: Array<{ slug: string; runtime: string; enabled?: boolean; defaultModel?: string }>;
  coordinatorEnabled?: boolean;
  /** What this project's DONE has to be checked against (§13.4). One criterion per non-blank
   *  line, which is what `parseCriteria` decides and what an acceptance run is a checklist of. */
  acceptanceCriteria?: string;
}

export interface World {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
}

/**
 * An owner with one runner, one agent, and one project that agent coordinates.
 *
 * Written through Prisma rather than through `ProjectsService.create` on purpose: `create` is
 * itself under test in AC1, and a rig that used it would make every other scenario depend on the
 * outcome of one. The rows it writes are the rows `create` writes — the AC1 scenario proves that.
 */
export async function world(
  db: PrismaClient,
  label: string,
  options: WorldOptions = {},
): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const agentId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc22.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: options.runnerStatus ?? RunnerStatus.ONLINE,
      capabilities: options.runnerCapabilities ?? ['session-orchestration-credential-v1'],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
      engines: { claude: { installed: true }, codex: { installed: true } },
    },
  });
  await db.workspace.create({
    data: { id: agentId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: label,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      automationPolicy: options.policy ?? ProjectAutomationPolicy.AUTO,
      maxConcurrentTasks: options.maxConcurrentTasks ?? 3,
      sessionBudgetPerDay: options.sessionBudgetPerDay ?? null,
      acceptanceCriteria: options.acceptanceCriteria ?? null,
      coordinatorWorkspaceId: agentId,
    },
  });
  // Migration 0112's `project_coordinator_companions_insert` trigger already seats the coordinator
  // when a project lands with a `coordinator_workspace_id`, so this is an upsert rather than an
  // insert: creating the row again is a unique-constraint failure, not a second coordinator.
  await db.projectMember.upsert({
    where: { projectId_agentId: { projectId, agentId } },
    create: { projectId, agentId, role: ProjectRole.COORDINATOR },
    update: { role: ProjectRole.COORDINATOR },
  });
  for (const provider of options.providers ?? []) {
    await db.modelProvider.create({
      data: {
        ownerId,
        slug: provider.slug,
        label: provider.slug,
        runtime: provider.runtime,
        baseUrl: `https://${provider.slug}.pcc22.invalid`,
        apiKeyEnc: 'iv:tag:ct',
        enabled: provider.enabled ?? true,
        defaultModel: provider.defaultModel ?? `${provider.slug}-default`,
        models: [{ value: provider.defaultModel ?? `${provider.slug}-default`, label: provider.slug }],
      },
    });
  }
  return { ownerId, runnerId, agentId, projectId };
}

export interface TaskOptions {
  assigneeId?: string | null;
  provider?: string | null;
  status?: TaskStatus;
  parentTaskId?: string | null;
  verifiesTaskId?: string | null;
  completionPolicy?: 'MANUAL' | 'ALL_CHILDREN_DONE' | 'VERIFICATION_PASSED';
  dependsOn?: string[];
  requiredCapabilities?: string[];
  /** §12.3 D4's legacy switch. Off by default, and deliberately irrelevant to §7.8's pass. */
  autoRunWhenReady?: boolean;
  /** §7.4 precondition 1's park brake, for a scenario that needs a task nothing may dispatch. */
  dispatchHold?: boolean;
}

export async function task(
  db: PrismaClient,
  target: World,
  title: string,
  options: TaskOptions = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id,
      ownerId: target.ownerId,
      projectId: target.projectId,
      title,
      creatorType: CreatorType.USER,
      creatorId: target.ownerId,
      status: options.status ?? TaskStatus.OPEN,
      assigneeId: options.assigneeId === undefined ? target.agentId : options.assigneeId,
      provider: options.provider ?? 'claude',
      parentTaskId: options.parentTaskId ?? null,
      verifiesTaskId: options.verifiesTaskId ?? null,
      requiredCapabilities: options.requiredCapabilities ?? [],
      ...(options.autoRunWhenReady === undefined ? {} : { autoRunWhenReady: options.autoRunWhenReady }),
      ...(options.dispatchHold === undefined ? {} : { dispatchHold: options.dispatchHold }),
      ...(options.completionPolicy ? { completionPolicy: options.completionPolicy } : {}),
    },
  });
  for (const dependsOnTaskId of options.dependsOn ?? []) {
    await db.taskDependency.create({ data: { taskId: id, dependsOnTaskId } });
  }
  return id;
}

export interface SessionOptions {
  taskId?: string | null;
  status?: RunStatus;
  error?: string | null;
  createdAt?: Date;
  finishedAt?: Date | null;
  branch?: string;
  mergeStatus?: string;
  mergeTarget?: string;
  changedFiles?: Prisma.InputJsonValue;
}

/**
 * A session row with the columns the loop reads, and the two the schema requires.
 *
 * `dispatchOrigin` is USER by default here, and that is not a convenience: §7.7 D6's trigger
 * REFUSES a session inserted for a COORDINATOR-authority task under any other origin without an
 * action to attribute it to. A user who pressed "start" is the one origin a test can legitimately
 * write directly — which is also §12.3 D3's explicit carve-out.
 */
export async function session(
  db: PrismaClient,
  target: World,
  options: SessionOptions = {},
): Promise<string> {
  const created = await db.session.create({
    data: {
      ownerId: target.ownerId,
      creatorId: target.ownerId,
      taskId: options.taskId ?? null,
      workspaceId: target.agentId,
      assignedRunnerId: target.runnerId,
      title: 'e2e',
      prompt: 'e2e',
      provider: 'claude',
      status: options.status ?? RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      error: options.error ?? null,
      finishedAt: options.finishedAt === undefined ? new Date() : options.finishedAt,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.mergeStatus ? { mergeStatus: options.mergeStatus } : {}),
      ...(options.mergeTarget ? { mergeTarget: options.mergeTarget } : {}),
      ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
    },
  });
  return created.id;
}

/**
 * `failureCount` is not a column: §6.1 derives it from this task's FAILED sessions, and
 * `failureAttributable` from whether each carried an error. So a test that wants a task N attempts
 * deep has to fail it N times, which is also the only way production ever gets there.
 */
export async function failTask(
  db: PrismaClient,
  target: World,
  taskId: string,
  times: number,
  lastFailureAt = new Date(),
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await session(db, target, {
      taskId,
      status: RunStatus.FAILED,
      error: `pcc22 injected failure ${i + 1}`,
      createdAt: new Date(lastFailureAt.getTime() - (times - 1 - i) * 1_000),
      finishedAt: new Date(lastFailureAt.getTime() - (times - 1 - i) * 1_000),
    });
  }
}

/**
 * One reconcile pass through the DELIVERY door: commit a signal, then drain it.
 *
 * This is what a `task.*`, `session.*` or `user.*` producer causes in production, end to end —
 * `drainOnce` locks the project, calls the registered handler inside the delivery transaction, and
 * commits `consumed_at` atomically with everything the pass decided.
 */
export async function deliver(
  services: E2eServices,
  projectId: string,
  kind = 'task.updated',
  dedupeKey = `e2e:${randomUUID()}`,
): Promise<ReturnType<ProjectEventsService['drainOnce']>> {
  await services.events.enqueue(services.db as unknown as Prisma.TransactionClient, {
    projectId,
    kind,
    source: { type: 'TASK', id: projectId },
    dedupeKey,
  });
  return services.events.drainOnce();
}

/** Drain until the queue is idle, so a pass that schedules another one is followed to rest. */
export async function drainToIdle(services: E2eServices, limit = 25): Promise<number> {
  let passes = 0;
  for (let i = 0; i < limit; i += 1) {
    const result = await services.events.drainOnce();
    if (result.status === 'IDLE' || result.status === 'NO_HANDLER') break;
    passes += 1;
  }
  return passes;
}

export interface DispatchOutcome {
  refusalCode: string | null;
  reasonCode: string | null;
  /** The ledger ROW's status: CLAIMED, APPLIED or REFUSED. */
  status: string;
  /** What THIS attempt did: APPLIED, REFUSED or ALREADY_APPLIED (a replay of the same key). */
  applyStatus: string;
  sessionId: string | null;
  actionId: string;
}

/**
 * Plan and perform one real `DISPATCH_TASK`, exactly as a pass that chose to would.
 *
 * The decision is captured and persisted first because §8.3 refuses an action no decision proposed;
 * the dispatcher then runs every gate — blockers, policy, approval, provider, runner, concurrency,
 * budget — inside the ledger's transaction. Nothing here decides anything itself.
 */
export async function dispatch(
  services: E2eServices,
  target: World,
  taskId: string,
  attempt = 1,
  approval?: { state: 'NONE' | 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED'; targetIdempotencyKey?: string | null },
): Promise<DispatchOutcome> {
  const lease = await services.reconciler.acquireLease(target.projectId);
  if (!lease) throw new Error('the project under test must be leasable');
  const decisionId = createDecisionId();
  const idempotencyKey = `pc:v1:${target.projectId}:dispatch:${taskId}:${attempt}`;
  try {
    await services.db.$transaction(async (tx) => {
      const captured = await services.decisions.capture(tx, target.projectId);
      const outcome = planProjectDecision(captured.input, {
        decisionId,
        // §8.2: a PLAN is written the way the audit spells everything — Base62 — while the ledger
        // row below is keyed by the internal id. `plannedActions` does exactly this for the one
        // action the orchestrator plans itself, and a rig that planned the internal spelling would
        // be testing a key shape production never writes.
        actions: [{
          type: 'DISPATCH_TASK',
          idempotencyKey: publicIdempotencyKey(idempotencyKey),
          subject: { type: 'TASK', id: publicId(taskId) },
        }],
      });
      await services.decisions.persist(tx, captured, outcome, decisionId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const result = await services.dispatcher.dispatch(lease, {
      decisionId, taskId, idempotencyKey, approval,
    });
    const action = await services.db.projectAction.findUniqueOrThrow({
      where: { id: result.action.actionId },
    });
    return {
      refusalCode: action.refusalCode,
      reasonCode: action.reasonCode,
      status: action.status,
      applyStatus: result.action.status,
      sessionId: result.sessionId,
      actionId: action.id,
    };
  } finally {
    await services.reconciler.releaseLease(lease);
  }
}

/** Base62 as the audit protocol spells an id, without importing the codec into every scenario. */
export function publicId(uuid: string): string {
  return uuidToBase62(uuid);
}

/** Any raw UUID left in a payload the control surface serves — AC1's Base62 rule, as a predicate. */
export const RAW_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Every raw UUID reachable in a served payload, with the path that leads to it. */
export function rawUuidPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return RAW_UUID.test(value) ? [`${path} = ${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => rawUuidPaths(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => rawUuidPaths(item, `${path}.${key}`));
  }
  return [];
}
