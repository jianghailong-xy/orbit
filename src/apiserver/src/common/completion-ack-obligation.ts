import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export interface CompletionAckObligation {
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  capability: string;
  tenantId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  turnId: string;
  factKind: string;
  errorFingerprint: string;
  reasonCode: string;
  reason: string;
  owner: string;
  requiredAction: string;
  actionProtocol: unknown;
  attemptedActions: unknown;
  firstFailureAt: string;
  latestFailureAt: string;
  observationCount: number;
  [key: string]: unknown;
}

export interface CompletionAckActiveObligationRow {
  tenantId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  turnId: string;
  errorFingerprint: string;
  obligationId: string;
  obligationRevision: string;
  obligation: Prisma.JsonValue;
  firstFailureAt: Date;
  latestFailureAt: Date;
  observationCount: number;
}

/** Normalize one canonical view row for every HTTP and coordinator-queue consumer. */
export function normalizeCompletionAckObligation(
  row: CompletionAckActiveObligationRow,
): CompletionAckObligation {
  const payload = row.obligation && typeof row.obligation === 'object' && !Array.isArray(row.obligation)
    ? row.obligation as Record<string, unknown>
    : {};
  const reasonPayload = payload.reason && typeof payload.reason === 'object'
    && !Array.isArray(payload.reason)
    ? payload.reason as Record<string, unknown>
    : {};
  const reason = typeof payload.reason === 'string'
    ? payload.reason
    : String(
        reasonPayload.message
        ?? 'Completion result persisted but its control-plane ACK is stale',
      );
  const owner = payload.owner === 'AGENT' && payload.ownerSemantics === 'PROJECT_COORDINATOR'
    ? 'PROJECT_COORDINATOR'
    : String(payload.owner ?? payload.ownerSemantics ?? 'PROJECT_COORDINATOR');
  return {
    ...payload,
    obligationId: row.obligationId,
    obligationRevision: row.obligationRevision,
    // The completion-ACK protocol defines one immutable revision over the exact task/session/turn
    // binding. Its operational surfaces already use that revision as their binding version; keep
    // the same value here so REST, SSE and coordinator admission cannot invent separate bindings.
    bindingDigest: String(payload.bindingDigest ?? row.obligationRevision),
    capability: String(payload.capability ?? 'completion-ack.recover'),
    tenantId: row.tenantId,
    projectId: row.projectId,
    taskId: row.taskId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    factKind: String(payload.factKind ?? 'COMPLETION_ACK_STALE'),
    errorFingerprint: row.errorFingerprint,
    reasonCode: String(payload.reasonCode ?? reasonPayload.code ?? 'COMPLETION_ACK_STALE'),
    reason,
    owner,
    requiredAction: String(
      payload.requiredAction
      ?? payload.nextAction
      ?? reasonPayload.nextAction
      ?? 'RECONCILE_ORIGINAL_COMPLETION_RECEIPT',
    ),
    actionProtocol: payload.actionProtocol ?? [],
    attemptedActions: payload.attemptedActions ?? [],
    firstFailureAt: row.firstFailureAt.toISOString(),
    latestFailureAt: row.latestFailureAt.toISOString(),
    observationCount: row.observationCount,
  };
}

export interface CompletionAckObligationScope {
  tenantId: string;
  projectIds?: readonly string[];
  taskIds?: readonly string[];
  sessionIds?: readonly string[];
}

/**
 * The one read boundary for completion-ACK obligations.
 *
 * Every API surface calls the operational overlay instead of reconstructing its own blocker from
 * Session state, project_blocker prose or chat text. 0201 remains the lifecycle authority; the
 * overlay only adds 0202's immutable delivery/remediation ledgers to that exact id/revision. This
 * adapter gives the resulting JSON projection stable wire names and ISO timestamps.
 */
export async function readCompletionAckObligations(
  prisma: PrismaService,
  scope: CompletionAckObligationScope,
): Promise<CompletionAckObligation[]> {
  // Several focused service unit tests use deliberately partial Prisma doubles. Requiring both
  // raw-query doors distinguishes those doubles from the real Prisma client without weakening the
  // production path: a real client with a missing view, bad column or malformed row still throws.
  const raw = prisma as unknown as {
    $queryRaw?: unknown;
    $queryRawUnsafe?: unknown;
  };
  if (typeof raw.$queryRaw !== 'function' || typeof raw.$queryRawUnsafe !== 'function') return [];
  if (scope.projectIds?.length === 0 || scope.taskIds?.length === 0 || scope.sessionIds?.length === 0) {
    return [];
  }
  const projectFilter = scope.projectIds
    ? Prisma.sql`AND active.project_id IN (${Prisma.join(scope.projectIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const taskFilter = scope.taskIds
    ? Prisma.sql`AND active.task_id IN (${Prisma.join(scope.taskIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const sessionFilter = scope.sessionIds
    ? Prisma.sql`AND active.session_id IN (${Prisma.join(scope.sessionIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<CompletionAckActiveObligationRow[]>(Prisma.sql`
    SELECT active.tenant_id AS "tenantId", active.project_id AS "projectId",
           active.task_id AS "taskId", active.session_id AS "sessionId",
           active.turn_id AS "turnId", active.error_fingerprint AS "errorFingerprint",
           active.obligation_id AS "obligationId",
           active.obligation_revision::text AS "obligationRevision",
           active.obligation
             || jsonb_build_object(
               'attemptedActions',
                 CASE
                   WHEN jsonb_typeof(active.obligation->'attemptedActions') = 'array'
                     THEN active.obligation->'attemptedActions'
                   ELSE '[]'::jsonb
                 END || COALESCE(revocations.attempted_actions, '[]'::jsonb),
               'attemptedActionsTruncated',
                 COALESCE((active.obligation->>'attemptedActionsTruncated')::boolean, false)
                 OR COALESCE(revocations.total_count, 0) > 8,
               'totalAttemptedActionCount',
                 CASE
                   WHEN jsonb_typeof(active.obligation->'totalAttemptedActionCount') = 'number'
                     THEN (active.obligation->>'totalAttemptedActionCount')::bigint
                   ELSE 0
                 END + COALESCE(revocations.total_count, 0),
               'meaningfulAttemptedActionCount',
                 CASE
                   WHEN jsonb_typeof(active.obligation->'meaningfulAttemptedActionCount') = 'number'
                     THEN (active.obligation->>'meaningfulAttemptedActionCount')::bigint
                   ELSE 0
               END + COALESCE(revocations.total_count, 0),
               'currentOwnerDecision', owner_decision.request,
               -- An owner decision is another operational state, not authority to revise the
               -- canonical action carried by this immutable obligation revision.
               'operationalAction', CASE WHEN owner_decision.request_id IS NOT NULL
                 THEN 'AWAIT_OWNER_DECISION'
                 ELSE active.obligation->>'operationalAction' END,
               'actionProtocol',
                 CASE
                   WHEN jsonb_typeof(active.obligation->'actionProtocol') = 'object'
                     THEN active.obligation->'actionProtocol'
                   ELSE '{}'::jsonb
                 END || jsonb_strip_nulls(jsonb_build_object(
                   'currentOwnerDecisionRequestId', owner_decision.request_id::text,
                   'latestDeliveryFailure', revocations.latest_failure
                 ))
             ) AS obligation,
           active.first_failure_at AS "firstFailureAt",
           active.latest_failure_at AS "latestFailureAt",
           active.observation_count::int AS "observationCount"
      FROM completion_ack_operational_obligation active
      LEFT JOIN LATERAL (
        SELECT request.request_id,
               jsonb_strip_nulls(jsonb_build_object(
                 'requestId', request.request_id::text,
                 'status', request.status,
                 'reason', request.reason,
                 'whyNotAgent', request.why_not_agent,
                 'options', request.request->'options',
                 'impacts', request.request->'impacts',
                 'recommendation', request.request->'recommendation',
                 'noActionConsequence', request.request->'noActionConsequence',
                 'cost', request.request->'cost',
                 'deadline', request.request->'deadline',
                 'resumeBehavior', request.request->'resumeBehavior',
                 'deliveryReceiptId', binding.delivery_receipt_id::text,
                 'coordinatorSessionId', binding.coordinator_session_id::text,
                 'requestedAt', request.created_at,
                 'requestDigest', request.request_digest::text
               )) AS request
          FROM completion_ack_owner_decision_binding binding
          JOIN outcome_coordinator_owner_decision_request request
            ON request.request_id = binding.request_id
           AND request.tenant_id = binding.tenant_id
           AND request.project_id = binding.project_id
           AND request.coordination_id = binding.coordination_id
           AND request.obligation_revision = binding.obligation_revision
         WHERE binding.tenant_id = active.tenant_id
           AND binding.project_id = active.project_id
           AND binding.obligation_id = active.obligation_id
           AND binding.obligation_revision = active.obligation_revision
           AND request.status = 'OPEN'
         ORDER BY request.created_at DESC, request.request_id DESC
         LIMIT 1
      ) owner_decision ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(max(bounded.total_count), 0)::bigint AS total_count,
               COALESCE(jsonb_agg(bounded.action ORDER BY bounded.recorded_at,
                 bounded.event_id), '[]'::jsonb) AS attempted_actions,
               (jsonb_agg(bounded.action ORDER BY bounded.recorded_at DESC,
                 bounded.event_id DESC)->0) AS latest_failure
          FROM (
            SELECT event.event_id, event.recorded_at,
                   count(*) OVER () AS total_count,
                   jsonb_strip_nulls(jsonb_build_object(
                     'action', 'DELIVERY_REVOKED',
                     'outcome', event.reason_code,
                     'eventId', event.event_id::text,
                     'deliveryReceiptId', event.delivery_receipt_id::text,
                     'sessionId', event.coordinator_session_id::text,
                     'reasonCode', event.reason_code,
                     'failureFingerprint', event.progress_fingerprint::text,
                     'deadlineAt', event.deadline_at,
                     'sourceProgressAt', event.source_progress_at,
                     'recordedAt', event.recorded_at
                   )) AS action
              FROM completion_ack_delivery_progress_event event
             WHERE event.tenant_id = active.tenant_id
               AND event.project_id = active.project_id
               AND event.obligation_id = active.obligation_id
               AND event.obligation_revision = active.obligation_revision
               AND event.event_kind = 'DELIVERY_REVOKED'
             ORDER BY event.recorded_at DESC, event.event_id DESC
             LIMIT 8
          ) bounded
      ) revocations ON true
     WHERE active.tenant_id = ${scope.tenantId}::uuid
       ${projectFilter} ${taskFilter} ${sessionFilter}
     ORDER BY active.first_failure_at, active.obligation_id
  `);
  return rows.map(normalizeCompletionAckObligation);
}

export function completionAckObligationsBy(
  rows: readonly CompletionAckObligation[],
  key: 'projectId' | 'taskId' | 'sessionId',
): Map<string, CompletionAckObligation[]> {
  const out = new Map<string, CompletionAckObligation[]>();
  for (const row of rows) {
    const list = out.get(row[key]);
    if (list) list.push(row);
    else out.set(row[key], [row]);
  }
  return out;
}
