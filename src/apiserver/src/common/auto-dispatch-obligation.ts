import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export const AUTO_DISPATCH_WAKE_DELAY_MS = 60_000;
export const AUTO_DISPATCH_IN_FLIGHT_WAKE_DELAY_MS = 30_000;

export type AutoDispatchOutcome = 'ATTEMPTING' | 'REFUSED' | 'DISPATCHED' | 'SUPERSEDED';

export interface AutoDispatchDisposition {
  reasonCode: string;
  reason: string;
  owner: 'OWNER' | 'AGENT' | 'SYSTEM' | 'PROJECT_COORDINATOR';
  nextAction: string;
  wakeAt: Date | null;
}

export interface AutoDispatchObservation {
  tenantId: string;
  taskId: string;
  watermark: bigint;
  triggerKind: 'DEPENDENCY_TRIGGER' | 'READY_SWEEP';
  outcome: AutoDispatchOutcome;
  disposition: AutoDispatchDisposition;
  sessionId?: string | null;
}

export interface AutoDispatchObligation {
  factKind: 'AUTO_DISPATCH_BLOCKED';
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  capability: 'task.auto-dispatch';
  tenantId: string;
  projectId: string | null;
  taskId: string;
  taskRevision: string;
  evaluatedThroughWatermark: string;
  reasonCode: string;
  reason: string;
  owner: string;
  requiredAction: string;
  nextAction: string;
  attemptedActions: unknown[];
  wakeup: {
    wakeupId: string;
    state: string;
    dueAt: string;
    reasonCode: string;
  } | null;
  firstObservedAt: string;
  latestObservedAt: string;
  observationCount: number;
  [key: string]: unknown;
}

interface AutoDispatchObligationRow {
  tenantId: string;
  projectId: string | null;
  taskId: string;
  taskRevision: bigint;
  watermark: bigint;
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  reasonCode: string;
  reason: Prisma.JsonValue;
  owner: string;
  nextAction: string;
  attemptedActions: Prisma.JsonValue;
  firstObservedAt: Date;
  latestObservedAt: Date;
  observationCount: number;
  wakeupId: string | null;
  wakeupState: string | null;
  wakeupDueAt: Date | null;
  wakeupReasonCode: string | null;
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: unknown;
      response?: unknown;
      getResponse?: () => unknown;
    };
    const response = typeof candidate.getResponse === 'function'
      ? candidate.getResponse()
      : candidate.response;
    if (response && typeof response === 'object') {
      const body = response as Record<string, unknown>;
      const nested = body.message;
      if (typeof body.code === 'string') return `${body.code}: ${String(nested ?? '')}`;
      if (Array.isArray(nested)) return nested.join(' ');
      if (typeof nested === 'string') return nested;
    }
    if (typeof candidate.message === 'string') return candidate.message;
  }
  return String(error ?? 'UNKNOWN_AUTO_DISPATCH_FAILURE');
}

/**
 * Convert every automatic dispatch refusal into the small typed vocabulary exposed by task_get.
 * Matching is deliberately on stable codes first. PostgreSQL guard messages remain a rolling-
 * upgrade fallback for an older exception adapter that has not yet produced a structured body.
 */
export function autoDispatchFailureDisposition(
  error: unknown,
  now = new Date(),
): AutoDispatchDisposition {
  const message = errorText(error);
  const wakeAt = new Date(now.getTime() + AUTO_DISPATCH_WAKE_DELAY_MS);
  if (message.includes('TASK_RUN_REQUEST_IN_PROGRESS')) {
    return {
      reasonCode: 'DISPATCH_REQUEST_IN_PROGRESS',
      reason: 'Another delivery currently owns the same idempotent automatic dispatch request.',
      owner: 'SYSTEM',
      nextAction: 'REOBSERVE_IDEMPOTENT_DISPATCH_RECEIPT',
      wakeAt: new Date(now.getTime() + AUTO_DISPATCH_IN_FLIGHT_WAKE_DELAY_MS),
    };
  }
  if (message.includes('TASK_ALREADY_RUNNING') || message.includes('already running')) {
    return {
      reasonCode: 'ACTIVE_TASK_SESSION_EXISTS',
      reason: 'A task work session already owns the execution claim.',
      owner: 'SYSTEM',
      nextAction: 'OBSERVE_ACTIVE_TASK_SESSION',
      wakeAt,
    };
  }
  if (message.includes('DISPATCH_DEPENDENCY_CHANGED') || message.includes('Prerequisites')) {
    return {
      reasonCode: 'DEPENDENCY_WATERMARK_MOVED',
      reason: 'The dependency facts changed after this automatic dispatch delivery was selected.',
      owner: 'SYSTEM',
      nextAction: 'REEVALUATE_CURRENT_DEPENDENCY_WATERMARK',
      wakeAt,
    };
  }
  if (message.includes('PLAN_AUTHORITY_MOVED') || message.includes('DISPATCH_AUTHORITY')) {
    return {
      reasonCode: 'DISPATCH_AUTHORITY_MOVED',
      reason: 'Dispatch authority changed before the session commit gate accepted the run.',
      owner: 'SYSTEM',
      nextAction: 'REEVALUATE_CURRENT_DISPATCH_AUTHORITY',
      wakeAt,
    };
  }
  return {
    reasonCode: 'TRANSIENT_AUTO_DISPATCH_FAILURE',
    // Never persist a driver/SQL exception verbatim: it can contain query values. The stable code
    // is enough to route recovery; ordinary server logs retain the ephemeral diagnostic.
    reason: 'The automatic dispatch path failed before a session receipt was committed.',
    owner: 'SYSTEM',
    nextAction: 'RETRY_AUTO_DISPATCH_FROM_PERSISTENT_WAKEUP',
    wakeAt,
  };
}

export function autoDispatchAttemptingDisposition(now = new Date()): AutoDispatchDisposition {
  return {
    reasonCode: 'AUTO_DISPATCH_EVALUATION_IN_PROGRESS',
    reason: 'The dependency transition was observed and its idempotent dispatch request is being evaluated.',
    owner: 'SYSTEM',
    nextAction: 'COMPLETE_OR_RECOVER_IDEMPOTENT_DISPATCH',
    wakeAt: new Date(now.getTime() + AUTO_DISPATCH_IN_FLIGHT_WAKE_DELAY_MS),
  };
}

export function autoDispatchSkippedDisposition(
  skipped: string,
  now = new Date(),
): { outcome: AutoDispatchOutcome; disposition: AutoDispatchDisposition } {
  const wakeAt = new Date(now.getTime() + AUTO_DISPATCH_WAKE_DELAY_MS);
  switch (skipped) {
    case 'stale-epoch':
      return {
        outcome: 'SUPERSEDED',
        disposition: {
          reasonCode: 'DISPATCH_WATERMARK_SUPERSEDED',
          reason: 'A newer task/dependency watermark replaced this automatic dispatch delivery.',
          owner: 'SYSTEM',
          nextAction: 'REEVALUATE_CURRENT_DEPENDENCY_WATERMARK',
          wakeAt: null,
        },
      };
    case 'superseded':
    case 'target-tombstoned':
      return {
        outcome: 'SUPERSEDED',
        disposition: {
          reasonCode: 'TASK_WORK_SUPERSEDED',
          reason: 'This task attempt no longer owns the work.',
          owner: 'SYSTEM',
          nextAction: 'FOLLOW_CURRENT_SUCCESSOR',
          wakeAt: null,
        },
      };
    case 'aggregate-parent':
      return {
        outcome: 'REFUSED',
        disposition: {
          reasonCode: 'AGGREGATE_PARENT_HAS_NO_DIRECT_WORK',
          reason: 'This task is completed by aggregating children and cannot start its own work session.',
          owner: 'AGENT',
          nextAction: 'RUN_OR_REPAIR_CHILD_TASKS',
          wakeAt,
        },
      };
    default:
      return {
        outcome: 'REFUSED',
        disposition: autoDispatchFailureDisposition(skipped, now),
      };
  }
}

/** One atomic PostgreSQL boundary for attempt counting, canonical revision, event and wakeup. */
export async function recordAutoDispatchObservation(
  prisma: PrismaService,
  input: AutoDispatchObservation,
): Promise<Record<string, unknown>> {
  if (!hasAutoDispatchPersistence(prisma)) return { recorded: false };
  const [row] = await prisma.$queryRaw<Array<{ result: Prisma.JsonValue }>>(Prisma.sql`
    SELECT task_auto_dispatch_record(
      ${input.tenantId}::uuid,
      ${input.taskId}::uuid,
      ${input.watermark}::bigint,
      ${input.triggerKind},
      ${input.outcome},
      ${input.disposition.reasonCode},
      ${JSON.stringify({
        code: input.disposition.reasonCode,
        message: input.disposition.reason,
        nextAction: input.disposition.nextAction,
      })}::jsonb,
      ${input.disposition.owner},
      ${input.disposition.nextAction},
      ${input.sessionId ?? null}::uuid,
      ${input.disposition.wakeAt}
    ) AS result
  `);
  if (!row) throw new Error('AUTO_DISPATCH_OBSERVATION_NOT_RECORDED');
  return row.result as unknown as Record<string, unknown>;
}

export interface AutoDispatchObligationScope {
  tenantId: string;
  projectIds?: readonly string[];
  taskIds?: readonly string[];
}

/**
 * Focused service unit tests intentionally provide a partial Prisma double. The generated delegate
 * is a better rolling-safe capability check than accepting any object with a `$queryRaw` function:
 * the latter includes recorders whose next canned SELECT must not be consumed by this overlay.
 */
function hasAutoDispatchPersistence(prisma: PrismaService): boolean {
  const raw = prisma as unknown as {
    $queryRaw?: unknown;
    $queryRawUnsafe?: unknown;
    taskAutoDispatchState?: unknown;
  };
  return typeof raw.$queryRaw === 'function'
    && typeof raw.$queryRawUnsafe === 'function'
    && typeof raw.taskAutoDispatchState === 'object'
    && raw.taskAutoDispatchState !== null;
}

export async function readAutoDispatchObligations(
  prisma: PrismaService,
  scope: AutoDispatchObligationScope,
): Promise<AutoDispatchObligation[]> {
  if (!hasAutoDispatchPersistence(prisma)) return [];
  if (scope.projectIds?.length === 0 || scope.taskIds?.length === 0) return [];
  const projectFilter = scope.projectIds
    ? Prisma.sql`AND state.project_id IN (${Prisma.join(scope.projectIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const taskFilter = scope.taskIds
    ? Prisma.sql`AND state.task_id IN (${Prisma.join(scope.taskIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<AutoDispatchObligationRow[]>(Prisma.sql`
    SELECT state.tenant_id AS "tenantId", state.project_id AS "projectId",
           state.task_id AS "taskId", state.task_revision AS "taskRevision",
           state.watermark, state.obligation_id AS "obligationId",
           state.obligation_revision AS "obligationRevision",
           revision.binding_digest AS "bindingDigest",
           revision.reason_code AS "reasonCode", revision.reason,
           revision.owner, revision.next_action AS "nextAction",
           COALESCE(state.attempted_actions, '[]'::jsonb) AS "attemptedActions",
           state.first_observed_at AS "firstObservedAt",
           state.latest_observed_at AS "latestObservedAt",
           state.observation_count::int AS "observationCount",
           wake.wakeup_id AS "wakeupId", wake.state AS "wakeupState",
           wake.due_at AS "wakeupDueAt", wake.reason_code AS "wakeupReasonCode"
      FROM task_auto_dispatch_state state
      JOIN task_dispatch_epoch epoch
        ON epoch.task_id = state.task_id AND epoch.epoch = state.watermark
      JOIN task_auto_dispatch_obligation_revision revision
        ON revision.tenant_id = state.tenant_id
       AND revision.task_id = state.task_id
       AND revision.obligation_revision = state.obligation_revision
      LEFT JOIN LATERAL (
        SELECT pending.wakeup_id, pending.state, pending.due_at, pending.reason_code
          FROM task_auto_dispatch_wakeup pending
         WHERE pending.tenant_id = state.tenant_id
           AND pending.task_id = state.task_id
           AND pending.watermark = state.watermark
           AND pending.obligation_revision = state.obligation_revision
         ORDER BY pending.generation DESC
         LIMIT 1
      ) wake ON true
     WHERE state.tenant_id = ${scope.tenantId}::uuid
       AND state.state = 'ACTIVE'
       ${projectFilter} ${taskFilter}
     ORDER BY state.first_observed_at, state.obligation_id
  `);
  return rows.map((row) => {
    const reason = row.reason && typeof row.reason === 'object' && !Array.isArray(row.reason)
      ? row.reason as Record<string, unknown>
      : {};
    return {
      factKind: 'AUTO_DISPATCH_BLOCKED',
      obligationId: row.obligationId,
      obligationRevision: row.obligationRevision,
      bindingDigest: row.bindingDigest,
      capability: 'task.auto-dispatch',
      tenantId: row.tenantId,
      projectId: row.projectId,
      taskId: row.taskId,
      taskRevision: row.taskRevision.toString(),
      evaluatedThroughWatermark: row.watermark.toString(),
      reasonCode: row.reasonCode,
      reason: String(reason.message ?? row.reasonCode),
      owner: row.owner,
      requiredAction: row.nextAction,
      nextAction: row.nextAction,
      attemptedActions: Array.isArray(row.attemptedActions) ? row.attemptedActions : [],
      wakeup: row.wakeupId && row.wakeupDueAt
        ? {
            wakeupId: row.wakeupId,
            state: row.wakeupState ?? 'UNKNOWN',
            dueAt: row.wakeupDueAt.toISOString(),
            reasonCode: row.wakeupReasonCode ?? row.reasonCode,
          }
        : null,
      firstObservedAt: row.firstObservedAt.toISOString(),
      latestObservedAt: row.latestObservedAt.toISOString(),
      observationCount: row.observationCount,
    };
  });
}

export function autoDispatchObligationsBy(
  rows: readonly AutoDispatchObligation[],
  key: 'projectId' | 'taskId',
): Map<string, AutoDispatchObligation[]> {
  const grouped = new Map<string, AutoDispatchObligation[]>();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    const current = grouped.get(value) ?? [];
    current.push(row);
    grouped.set(value, current);
  }
  return grouped;
}
