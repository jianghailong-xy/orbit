import { createHash } from 'node:crypto';

export const COORDINATOR_OWNER_DECISION_REASONS = [
  'GOAL_DECISION',
  'RISK_ACCEPTANCE',
  'NEW_AUTHORIZATION',
  'EXTERNAL_IDENTITY',
] as const;

export type CoordinatorOwnerDecisionReason =
  (typeof COORDINATOR_OWNER_DECISION_REASONS)[number];

export const COORDINATOR_OWNER_DECISION_FIELDS = [
  'whyNotAgent',
  'options',
  'impacts',
  'recommendation',
  'noActionConsequence',
  'cost',
  'deadline',
  'resumeBehavior',
  'idempotencyKey',
] as const;

export const COORDINATOR_AUDITABLE_PROGRESS = [
  'VALID_ATTEMPT',
  'EXTERNAL_DELIVERY',
  'EXTERNAL_WAIT',
  'SUPERSEDE',
  'ESCALATE',
  'TERMINAL_DISPOSITION',
  'OWNER_DECISION_REQUEST',
] as const;

export type CoordinatorAuditableProgress =
  (typeof COORDINATOR_AUDITABLE_PROGRESS)[number];

const OWNER_KIND_BY_REASON: Readonly<Record<CoordinatorOwnerDecisionReason, string>> = Object.freeze({
  GOAL_DECISION: 'REQUEST_GOAL_DECISION',
  RISK_ACCEPTANCE: 'REQUEST_RISK_ACCEPTANCE',
  NEW_AUTHORIZATION: 'REQUEST_NEW_AUTHORIZATION',
  EXTERNAL_IDENTITY: 'REQUEST_EXTERNAL_IDENTITY',
});

const DIGEST = /^[0-9a-f]{64}$/;
const LOGICAL_TIME = /^(0|[1-9][0-9]*)$/;

export interface CoordinatorSourceObligation {
  obligationId: string;
  obligationRevision: string;
  bindingDigest: string;
  kind: string;
  owner: string;
  capability: string;
  [key: string]: unknown;
}

export interface CoordinatorOwnerDecisionPayload {
  whyNotAgent: string;
  options: unknown[];
  impacts: unknown[];
  recommendation: unknown;
  noActionConsequence: unknown;
  cost: unknown;
  deadline: unknown;
  resumeBehavior: unknown;
  idempotencyKey: string;
  [key: string]: unknown;
}

export interface CoordinatorFailurePath {
  path: 'PRIMARY_RECOVERY' | 'ALTERNATE_DIAGNOSIS' | 'REPEATED_FAILURE_ESCALATION'
    | 'ATTEMPT_BUDGET_EXHAUSTED';
  terminal: boolean;
  changedDiagnosticPath: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
  )).join(',')}}`;
}

export function coordinatorDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function coordinatorFailureFingerprint(
  code: string,
  evidence: Record<string, unknown>,
): string {
  return coordinatorDigest({
    namespace: 'orbit.outcome-coordinator.failure.v2',
    code,
    evidence,
  });
}

/**
 * The owner queue is intentionally a closed authority boundary. An evaluator may derive an
 * owner-shaped obligation, but only a request with the complete decision protocol may enter the
 * queue. Ordinary failures and external waits therefore cannot acquire a human owner by default.
 */
export function validateCoordinatorOwnerDecision(
  obligation: CoordinatorSourceObligation,
  reason: string,
  payload: unknown,
): string | null {
  if (!COORDINATOR_OWNER_DECISION_REASONS.includes(reason as CoordinatorOwnerDecisionReason)) {
    return 'OWNER_DECISION_REASON_FORBIDDEN';
  }
  if (OWNER_KIND_BY_REASON[reason as CoordinatorOwnerDecisionReason] !== obligation.kind) {
    return 'OWNER_DECISION_KIND_MISMATCH';
  }
  if (!isRecord(payload)) return 'OWNER_DECISION_PAYLOAD_REQUIRED';
  for (const field of COORDINATOR_OWNER_DECISION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      return `OWNER_DECISION_FIELD_REQUIRED:${field}`;
    }
  }
  if (typeof payload.whyNotAgent !== 'string' || payload.whyNotAgent.trim().length === 0) {
    return 'WHY_NOT_AGENT_REQUIRED';
  }
  if (!Array.isArray(payload.options) || payload.options.length === 0) {
    return 'OWNER_DECISION_OPTIONS_REQUIRED';
  }
  if (!Array.isArray(payload.impacts) || payload.impacts.length === 0) {
    return 'OWNER_DECISION_IMPACTS_REQUIRED';
  }
  if (typeof payload.idempotencyKey !== 'string' || payload.idempotencyKey.trim().length === 0) {
    return 'OWNER_DECISION_IDEMPOTENCY_KEY_REQUIRED';
  }
  return null;
}

export function coordinatorFailurePath(
  occurrenceCount: number,
  sameFingerprintLimit: number,
  attemptBudgetRemaining: number,
): CoordinatorFailurePath {
  if (!Number.isInteger(occurrenceCount) || occurrenceCount < 1
      || !Number.isInteger(sameFingerprintLimit) || sameFingerprintLimit < 1
      || !Number.isInteger(attemptBudgetRemaining) || attemptBudgetRemaining < 0) {
    throw new Error('COORDINATOR_FAILURE_COUNTER_INVALID');
  }
  if (attemptBudgetRemaining === 0) {
    return {
      path: 'ATTEMPT_BUDGET_EXHAUSTED',
      terminal: true,
      changedDiagnosticPath: true,
    };
  }
  if (occurrenceCount > sameFingerprintLimit) {
    return {
      path: 'REPEATED_FAILURE_ESCALATION',
      terminal: true,
      changedDiagnosticPath: true,
    };
  }
  if (occurrenceCount === sameFingerprintLimit) {
    return {
      path: 'ALTERNATE_DIAGNOSIS',
      terminal: false,
      changedDiagnosticPath: true,
    };
  }
  return { path: 'PRIMARY_RECOVERY', terminal: false, changedDiagnosticPath: false };
}

export function assertBoundedCoordinatorWake(
  logicalNow: string,
  dueLogicalTime: string,
  livenessDelta: number,
): void {
  if (!LOGICAL_TIME.test(logicalNow) || !LOGICAL_TIME.test(dueLogicalTime)
      || !Number.isInteger(livenessDelta) || livenessDelta < 1) {
    throw new Error('COORDINATOR_WAKE_BOUND_INVALID');
  }
  const now = BigInt(logicalNow);
  const due = BigInt(dueLogicalTime);
  if (due < now || due > now + BigInt(livenessDelta)) {
    throw new Error('COORDINATOR_WAKE_OUTSIDE_LIVENESS_BOUND');
  }
}

export function validateCoordinatorSourceObligation(value: unknown): string | null {
  if (!isRecord(value)) return 'COORDINATOR_OBLIGATION_REQUIRED';
  for (const field of ['obligationId', 'obligationRevision', 'bindingDigest']) {
    if (typeof value[field] !== 'string' || !DIGEST.test(value[field] as string)) {
      return `COORDINATOR_OBLIGATION_DIGEST_INVALID:${field}`;
    }
  }
  for (const field of ['kind', 'owner', 'capability']) {
    if (typeof value[field] !== 'string' || (value[field] as string).trim().length === 0) {
      return `COORDINATOR_OBLIGATION_FIELD_INVALID:${field}`;
    }
  }
  return null;
}
