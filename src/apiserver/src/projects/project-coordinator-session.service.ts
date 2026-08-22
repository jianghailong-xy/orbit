import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  ROOT_FALLBACK_PERMISSION_MODE,
  base62ToUuid,
  permissionModeAvailableOnRunner,
  uuidToBase62,
} from '@orbit/shared';
import { normalizeRuntimeProvider } from '../common/runtime-provider';
import { resolvePermissionMode } from '../common/permission-mode';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { makeBranchName } from '../sessions/naming';
import {
  ProjectApprovalState,
  ProjectAuthorizationService,
  ProjectAutomationPolicyValue,
} from './project-authorization.service';
import {
  ProjectActionApplyResult,
  ProjectActionEffectRefusal,
  ProjectReconcileLease,
  ProjectReconcileService,
  ProjectRotationExecutor,
} from './project-reconcile.service';
import {
  PlannedCoordinatorRotation,
  isLiveSessionStatus,
  rotateCoordinatorSessionIdempotencyKey,
  rotationReasonCode,
} from './project-coordinator-session';
import { buildCoordinatorOpening, coordinatorSessionTitle } from './coordinator-opening';

export interface RotateCoordinatorSessionCommand {
  decisionId: string;
  /** The `ROTATE` plan `planCoordinatorSessionRotation` produced, ids in Base62 exactly as planned. */
  planned: PlannedCoordinatorRotation;
  approval?: {
    state: ProjectApprovalState;
    targetIdempotencyKey?: string | null;
  };
}

export interface RotateCoordinatorSessionResult {
  action: ProjectActionApplyResult;
  /** The new coordination run, or null whenever this rotation was refused or replayed. */
  sessionId: string | null;
}

interface RotationRow {
  ownerId: string;
  title: string;
  /** §9.2's policy, so the run that replaces this one opens on the project's CURRENT terms. */
  automationPolicy: ProjectAutomationPolicyValue;
  coordinatorSessionId: string | null;
  coordinatorWorkspaceId: string | null;
  coordinatorGeneration: bigint;
  currentStatus: string | null;
  currentDeletedAt: Date | null;
  landingId: string | null;
  landingEnabled: boolean | null;
  landingDeletedAt: Date | null;
  enableWorktree: boolean | null;
  runnerId: string | null;
  seatAgentId: string | null;
  ownerPreferences: unknown;
  sourceDecisionInputHash: string;
}

/**
 * §7.5 — the one path that replaces a project's coordination run.
 *
 * A rotation is not a migration and not a re-election: the AGENT stays (0113's trigger freezes it
 * across this write), the LANDING stays (the database refuses a session that opens anywhere else),
 * and only the conversation is new. Everything happens inside the action ledger's transaction, so
 * the ledger row, the session and the pointer commit together under one permanent key whose epoch —
 * `coordinator_generation + 1` — is the one counter here that never goes back (§8.2 GE1).
 *
 * The clear and the write are ONE statement, which §7.5 asks for by name: `coordinator_session_id`
 * is `@unique`, so a two-statement rotation would let a concurrent one collide on the index and
 * leave the project with no coordinator at all.
 */
@Injectable()
export class ProjectCoordinatorSessionService
implements ProjectRotationExecutor, OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciler: ProjectReconcileService,
    private readonly authorization: ProjectAuthorizationService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * The production wiring, and the whole of it: from here on the reconcile pass that DECIDES a
   * rotation is the pass that PERFORMS it, inside its own commit. Nothing else drives §7.5 — no
   * poll of its own, no second timer, no endpoint that has to be called.
   */
  onModuleInit(): void {
    this.unregister = this.reconciler.registerRotationExecutor(this);
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  /** §8.2's key, as the ledger stores it. Part of `ProjectRotationExecutor`. */
  idempotencyKey(projectId: string, generation: string): string {
    return rotateCoordinatorSessionIdempotencyKey(projectId, generation);
  }

  /** The audit face of a planned rotation: Base62 throughout, no wall clock. */
  actionDetail(planned: PlannedCoordinatorRotation): Prisma.InputJsonValue {
    return {
      v: 1,
      trigger: planned.trigger,
      generation: planned.generation,
      fromSessionId: planned.fromSessionId,
      landingWorkspaceId: planned.landingWorkspaceId,
      coordinatorAgentId: planned.coordinatorAgentId,
      reasonDigest: planned.reasonDigest,
    } as unknown as Prisma.InputJsonValue;
  }

  /** Post-commit only (see `ProjectRotationExecutor.announce`). */
  announce(sessionId: string): void {
    this.queue.notifySessionQueued();
    this.realtime.publishSessionCreated(sessionId);
  }

  /**
   * The out-of-loop entry: one rotation in a transaction of its own, for a holder that has a lease
   * and a decision but is not inside a reconcile pass. The loop does NOT come through here — it
   * calls `rotateInTransaction` inside its own commit — so this exists for recovery and for the
   * control surface, and it shares every guard with the production path by sharing the effect.
   */
  async rotate(
    lease: ProjectReconcileLease,
    command: RotateCoordinatorSessionCommand,
    now = new Date(),
  ): Promise<RotateCoordinatorSessionResult> {
    const action = await this.reconciler.applyDecisionAction(
      lease,
      command.decisionId,
      {
        type: 'ROTATE_COORDINATOR_SESSION',
        idempotencyKey: rotateCoordinatorSessionIdempotencyKey(
          lease.projectId,
          command.planned.generation,
        ),
        // The PROJECT is the subject. A rotation is a statement about which conversation this
        // project is coordinated from; the session it produces is its result, not its subject.
        subject: { type: 'PROJECT', id: lease.projectId },
        detail: this.actionDetail(command.planned),
      },
      async (tx, actionId) => this.rotateInTransaction(tx, lease, command, actionId, now),
      now,
    );
    const result = await this.prisma.projectAction.findUnique({
      where: { id: action.actionId },
      select: { resultSessionId: true },
    });
    if (action.status === 'APPLIED' && result?.resultSessionId) {
      this.announce(result.resultSessionId);
    }
    return { action, sessionId: result?.resultSessionId ?? null };
  }

  async rotateInTransaction(
    tx: Prisma.TransactionClient,
    lease: ProjectReconcileLease,
    command: RotateCoordinatorSessionCommand,
    actionId: string,
    now: Date,
  ): Promise<void | ProjectActionEffectRefusal> {
    const planned = command.planned;
    const landingId = base62ToUuid(planned.landingWorkspaceId);
    // One read, in §8.6 LO1's order: `project` (already locked FOR NO KEY UPDATE by the ledger),
    // then `project_runtime`, then the coordination workspace and its runner FOR SHARE. Nothing
    // below re-reads the plan for a fact the database can state — §6.3: a pass re-reads the world,
    // never the signal that woke it.
    const rows = await tx.$queryRaw<RotationRow[]>(Prisma.sql`
      SELECT p."owner_id" AS "ownerId", p."title",
             p."automation_policy"::text AS "automationPolicy",
             p."coordinator_session_id" AS "coordinatorSessionId",
             p."coordinator_workspace_id" AS "coordinatorWorkspaceId",
             r."coordinator_generation" AS "coordinatorGeneration",
             current."status"::text AS "currentStatus",
             current."deleted_at" AS "currentDeletedAt",
             landing."id" AS "landingId", landing."enabled" AS "landingEnabled",
             landing."deleted_at" AS "landingDeletedAt",
             landing."enable_worktree" AS "enableWorktree",
             landing."runner_id" AS "runnerId",
             seat."agent_id" AS "seatAgentId",
             u."preferences" AS "ownerPreferences",
             d."decision_input_hash" AS "sourceDecisionInputHash"
        FROM "project_decision" d
        JOIN "project" p ON p."id" = d."project_id"
        JOIN "project_runtime" r ON r."project_id" = p."id"
        JOIN "user" u ON u."id" = p."owner_id"
        LEFT JOIN "session" current ON current."id" = p."coordinator_session_id"
        LEFT JOIN "workspace" landing
               ON landing."id" = ${landingId}::uuid AND landing."owner_id" = p."owner_id"
        LEFT JOIN "project_member" seat
               ON seat."project_id" = p."id" AND seat."role" = 'COORDINATOR'
       WHERE d."id" = ${command.decisionId}::uuid
         AND d."project_id" = ${lease.projectId}::uuid
    `);
    const row = rows[0];
    if (!row) return refusal('PROJECT_NOT_OPEN', 'PROJECT_NOT_OPEN');

    // §8.2 GE1: the epoch this key was built from is `coordinator_generation + 1` as the SNAPSHOT
    // read it. A generation that has moved means somebody already rotated — the key this pass would
    // claim is not the key for the run that is needed now, so it is refused rather than applied
    // under a name that belongs to a different run.
    if (BigInt(planned.generation) !== row.coordinatorGeneration + 1n) {
      return refusal('COORDINATOR_GENERATION_MOVED', 'COORDINATOR_GENERATION_MOVED', {
        expectedGeneration: planned.generation,
        actualGeneration: String(row.coordinatorGeneration),
      });
    }
    // The condition, re-asked of the committed row. A late reply, a redelivered event or a takeover
    // that re-plans the same rotation all arrive here, and any of them may find the conversation
    // alive again — a coordinator that was INTERRUPTED and resumed is the ordinary case.
    if (row.coordinatorSessionId
      && row.currentStatus
      && !row.currentDeletedAt
      && isLiveSessionStatus(row.currentStatus)) {
      return refusal('COORDINATOR_SESSION_LIVE', 'COORDINATOR_SESSION_LIVE', {
        coordinatorSessionId: uuidToBase62(row.coordinatorSessionId),
        runStatus: row.currentStatus,
      });
    }
    // §7.5 落点固定, asked twice on purpose: here, so the refusal is a typed audit row a blocker can
    // be built from, and again in the database, so it holds for a writer that never ran this code.
    if (row.coordinatorWorkspaceId !== landingId) {
      return refusal('COORDINATION_WORKSPACE_MOVED', 'COORDINATION_WORKSPACE_MOVED', {
        plannedWorkspaceId: planned.landingWorkspaceId,
        actualWorkspaceId: row.coordinatorWorkspaceId
          ? uuidToBase62(row.coordinatorWorkspaceId)
          : null,
      });
    }
    if (!row.landingId || row.landingDeletedAt || row.landingEnabled !== true || !row.runnerId) {
      return refusal('COORDINATION_WORKSPACE_UNAVAILABLE', 'COORDINATION_WORKSPACE_UNAVAILABLE', {
        landingWorkspaceId: planned.landingWorkspaceId,
        bound: row.landingId != null,
        runnerBound: row.runnerId != null,
      });
    }
    if (!row.seatAgentId || uuidToBase62(row.seatAgentId) !== planned.coordinatorAgentId) {
      return refusal('COORDINATOR_NOT_ASSIGNED', 'COORDINATOR_NOT_ASSIGNED', {
        plannedAgentId: planned.coordinatorAgentId,
        seatedAgentId: row.seatAgentId ? uuidToBase62(row.seatAgentId) : null,
      });
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "workspace" WHERE "id" = ${landingId}::uuid FOR SHARE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "runner" WHERE "id" = ${row.runnerId}::uuid FOR SHARE
    `);

    // §9.2's matrix, through the same adapter every other gated action uses. A rotation is
    // `COORDINATOR_ROUTINE`: allowed under GUARDED_AUTO and AUTO, an approval request under MANUAL.
    const audit = await this.authorization.authorizeInTransaction(tx, {
      ownerId: row.ownerId,
      projectId: lease.projectId,
      coordinatorAgentId: row.seatAgentId,
      idempotencyKey: rotateCoordinatorSessionIdempotencyKey(lease.projectId, planned.generation),
      action: 'ROTATE_COORDINATOR_SESSION',
      sourceDecisionInputHash: row.sourceDecisionInputHash,
      currentActionId: actionId,
      approval: command.approval,
    }, now);
    if (!audit) return refusal('PROJECT_NOT_OPEN', 'PROJECT_NOT_OPEN');
    if (audit.result.decision !== 'ALLOW') {
      return refusal(audit.result.reasonCode, audit.result.reasonCode, { authorization: audit });
    }

    const seed = await tx.$queryRaw<Array<{ provider: string; providerBuiltin: boolean }>>(Prisma.sql`
      SELECT "provider", "provider_builtin" AS "providerBuiltin" FROM "session"
       WHERE "workspace_id" = ${landingId}::uuid AND "task_id" IS NULL
         AND "parent_session_id" IS NULL
       ORDER BY "created_at" DESC LIMIT 1
    `);
    const provider = seed[0]?.provider ?? AgentProvider.CLAUDE;
    const providerBuiltin = seed[0]?.providerBuiltin ?? true;
    const configured = providerBuiltin ? [] : await tx.$queryRaw<Array<{ runtime: string }>>(Prisma.sql`
      SELECT "runtime" FROM "model_provider"
       WHERE "slug" = ${provider} AND "enabled" = true
         AND ("owner_id" IS NULL OR "owner_id" = ${row.ownerId}::uuid)
       ORDER BY "owner_id" NULLS LAST LIMIT 1
    `);
    const runtime = providerBuiltin
      ? normalizeRuntimeProvider(provider, true)
      : normalizeRuntimeProvider(configured[0]?.runtime ?? AgentProvider.CLAUDE);
    const [runner] = await tx.$queryRaw<Array<{ runsAsRoot: boolean | null }>>(Prisma.sql`
      SELECT "runs_as_root" AS "runsAsRoot" FROM "runner" WHERE "id" = ${row.runnerId}::uuid
    `);
    // Freeze the owner's permission INTENT, not a model-dependent effective mode. Rotations use
    // the runtime default model, so no model exists at this boundary; Queue resolves that model
    // and performs the Auto -> Default compatibility fallback immediately before dispatch. The
    // root-runner Bypass fallback is the deliberate exception: that runner can never honour the
    // mode, so (as in SessionsService) persist the safe narrowing that the run will actually use.
    const permissionIntent = resolvePermissionMode(null, { preferences: row.ownerPreferences });
    const permissionMode = permissionModeAvailableOnRunner(
      permissionIntent,
      runner?.runsAsRoot ?? null,
    )
      ? permissionIntent
      : ROOT_FALLBACK_PERMISSION_MODE;

    const title = coordinatorSessionTitle(row.title);
    const resolution = {
      v: 1,
      who: { agentId: uuidToBase62(row.seatAgentId), source: 'project-coordinator' },
      with: { provider, model: null, effort: null, source: 'coordinator-seed' },
      where: {
        workspaceId: planned.landingWorkspaceId,
        runnerId: uuidToBase62(row.runnerId),
        source: 'project-coordination-workspace',
        required: [] as string[],
        candidatesConsidered: 1,
      },
      rotation: {
        generation: planned.generation,
        trigger: planned.trigger,
        fromSessionId: planned.fromSessionId,
      },
    };
    const executionResult = {
      provider,
      model: null,
      workspaceId: landingId,
      runnerId: row.runnerId,
      permissionMode,
      requiredCapabilities: [] as string[],
      resolution,
    };
    const executionContext = {
      v: 1,
      decisionId: command.decisionId,
      actionId,
      frozenAt: now.toISOString(),
      authorization: audit,
      result: executionResult,
    };
    const [digests] = await tx.$queryRaw<Array<{ authorization: string; result: string }>>(Prisma.sql`
      SELECT "coordinator_json_digest"(${JSON.stringify(audit)}::jsonb) AS "authorization",
             "coordinator_json_digest"(${JSON.stringify(executionContext)}::jsonb - 'authorization') AS "result"
    `);
    if (!digests) throw new Error('failed to freeze Project rotation context');
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action"
         SET "execution_context" = ${JSON.stringify(executionContext)}::jsonb,
             "execution_context_digest" = ${digests.authorization},
             "execution_result_digest" = ${digests.result},
             "reason_code" = ${rotationReasonCode(planned.reasonDigest)},
             "detail" = "detail" || ${JSON.stringify({ authorization: audit, resolution })}::jsonb,
             "updated_at" = ${now}
       WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
    `);

    const sessionId = randomUUID();
    const runtimeSessionId = randomUUID();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "session" (
        "id", "title", "branch", "prompt", "status", "provider", "provider_builtin",
        "runtime_session_id", "model", "uses_runtime_default_model", "permission_mode",
        "effort", "workspace_id", "assigned_runner_id", "task_id", "source",
        "creator_id", "owner_id", "project_action_id", "dispatch_origin", "run_source",
        "resolution", "snapshot_frozen_at", "required_capabilities",
        "execution_pin_generation", "updated_at"
      ) VALUES (
        ${sessionId}::uuid, ${title}, ${row.enableWorktree ? makeBranchName(title) : null},
        ${buildCoordinatorOpening(row.title, lease.projectId, row.automationPolicy)}, 'PENDING',
        ${provider}, ${providerBuiltin},
        ${runtime === AgentProvider.CLAUDE ? runtimeSessionId : null}::uuid, ${null}, true,
        ${permissionMode}, ${null},
        ${landingId}::uuid, ${row.runnerId}::uuid, ${null}::uuid, 'user',
        ${row.ownerId}::uuid, ${row.ownerId}::uuid, ${actionId}::uuid,
        'PROJECT_COORDINATOR', 'PROJECT_COORDINATOR', ${JSON.stringify(resolution)}::jsonb,
        ${now}, ${[]}::text[], ${lease.fencingToken}, ${now}
      )
    `);

    // §7.5's `@unique` clause: one statement clears the old pointer and writes the new one, so a
    // concurrent rotation can neither collide on the index nor observe a project with none. The
    // compare-and-set is on the value read under this transaction's project row lock, so it cannot
    // lose a race — a zero here would mean the lock did not hold, which is not a refusal but a
    // broken invariant, and §8.5 C3 says the only legal answer to that is to roll the whole thing
    // back. The generation is advanced by `project_coordinator_rotation_count` (0113) at COMMIT.
    const swapped = await tx.$executeRaw(Prisma.sql`
      UPDATE "project"
         SET "coordinator_session_id" = ${sessionId}::uuid, "updated_at" = ${now}
       WHERE "id" = ${lease.projectId}::uuid
         AND "owner_id" = ${row.ownerId}::uuid
         AND "coordinator_session_id" IS NOT DISTINCT FROM ${row.coordinatorSessionId}::uuid
    `);
    if (swapped !== 1) {
      throw new Error(`Project ${lease.projectId} coordinator pointer moved under its row lock`);
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "project_action" SET "result_session_id" = ${sessionId}::uuid, "updated_at" = ${now}
       WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
    `);
  }
}

function refusal(
  refusalCode: string,
  reasonCode: string,
  detail?: Record<string, unknown>,
): ProjectActionEffectRefusal {
  const retryable = reasonCode === 'COORDINATOR_SESSION_LIVE'
    || reasonCode === 'COORDINATOR_GENERATION_MOVED'
    || reasonCode === 'COORDINATION_WORKSPACE_MOVED'
    || reasonCode === 'SESSION_BUDGET_EXHAUSTED';
  return {
    status: 'REFUSED',
    refusalCode,
    reasonCode,
    detail: JSON.parse(JSON.stringify({
      ...(detail ?? {}),
      rotationFailure: { v: 1, refusalCode, reasonCode, retryable },
    })) as Prisma.InputJsonValue,
  };
}
