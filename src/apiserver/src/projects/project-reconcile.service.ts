import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ProjectEventEnvelope,
  ProjectEventHandleResult,
  ProjectEventHandler,
  ProjectEventsService,
} from './project-events.service';

export const PROJECT_RECONCILE_LEASE_MS = 60_000;
export const PROJECT_RECONCILE_HEARTBEAT_MS = 20_000;
export const PROJECT_RECONCILE_TIMER_MS = 10_000;
export const PROJECT_RECONCILE_BACKSTOP_MS = 60_000;
export const PROJECT_RECONCILE_STALE_MS = 5 * 60_000;

const ACTION_TYPES = [
  'DISPATCH_TASK',
  'OPEN_COORDINATOR_TURN',
  'ROTATE_COORDINATOR_SESSION',
  'RAISE_BLOCKER',
  'CLEAR_BLOCKER',
  'APPLY_VERIFICATION_VERDICT',
  'REQUEST_APPROVAL',
  'RUN_PROJECT_ACCEPTANCE',
] as const;

export type ProjectReconcileActionType = (typeof ACTION_TYPES)[number];
export type ProjectReconcileRunState =
  | 'PLANNING'
  | 'EXECUTING'
  | 'AWAITING_VERIFICATION'
  | 'BLOCKED'
  | 'AWAITING_HUMAN'
  | 'ACCEPTANCE'
  | 'SETTLED';

export interface ProjectReconcileLease {
  projectId: string;
  holder: string;
  fencingToken: bigint;
  expiresAt: Date;
}

export interface ProjectReconcileAction {
  idempotencyKey: string;
  type: ProjectReconcileActionType;
  subject: { type: string; id?: string | null };
  detail?: Prisma.InputJsonValue;
}

export type ProjectActionApplyResult =
  | { status: 'APPLIED'; actionId: string }
  | {
      status: 'ALREADY_APPLIED';
      actionId: string;
      actionStatus: 'CLAIMED' | 'APPLIED' | 'REFUSED' | 'SUPERSEDED';
    };

interface LeaseRow {
  fencingToken: bigint;
  leaseExpiresAt: Date;
}

interface ExistingActionRow {
  id: string;
  projectId: string;
  status: 'CLAIMED' | 'APPLIED' | 'REFUSED' | 'SUPERSEDED';
}

export class ProjectLeaseLostError extends Error {
  constructor(projectId: string) {
    super(`Project reconcile lease lost for ${projectId}`);
    this.name = 'ProjectLeaseLostError';
  }
}

/**
 * The Project control loop's execution substrate.
 *
 * Semantic planning is added by later units; this service owns the invariants it must build on:
 * a renewable lease with a monotonic fence, an insert-first action ledger, durable recovery wakes,
 * and one timer shared by event polling, scheduled wakes and the stale-project backstop.
 */
@Injectable()
export class ProjectReconcileService
implements ProjectEventHandler, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProjectReconcileService.name);
  private readonly instanceId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private unregisterHandler?: () => void;
  private ticking = false;
  private lastBackstopAt = 0;
  private _backstopHits = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ProjectEventsService,
  ) {}

  get backstopHits(): number {
    return this._backstopHits;
  }

  onModuleInit(): void {
    this.unregisterHandler = this.events.registerHandler(this);
    // W1: event polling, due wakes and the backstop all ride this one timer. LISTEN/NOTIFY may
    // request an immediate drain, but it creates no second clock.
    this.timer = setInterval(() => void this.tick(), PROJECT_RECONCILE_TIMER_MS);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unregisterHandler?.();
    this.unregisterHandler = undefined;
  }

  /** One deterministic pass, public for integration tests and operational recovery probes. */
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.events.drainAvailable();
      await this.enqueueScheduledWakes(now);
      if (now.getTime() - this.lastBackstopAt >= PROJECT_RECONCILE_BACKSTOP_MS) {
        this.lastBackstopAt = now.getTime();
        const hits = await this.enqueueBackstopWakes(now);
        this._backstopHits += hits;
        if (hits > 0) this.log.warn(`Project reconcile backstop found ${hits} stalled project(s)`);
      }
      // Timer/backstop rows are ordinary durable signals. Draining them here keeps a due Project
      // inside the ten-second path even if PostgreSQL NOTIFY is lost.
      await this.events.drainAvailable();
    } catch (cause) {
      this.log.error(`Project reconcile recovery tick failed: ${errorText(cause)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Event delivery callback. It re-reads current facts, never event payloads, then atomically
   * publishes the runtime state and consumes the batch under the acquired fencing token.
   */
  async handle(
    tx: Prisma.TransactionClient,
    projectId: string,
    _events: readonly ProjectEventEnvelope[],
  ): Promise<ProjectEventHandleResult> {
    const now = new Date();
    const projects = await tx.$queryRaw<Array<{
      status: 'OPEN' | 'DONE' | 'CANCELLED';
      coordinatorEnabled: boolean;
    }>>(Prisma.sql`
      SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
        FROM "project" WHERE "id" = ${projectId}::uuid
    `);
    const project = projects[0];
    if (!project) return { disposition: 'DISCARDED_OUT_OF_LOOP' };

    await this.ensureRuntime(tx, projectId, now);
    if (project.status !== 'OPEN' || !project.coordinatorEnabled) {
      // This is terminal/inert cleanup, not a reconcile. Advancing the fence invalidates a holder
      // that raced the user's stop/terminal write; applyAction also re-checks the Project row.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "project_runtime"
           SET "run_state" = ${project.status === 'OPEN' ? 'PLANNING' : 'SETTLED'}::"project_run_state",
               "next_wake_at" = NULL, "next_wake_reason" = NULL,
               "fencing_token" = "fencing_token" + CASE WHEN "lease_holder" IS NULL THEN 0 ELSE 1 END,
               "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
               "updated_at" = ${now}
         WHERE "project_id" = ${projectId}::uuid
      `);
      return { disposition: 'DISCARDED_OUT_OF_LOOP' };
    }

    const lease = await this.acquireLeaseInTransaction(tx, projectId, now);
    if (!lease) {
      const rows = await tx.$queryRaw<Array<{ leaseExpiresAt: Date | null }>>(Prisma.sql`
        SELECT "lease_expires_at" AS "leaseExpiresAt" FROM "project_runtime"
         WHERE "project_id" = ${projectId}::uuid
      `);
      return { deferUntil: contentionWake(projectId, rows[0]?.leaseExpiresAt, now) };
    }

    const state = await this.runStateOf(tx, projectId);
    const nextWakeAt = state === 'SETTLED' ? null : new Date(now.getTime() + 60_000);
    const nextWakeReason = state === 'PLANNING'
      ? 'planning requires coordinator turn'
      : state === 'EXECUTING'
        ? 'in-flight session may end'
        : state === 'AWAITING_VERIFICATION'
          ? 'verification may settle'
          : 'reconcile state recheck';
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "project_runtime"
         SET "run_state" = ${state}::"project_run_state",
             "next_wake_at" = ${nextWakeAt},
             "next_wake_reason" = ${nextWakeAt ? nextWakeReason : null},
             "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
             "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
    if (updated !== 1) throw new ProjectLeaseLostError(projectId);
    return { disposition: 'RECONCILED' };
  }

  async deadLetter(
    tx: Prisma.TransactionClient,
    projectId: string,
    _events: readonly ProjectEventEnvelope[],
    error: string,
  ): Promise<void> {
    const now = new Date();
    await this.ensureRuntime(tx, projectId, now);
    const lease = await this.acquireLeaseInTransaction(tx, projectId, now);
    if (!lease) throw new Error(`cannot persist dead-letter recovery while ${projectId} is leased`);
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "project_runtime"
         SET "run_state" = 'PLANNING',
             "next_wake_at" = ${new Date(now.getTime() + PROJECT_RECONCILE_STALE_MS)},
             "next_wake_reason" = ${`reconcile dead letter: ${errorText(error)}`},
             "lease_holder" = NULL, "lease_expires_at" = NULL, "lease_heartbeat_at" = NULL,
             "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
    if (updated !== 1) throw new ProjectLeaseLostError(projectId);
  }

  /** Persistently acquire the Project lease; returns null for an inactive, missing or busy row. */
  async acquireLease(projectId: string, now = new Date()): Promise<ProjectReconcileLease | null> {
    return this.prisma.$transaction(async (tx) => {
      const projects = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "project"
         WHERE "id" = ${projectId}::uuid AND "status" = 'OPEN' AND "coordinator_enabled" = true
         FOR NO KEY UPDATE
      `);
      if (!projects[0]) return null;
      await this.ensureRuntime(tx, projectId, now);
      return this.acquireLeaseInTransaction(tx, projectId, now);
    });
  }

  async renewLease(
    lease: ProjectReconcileLease,
    now = new Date(),
  ): Promise<ProjectReconcileLease> {
    const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
    const rows = await this.prisma.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE "project_runtime"
         SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
             "updated_at" = ${now}
       WHERE "project_id" = ${lease.projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
         AND "lease_expires_at" > ${now}
      RETURNING "fencing_token" AS "fencingToken", "lease_expires_at" AS "leaseExpiresAt"
    `);
    if (!rows[0]) throw new ProjectLeaseLostError(lease.projectId);
    return {
      ...lease,
      fencingToken: BigInt(rows[0].fencingToken),
      expiresAt: rows[0].leaseExpiresAt,
    };
  }

  async releaseLease(lease: ProjectReconcileLease): Promise<boolean> {
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "project_runtime"
         SET "lease_holder" = NULL, "lease_expires_at" = NULL,
             "lease_heartbeat_at" = NULL, "updated_at" = CURRENT_TIMESTAMP
       WHERE "project_id" = ${lease.projectId}::uuid
         AND "lease_holder" = ${lease.holder}::uuid
         AND "fencing_token" = ${lease.fencingToken}
    `);
    return updated === 1;
  }

  /**
   * Claim a permanent action key, perform its database effect, and publish APPLIED atomically.
   * `effect` must only use the supplied transaction; external side effects cannot satisfy this API.
   */
  async applyAction(
    lease: ProjectReconcileLease,
    action: ProjectReconcileAction,
    effect: (tx: Prisma.TransactionClient, actionId: string) => Promise<void>,
    now = new Date(),
  ): Promise<ProjectActionApplyResult> {
    this.assertAction(lease, action);
    return this.prisma.$transaction(async (tx) => {
      const projects = await tx.$queryRaw<Array<{
        status: 'OPEN' | 'DONE' | 'CANCELLED'; coordinatorEnabled: boolean;
      }>>(Prisma.sql`
        SELECT "status", "coordinator_enabled" AS "coordinatorEnabled"
          FROM "project" WHERE "id" = ${lease.projectId}::uuid FOR NO KEY UPDATE
      `);
      if (projects[0]?.status !== 'OPEN' || !projects[0]?.coordinatorEnabled) {
        throw new ProjectLeaseLostError(lease.projectId);
      }

      const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
      const fenced = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_runtime"
           SET "lease_heartbeat_at" = ${now}, "lease_expires_at" = ${expiresAt},
               "updated_at" = ${now}
         WHERE "project_id" = ${lease.projectId}::uuid
           AND "lease_holder" = ${lease.holder}::uuid
           AND "fencing_token" = ${lease.fencingToken}
           AND "lease_expires_at" > ${now}
      `);
      if (fenced !== 1) throw new ProjectLeaseLostError(lease.projectId);

      const actionId = randomUUID();
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "project_action" (
          "id", "project_id", "idempotency_key", "type", "status",
          "subject_type", "subject_id", "fencing_token", "detail", "updated_at"
        ) VALUES (
          ${actionId}::uuid, ${lease.projectId}::uuid, ${action.idempotencyKey},
          ${action.type}::"project_action_type", 'CLAIMED', ${action.subject.type},
          ${action.subject.id ?? null}::uuid, ${lease.fencingToken},
          ${JSON.stringify(action.detail ?? {})}::jsonb, ${now}
        )
        ON CONFLICT ("idempotency_key") DO NOTHING
        RETURNING "id"
      `);
      if (!inserted[0]) {
        const existing = (await tx.$queryRaw<ExistingActionRow[]>(Prisma.sql`
          SELECT "id", "project_id" AS "projectId", "status"
            FROM "project_action" WHERE "idempotency_key" = ${action.idempotencyKey}
        `))[0];
        if (!existing || existing.projectId !== lease.projectId) {
          throw new Error(`idempotency key ${action.idempotencyKey} belongs to another Project`);
        }
        return {
          status: 'ALREADY_APPLIED', actionId: existing.id, actionStatus: existing.status,
        } as const;
      }

      await effect(tx, actionId);
      const published = await tx.$executeRaw(Prisma.sql`
        UPDATE "project_action" SET "status" = 'APPLIED', "updated_at" = ${now}
         WHERE "id" = ${actionId}::uuid AND "status" = 'CLAIMED'
      `);
      if (published !== 1) throw new Error(`failed to publish Project action ${actionId}`);
      return { status: 'APPLIED', actionId } as const;
    });
  }

  private async acquireLeaseInTransaction(
    tx: Prisma.TransactionClient,
    projectId: string,
    now: Date,
  ): Promise<ProjectReconcileLease | null> {
    const expiresAt = new Date(now.getTime() + PROJECT_RECONCILE_LEASE_MS);
    const rows = await tx.$queryRaw<LeaseRow[]>(Prisma.sql`
      UPDATE "project_runtime"
         SET "lease_holder" = ${this.instanceId}::uuid,
             "lease_expires_at" = ${expiresAt}, "lease_heartbeat_at" = ${now},
             "fencing_token" = "fencing_token" + 1, "updated_at" = ${now}
       WHERE "project_id" = ${projectId}::uuid
         AND ("lease_holder" IS NULL OR "lease_expires_at" <= ${now})
      RETURNING "fencing_token" AS "fencingToken", "lease_expires_at" AS "leaseExpiresAt"
    `);
    if (!rows[0]) return null;
    return {
      projectId,
      holder: this.instanceId,
      fencingToken: BigInt(rows[0].fencingToken),
      expiresAt: rows[0].leaseExpiresAt,
    };
  }

  private async ensureRuntime(
    tx: Prisma.TransactionClient,
    projectId: string,
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "project_runtime" ("project_id", "created_at", "updated_at")
      VALUES (${projectId}::uuid, ${now}, ${now})
      ON CONFLICT ("project_id") DO NOTHING
    `);
  }

  private async runStateOf(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<ProjectReconcileRunState> {
    const rows = await tx.$queryRaw<Array<{
      status: 'OPEN' | 'DONE' | 'CANCELLED';
      hasLiveSession: boolean;
      hasPendingVerification: boolean;
    }>>(Prisma.sql`
      SELECT p."status",
             EXISTS (
               SELECT 1 FROM "task" t JOIN "session" s ON s."task_id" = t."id"
                WHERE t."project_id" = p."id" AND s."deleted_at" IS NULL
                  AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
             ) AS "hasLiveSession",
             EXISTS (
               SELECT 1 FROM "task" t
                WHERE t."project_id" = p."id" AND t."verifies_task_id" IS NOT NULL
                  AND t."status" <> 'DONE'
             ) AS "hasPendingVerification"
        FROM "project" p WHERE p."id" = ${projectId}::uuid
    `);
    const snapshot = rows[0];
    if (!snapshot || snapshot.status !== 'OPEN') return 'SETTLED';
    if (snapshot.hasLiveSession) return 'EXECUTING';
    if (snapshot.hasPendingVerification) return 'AWAITING_VERIFICATION';
    return 'PLANNING';
  }

  private async enqueueScheduledWakes(now: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "project_event" (
        "id", "project_id", "v", "kind", "occurred_at", "source_type", "source_id",
        "dedupe_key", "payload", "last_at"
      )
      SELECT gen_random_uuid(), p."id", 1, 'timer.due', ${now}, 'TIMER', p."id",
             'timer.due:' || r."next_wake_at"::text,
             jsonb_build_object('reason', r."next_wake_reason"), ${now}
        FROM "project" p JOIN "project_runtime" r ON r."project_id" = p."id"
       WHERE p."status" = 'OPEN' AND p."coordinator_enabled" = true
         AND r."run_state" <> 'SETTLED' AND r."next_wake_at" <= ${now}
      ON CONFLICT ("project_id", "dedupe_key") WHERE "consumed_at" IS NULL
      DO UPDATE SET "occurrences" = "project_event"."occurrences" + 1,
                    "last_at" = GREATEST("project_event"."last_at", EXCLUDED."last_at")
    `);
  }

  private async enqueueBackstopWakes(now: Date): Promise<number> {
    const staleBefore = new Date(now.getTime() - PROJECT_RECONCILE_STALE_MS);
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "project_event" (
        "id", "project_id", "v", "kind", "occurred_at", "source_type", "source_id",
        "dedupe_key", "payload", "last_at"
      )
      SELECT gen_random_uuid(), p."id", 1, 'timer.backstop', ${now}, 'TIMER', p."id",
             'timer.backstop', jsonb_build_object('detectedAt', ${now}::text), ${now}
        FROM "project" p JOIN "project_runtime" r ON r."project_id" = p."id"
       WHERE p."status" = 'OPEN' AND p."coordinator_enabled" = true
         AND r."run_state" <> 'SETTLED'
         AND (
           r."next_wake_at" < ${staleBefore}
           OR (r."next_wake_at" IS NULL
               AND (r."lease_holder" IS NULL OR r."lease_expires_at" < ${staleBefore}))
           OR EXISTS (
             SELECT 1 FROM "project_event" e
              WHERE e."project_id" = p."id" AND e."consumed_at" IS NULL
                AND COALESCE(e."next_attempt_at", e."occurred_at") < ${staleBefore}
           )
         )
      ON CONFLICT ("project_id", "dedupe_key") WHERE "consumed_at" IS NULL
      DO UPDATE SET "occurrences" = "project_event"."occurrences" + 1,
                    "last_at" = GREATEST("project_event"."last_at", EXCLUDED."last_at")
    `);
  }

  private assertAction(lease: ProjectReconcileLease, action: ProjectReconcileAction): void {
    if (!action.idempotencyKey.startsWith(`pc:v1:${lease.projectId}:`)) {
      throw new RangeError('Project action idempotency key must use pc:v1:<project UUID>:...');
    }
    if (!(ACTION_TYPES as readonly string[]).includes(action.type)) {
      throw new RangeError(`unsupported Project action type ${action.type}`);
    }
    if (!action.subject.type.trim()) throw new RangeError('Project action subject type is required');
  }
}

function contentionWake(projectId: string, expiresAt: Date | null | undefined, now: Date): Date {
  // Deterministic 0..250ms jitter spreads replicas without making the same dirty world produce a
  // different schedule after restart.
  let hash = 0;
  for (const char of projectId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  const base = Math.max(now.getTime() + 1_000, expiresAt?.getTime() ?? now.getTime());
  return new Date(base + (hash % 251));
}

function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.slice(0, 2_000);
}
