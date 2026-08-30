import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The delivery loop promises that a newly-created Failure Continuation is claimed within this
 * window.  It is deliberately a control-plane constant, not a UI timeout: every surface reads the
 * same deadline and the regression advances the database clock past this exact value.
 */
export const FAILURE_COORDINATOR_CLAIM_SLA_SECONDS = 60;

export const FAILURE_COORDINATION_STAGES = [
  'AUTOMATIC_DIAGNOSIS',
  'AUTOMATIC_REPAIR',
  'AUTOMATIC_REVALIDATION',
  'EXTERNAL_WAIT',
  'NEEDS_YOU',
] as const;

export type FailureCoordinationStage = typeof FAILURE_COORDINATION_STAGES[number];
export type FailureCoordinationSurface =
  | 'TASK_DETAIL'
  | 'PROJECT_WORK_OVERVIEW'
  | 'PROJECT_ATTENTION'
  | 'AGENT_QUEUE'
  | 'OWNER_DECISION_INBOX';

export const FAILURE_COORDINATION_SURFACES: readonly FailureCoordinationSurface[] = [
  'TASK_DETAIL',
  'PROJECT_WORK_OVERVIEW',
  'PROJECT_ATTENTION',
  'AGENT_QUEUE',
  'OWNER_DECISION_INBOX',
];

export type FailureAttentionReason =
  | 'COORDINATOR_SLA_UNCLAIMED'
  | 'COORDINATOR_SLA_STALE'
  | 'CONVERGENCE_FAILED'
  | 'OWNER_ONLY_DECISION';

export interface FailureCoordinationCta {
  kind: 'CREATE_REPAIR_SUCCESSOR' | 'VIEW_SUCCESSOR' | 'VIEW_OWNER_DECISION';
  method: 'GET' | 'POST';
  href: string;
  expiresAt: string;
  binding: Record<string, unknown>;
  body?: Record<string, unknown>;
}

export interface CanonicalFailureCoordination {
  schemaVersion: 1;
  obligationId: string;
  obligationRevision: string;
  projectId: string;
  sourceTaskId: string;
  sourceTaskTitle: string;
  sourceTaskStatus: string;
  continuationId: string;
  continuationStatus: string;
  bindingDigest: string;
  binding: {
    goalId: string;
    sourceTaskId: string;
    sourceBindingRevision: string;
    attemptGeneration: string;
    routeDecisionId: string | null;
    routeBindingDigest: string | null;
    currentBindingGeneration: string | null;
    currentSuccessorTaskId: string | null;
  };
  canonicalReason: Record<string, unknown>;
  canonicalReasonDigest: string;
  failureNode: string;
  failureFingerprint: string;
  evidence: Record<string, unknown>;
  evidenceDigest: string;
  evidenceSources: unknown[];
  stage: FailureCoordinationStage;
  deadlineAt: string;
  coordinator: {
    claimSlaSeconds: number;
    claimDeadlineAt: string;
    wakeupState: string;
    deliveredAt: string | null;
    sessionId: string | null;
    deliveryAttempts: number;
  };
  failedAttempt: {
    attemptId: string;
    sessionId: string;
    terminationKind: string;
    actualExitCode: number | null;
    signal: string | null;
    terminatedAt: string;
    receiptDigest: string;
    preserved: true;
  };
  successor: null | {
    taskId: string;
    title: string;
    status: string;
    bindingGeneration: string;
    bindingDigest: string;
    autoDispatchRequested: boolean;
    requiresOwner: boolean;
    dependencyRebindCount: number;
    committedAt: string;
    hasLiveRun: boolean;
  };
  attention: {
    required: boolean;
    reasonCode: FailureAttentionReason | null;
    sinceAt: string | null;
  };
  ownerOnly: boolean;
  active: boolean;
  cta: FailureCoordinationCta | null;
  ctaUnavailableReason: 'CTA_EXPIRED' | 'OWNER_ACTION_NOT_ALLOWED' | 'ALREADY_REBOUND' | null;
  observedAt: string;
}

export interface FailureCoordinationSummary {
  total: number;
  active: number;
  automaticDiagnosis: number;
  automaticRepair: number;
  automaticRevalidation: number;
  externalWait: number;
  needsYou: number;
  attentionRequired: number;
  attentionSinceAt: string | null;
  byAttentionReason: Partial<Record<FailureAttentionReason, number>>;
}

export interface FailureCoordinationReadModel {
  schemaVersion: 1;
  surface: FailureCoordinationSurface;
  observedAt: string;
  claimSlaSeconds: number;
  summary: FailureCoordinationSummary;
  /** Unfiltered semantic identities let mixed clients prove parity without rendering the item. */
  semanticIndex: Array<ReturnType<typeof failureCoordinationSemanticTuple>>;
  items: CanonicalFailureCoordination[];
}

interface FailureCoordinationRow {
  obligationId: string;
  obligationRevision: string;
  projectId: string;
  sourceTaskId: string;
  sourceTaskTitle: string;
  sourceTaskStatus: string;
  continuationId: string;
  continuationStatus: string;
  bindingRevision: bigint;
  attemptGeneration: bigint;
  failureFingerprint: string;
  reasonCode: string;
  obligationCreatedAt: Date;
  attemptId: string;
  attemptSessionId: string;
  terminationKind: string;
  actualExitCode: number | null;
  signal: string | null;
  terminatedAt: Date;
  receiptDigest: string;
  outputDigest: string;
  evaluationPlanDigest: string;
  wakeupState: string;
  wakeupCreatedAt: Date;
  wakeupDeliveredAt: Date | null;
  wakeupSessionId: string | null;
  deliveryAttempts: number;
  routeDecisionId: string | null;
  routeBindingDigest: string | null;
  routeDecisionDigest: string | null;
  failureDomain: string | null;
  failureNode: string | null;
  ownerReason: string | null;
  canonicalReason: Prisma.JsonValue | null;
  canonicalReasonDigest: string | null;
  evidence: Prisma.JsonValue | null;
  evidenceDigest: string | null;
  evidenceSources: Prisma.JsonValue | null;
  routeDeadlineAt: Date | null;
  projectAttention: boolean | null;
  unchangedEvidenceGenerations: number | null;
  handoffId: string | null;
  successorTaskId: string | null;
  successorTitle: string | null;
  successorStatus: string | null;
  handoffBindingGeneration: bigint | null;
  handoffBindingDigest: string | null;
  autoDispatchRequested: boolean | null;
  requiresOwner: boolean | null;
  dependencyRebindCount: number | null;
  committedAt: Date | null;
  hasLiveRun: boolean;
  currentBindingGeneration: bigint | null;
  currentSuccessorTaskId: string | null;
}

function object(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function values(value: Prisma.JsonValue | null): unknown[] {
  return Array.isArray(value) ? value : [];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function iso(value: Date): string {
  return value.toISOString();
}

function claimDeadline(row: FailureCoordinationRow): Date {
  return new Date(row.wakeupCreatedAt.getTime() + FAILURE_COORDINATOR_CLAIM_SLA_SECONDS * 1_000);
}

function attentionOf(
  row: FailureCoordinationRow,
  observedAt: Date,
): CanonicalFailureCoordination['attention'] {
  const ownerOnly = row.failureDomain === 'OWNER_REQUIRED' || row.ownerReason !== null;
  if (ownerOnly && row.continuationStatus === 'ACTIVE') {
    return {
      required: true,
      reasonCode: 'OWNER_ONLY_DECISION',
      sinceAt: iso(row.routeDeadlineAt ?? row.obligationCreatedAt),
    };
  }
  if (row.projectAttention && row.continuationStatus === 'ACTIVE') {
    return {
      required: true,
      reasonCode: 'CONVERGENCE_FAILED',
      sinceAt: iso(row.routeDeadlineAt ?? row.obligationCreatedAt),
    };
  }
  if (
    row.continuationStatus === 'ACTIVE'
    && row.handoffId === null
    && row.wakeupDeliveredAt === null
    && observedAt.getTime() >= claimDeadline(row).getTime()
  ) {
    return {
      required: true,
      reasonCode: 'COORDINATOR_SLA_UNCLAIMED',
      sinceAt: iso(claimDeadline(row)),
    };
  }
  if (
    row.continuationStatus === 'ACTIVE'
    && row.handoffId === null
    && row.routeDeadlineAt !== null
    && observedAt.getTime() >= row.routeDeadlineAt.getTime()
  ) {
    return {
      required: true,
      reasonCode: 'COORDINATOR_SLA_STALE',
      sinceAt: iso(row.routeDeadlineAt),
    };
  }
  return { required: false, reasonCode: null, sinceAt: null };
}

function stageOf(
  row: FailureCoordinationRow,
  attention: CanonicalFailureCoordination['attention'],
): FailureCoordinationStage {
  if (attention.required) return 'NEEDS_YOU';
  if (row.handoffId !== null) return 'AUTOMATIC_REVALIDATION';
  if (row.failureDomain === 'TRANSIENT_EXTERNAL') return 'EXTERNAL_WAIT';
  if (row.routeDecisionId !== null) return 'AUTOMATIC_REPAIR';
  return 'AUTOMATIC_DIAGNOSIS';
}

function ctaOf(
  row: FailureCoordinationRow,
  observedAt: Date,
  stage: FailureCoordinationStage,
  deadlineAt: Date,
  binding: CanonicalFailureCoordination['binding'],
): Pick<CanonicalFailureCoordination, 'cta' | 'ctaUnavailableReason'> {
  if (row.handoffId !== null && row.successorTaskId) {
    return {
      cta: {
        kind: 'VIEW_SUCCESSOR',
        method: 'GET',
        href: `/runner/tasks/${row.successorTaskId}`,
        expiresAt: iso(deadlineAt),
        binding,
      },
      ctaUnavailableReason: 'ALREADY_REBOUND',
    };
  }
  if (stage === 'NEEDS_YOU' && (row.failureDomain === 'OWNER_REQUIRED' || row.ownerReason !== null)) {
    return {
      cta: observedAt.getTime() < deadlineAt.getTime() ? {
        kind: 'VIEW_OWNER_DECISION',
        method: 'GET',
        href: `/tasks/${row.sourceTaskId}`,
        expiresAt: iso(deadlineAt),
        binding,
      } : null,
      ctaUnavailableReason: observedAt.getTime() < deadlineAt.getTime() ? null : 'CTA_EXPIRED',
    };
  }
  if (row.routeDecisionId === null || row.routeDecisionDigest === null) {
    return { cta: null, ctaUnavailableReason: null };
  }
  if (observedAt.getTime() >= deadlineAt.getTime()) {
    return { cta: null, ctaUnavailableReason: 'CTA_EXPIRED' };
  }
  if (stage === 'NEEDS_YOU') {
    return { cta: null, ctaUnavailableReason: 'OWNER_ACTION_NOT_ALLOWED' };
  }
  return {
    cta: {
      kind: 'CREATE_REPAIR_SUCCESSOR',
      method: 'POST',
      href: '/runner/tasks',
      expiresAt: iso(deadlineAt),
      binding,
      body: {
        projectId: row.projectId,
        supersedesTaskId: row.sourceTaskId,
        failureSuccessorHandoff: {
          obligationId: row.obligationId,
          obligationRevision: row.obligationRevision,
          routeDecisionId: row.routeDecisionId,
          routeDecisionDigest: row.routeDecisionDigest,
        },
      },
    },
    ctaUnavailableReason: null,
  };
}

function canonicalItem(row: FailureCoordinationRow, observedAt: Date): CanonicalFailureCoordination {
  const pendingReason = {
    code: 'FAILURE_CONTINUATION_PENDING_DIAGNOSIS',
    failureDomain: 'UNCLASSIFIED',
    failureNode: 'UNCLASSIFIED',
    failureFingerprint: row.failureFingerprint,
    reasonCode: row.reasonCode,
  };
  const pendingEvidence = {
    receiptDigest: row.receiptDigest,
    outputDigest: row.outputDigest,
    evaluationPlanDigest: row.evaluationPlanDigest,
    termination: {
      kind: row.terminationKind,
      actualExitCode: row.actualExitCode,
      signal: row.signal,
    },
  };
  const reason = row.canonicalReason === null ? pendingReason : object(row.canonicalReason);
  const evidence = row.evidence === null ? pendingEvidence : object(row.evidence);
  const attention = attentionOf(row, observedAt);
  const stage = stageOf(row, attention);
  const deadlineAt = row.routeDeadlineAt ?? claimDeadline(row);
  const bindingDigest = row.handoffBindingDigest ?? row.routeBindingDigest ?? row.receiptDigest;
  const binding: CanonicalFailureCoordination['binding'] = {
    goalId: row.projectId,
    sourceTaskId: row.sourceTaskId,
    sourceBindingRevision: row.bindingRevision.toString(),
    attemptGeneration: row.attemptGeneration.toString(),
    routeDecisionId: row.routeDecisionId,
    routeBindingDigest: row.routeBindingDigest,
    currentBindingGeneration: row.currentBindingGeneration?.toString()
      ?? row.handoffBindingGeneration?.toString()
      ?? null,
    currentSuccessorTaskId: row.currentSuccessorTaskId ?? row.successorTaskId,
  };
  const cta = ctaOf(row, observedAt, stage, deadlineAt, binding);
  const ownerOnly = row.failureDomain === 'OWNER_REQUIRED' || row.ownerReason !== null;
  return {
    schemaVersion: 1,
    obligationId: row.obligationId,
    obligationRevision: row.obligationRevision,
    projectId: row.projectId,
    sourceTaskId: row.sourceTaskId,
    sourceTaskTitle: row.sourceTaskTitle,
    sourceTaskStatus: row.sourceTaskStatus,
    continuationId: row.continuationId,
    continuationStatus: row.continuationStatus,
    bindingDigest,
    binding,
    canonicalReason: reason,
    canonicalReasonDigest: row.canonicalReasonDigest ?? digest(reason),
    failureNode: row.failureNode ?? 'UNCLASSIFIED',
    failureFingerprint: row.failureFingerprint,
    evidence,
    evidenceDigest: row.evidenceDigest ?? digest(evidence),
    evidenceSources: row.evidenceSources === null
      ? [{ kind: 'FAILURE_ATTEMPT_RECEIPT', locator: row.receiptDigest }]
      : values(row.evidenceSources),
    stage,
    deadlineAt: iso(deadlineAt),
    coordinator: {
      claimSlaSeconds: FAILURE_COORDINATOR_CLAIM_SLA_SECONDS,
      claimDeadlineAt: iso(claimDeadline(row)),
      wakeupState: row.wakeupState,
      deliveredAt: row.wakeupDeliveredAt ? iso(row.wakeupDeliveredAt) : null,
      sessionId: row.wakeupSessionId,
      deliveryAttempts: row.deliveryAttempts,
    },
    failedAttempt: {
      attemptId: row.attemptId,
      sessionId: row.attemptSessionId,
      terminationKind: row.terminationKind,
      actualExitCode: row.actualExitCode,
      signal: row.signal,
      terminatedAt: iso(row.terminatedAt),
      receiptDigest: row.receiptDigest,
      preserved: true,
    },
    successor: row.handoffId && row.successorTaskId && row.successorTitle && row.successorStatus
      && row.handoffBindingGeneration && row.handoffBindingDigest && row.committedAt
      ? {
          taskId: row.successorTaskId,
          title: row.successorTitle,
          status: row.successorStatus,
          bindingGeneration: row.handoffBindingGeneration.toString(),
          bindingDigest: row.handoffBindingDigest,
          autoDispatchRequested: row.autoDispatchRequested ?? false,
          requiresOwner: row.requiresOwner ?? false,
          dependencyRebindCount: row.dependencyRebindCount ?? 0,
          committedAt: iso(row.committedAt),
          hasLiveRun: row.hasLiveRun,
        }
      : null,
    attention,
    ownerOnly,
    active: row.continuationStatus === 'ACTIVE'
      || (row.handoffId !== null && !['DONE', 'CANCELLED', 'FAILED'].includes(row.successorStatus ?? '')),
    ...cta,
    observedAt: iso(observedAt),
  };
}

function keepForSurface(
  item: CanonicalFailureCoordination,
  surface: FailureCoordinationSurface,
): boolean {
  if (surface === 'TASK_DETAIL') return true;
  if (surface === 'PROJECT_WORK_OVERVIEW') return item.active || item.successor !== null;
  if (surface === 'PROJECT_ATTENTION') return item.active && item.attention.required;
  if (surface === 'OWNER_DECISION_INBOX') {
    return item.active && item.attention.reasonCode === 'OWNER_ONLY_DECISION';
  }
  return item.active && !item.ownerOnly && !item.attention.required;
}

export function summarizeFailureCoordination(
  items: readonly CanonicalFailureCoordination[],
): FailureCoordinationSummary {
  const active = items.filter((item) => item.active);
  const attention = active.filter((item) => item.attention.required);
  const byAttentionReason: FailureCoordinationSummary['byAttentionReason'] = {};
  for (const item of attention) {
    const reason = item.attention.reasonCode;
    if (reason) byAttentionReason[reason] = (byAttentionReason[reason] ?? 0) + 1;
  }
  const attentionTimes = attention
    .map((item) => item.attention.sinceAt)
    .filter((value): value is string => value !== null)
    .sort();
  return {
    total: items.length,
    active: active.length,
    automaticDiagnosis: active.filter((item) => item.stage === 'AUTOMATIC_DIAGNOSIS').length,
    automaticRepair: active.filter((item) => item.stage === 'AUTOMATIC_REPAIR').length,
    automaticRevalidation: active.filter((item) => item.stage === 'AUTOMATIC_REVALIDATION').length,
    externalWait: active.filter((item) => item.stage === 'EXTERNAL_WAIT').length,
    needsYou: active.filter((item) => item.stage === 'NEEDS_YOU').length,
    attentionRequired: attention.length,
    attentionSinceAt: attentionTimes[0] ?? null,
    byAttentionReason,
  };
}

/** Stable semantic tuple used by Web, API and mixed-client parity assertions. */
export function failureCoordinationSemanticTuple(item: CanonicalFailureCoordination) {
  return {
    obligationId: item.obligationId,
    obligationRevision: item.obligationRevision,
    bindingDigest: item.bindingDigest,
    binding: item.binding,
    reason: item.canonicalReason,
  };
}

export async function readFailureCoordination(
  prisma: PrismaService,
  input: {
    tenantId: string;
    projectIds?: readonly string[];
    taskIds?: readonly string[];
    surface?: FailureCoordinationSurface;
    observedAt?: Date;
  },
): Promise<FailureCoordinationReadModel> {
  const observedAt = input.observedAt ?? new Date();
  const surface = input.surface ?? 'PROJECT_WORK_OVERVIEW';
  if (input.projectIds?.length === 0 || input.taskIds?.length === 0) {
    return {
      schemaVersion: 1,
      surface,
      observedAt: iso(observedAt),
      claimSlaSeconds: FAILURE_COORDINATOR_CLAIM_SLA_SECONDS,
      summary: summarizeFailureCoordination([]),
      semanticIndex: [],
      items: [],
    };
  }
  const projectFilter = input.projectIds
    ? Prisma.sql`AND obligation.goal_id IN (${Prisma.join(input.projectIds.map((id) => Prisma.sql`${id}::uuid`))})`
    : Prisma.empty;
  const taskFilter = input.taskIds
    ? Prisma.sql`AND (
        obligation.task_id IN (${Prisma.join(input.taskIds.map((id) => Prisma.sql`${id}::uuid`))})
        OR handoff.successor_task_id IN (${Prisma.join(input.taskIds.map((id) => Prisma.sql`${id}::uuid`))})
      )`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<FailureCoordinationRow[]>(Prisma.sql`
    SELECT obligation.obligation_id AS "obligationId",
           obligation.idempotency_key::text AS "obligationRevision",
           obligation.goal_id AS "projectId",
           obligation.task_id AS "sourceTaskId",
           source.title AS "sourceTaskTitle",
           source.status::text AS "sourceTaskStatus",
           obligation.continuation_id AS "continuationId",
           continuation.status AS "continuationStatus",
           obligation.binding_revision AS "bindingRevision",
           obligation.attempt_generation AS "attemptGeneration",
           obligation.failure_fingerprint::text AS "failureFingerprint",
           obligation.reason_code AS "reasonCode",
           obligation.created_at AS "obligationCreatedAt",
           receipt.attempt_id AS "attemptId",
           receipt.session_id AS "attemptSessionId",
           receipt.termination_kind::text AS "terminationKind",
           receipt.actual_exit_code AS "actualExitCode",
           receipt.signal,
           receipt.terminated_at AS "terminatedAt",
           receipt.receipt_digest::text AS "receiptDigest",
           receipt.output_digest::text AS "outputDigest",
           receipt.evaluation_plan_digest::text AS "evaluationPlanDigest",
           wakeup.state AS "wakeupState",
           wakeup.created_at AS "wakeupCreatedAt",
           wakeup.delivered_at AS "wakeupDeliveredAt",
           wakeup.coordinator_session_id AS "wakeupSessionId",
           wakeup.delivery_attempts AS "deliveryAttempts",
           route.decision_id AS "routeDecisionId",
           route.binding_digest::text AS "routeBindingDigest",
           route.decision_digest::text AS "routeDecisionDigest",
           route.failure_domain AS "failureDomain",
           route.failure_node AS "failureNode",
           route.owner_reason AS "ownerReason",
           route.canonical_reason AS "canonicalReason",
           route.canonical_reason_digest::text AS "canonicalReasonDigest",
           route.evidence,
           route.evidence_digest::text AS "evidenceDigest",
           route.evidence_sources AS "evidenceSources",
           route.deadline_at AS "routeDeadlineAt",
           route.project_attention AS "projectAttention",
           route.unchanged_evidence_generations AS "unchangedEvidenceGenerations",
           handoff.handoff_id AS "handoffId",
           handoff.successor_task_id AS "successorTaskId",
           successor.title AS "successorTitle",
           successor.status::text AS "successorStatus",
           handoff.binding_generation AS "handoffBindingGeneration",
           handoff.binding_digest::text AS "handoffBindingDigest",
           handoff.auto_dispatch_requested AS "autoDispatchRequested",
           handoff.requires_owner AS "requiresOwner",
           handoff.dependency_rebind_count AS "dependencyRebindCount",
           handoff.committed_at AS "committedAt",
           EXISTS (
             SELECT 1 FROM session successor_session
              WHERE successor_session.task_id = handoff.successor_task_id
                AND successor_session.status::text IN ('PENDING', 'RUNNING', 'AWAITING_INPUT')
           ) AS "hasLiveRun",
           current_binding.binding_generation AS "currentBindingGeneration",
           current_binding.current_successor_task_id AS "currentSuccessorTaskId"
      FROM failure_continuation_obligation obligation
      JOIN failure_continuation_attempt_receipt receipt
        ON receipt.receipt_id = obligation.receipt_id
      JOIN task_executable_continuation continuation
        ON continuation.id = obligation.continuation_id
      JOIN failure_continuation_wakeup_outbox wakeup
        ON wakeup.obligation_id = obligation.obligation_id
      JOIN task source ON source.id = obligation.task_id
      JOIN project project_row ON project_row.id = obligation.goal_id
      LEFT JOIN failure_continuation_route_decision route
        ON route.obligation_id = obligation.obligation_id
      LEFT JOIN failure_successor_handoff handoff
        ON handoff.obligation_id = obligation.obligation_id
      LEFT JOIN task successor ON successor.id = handoff.successor_task_id
      LEFT JOIN failure_successor_current_binding current_binding
        ON current_binding.lineage_root_task_id = handoff.lineage_root_task_id
     WHERE obligation.tenant_id = ${input.tenantId}::uuid
       AND project_row.owner_id = ${input.tenantId}::uuid
       ${projectFilter}
       ${taskFilter}
     ORDER BY obligation.created_at DESC, obligation.obligation_id DESC
  `);
  const all = rows.map((row) => canonicalItem(row, observedAt));
  const items = all.filter((item) => keepForSurface(item, surface));
  return {
    schemaVersion: 1,
    surface,
    observedAt: iso(observedAt),
    claimSlaSeconds: FAILURE_COORDINATOR_CLAIM_SLA_SECONDS,
    summary: summarizeFailureCoordination(items),
    semanticIndex: all.map(failureCoordinationSemanticTuple),
    items,
  };
}

export function failureCoordinationByProject(
  model: FailureCoordinationReadModel,
): Map<string, FailureCoordinationReadModel> {
  const grouped = new Map<string, CanonicalFailureCoordination[]>();
  for (const item of model.items) {
    const items = grouped.get(item.projectId);
    if (items) items.push(item);
    else grouped.set(item.projectId, [item]);
  }
  return new Map([...grouped].map(([projectId, items]) => [projectId, {
    ...model,
    summary: summarizeFailureCoordination(items),
    semanticIndex: items.map(failureCoordinationSemanticTuple),
    items,
  }]));
}

export function failureCoordinationByTask(
  model: FailureCoordinationReadModel,
): Map<string, CanonicalFailureCoordination[]> {
  const grouped = new Map<string, CanonicalFailureCoordination[]>();
  for (const item of model.items) {
    for (const taskId of [item.sourceTaskId, item.successor?.taskId].filter(Boolean) as string[]) {
      const items = grouped.get(taskId);
      if (items) items.push(item);
      else grouped.set(taskId, [item]);
    }
  }
  return grouped;
}
