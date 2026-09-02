import { createHash } from 'node:crypto';

/**
 * The first EXECUTABLE protocol that distinguishes admission from an execution attempt.
 * Revision 1 is the historical two-minute shell protocol; it has no typed termination facts and
 * therefore cannot be used for a v2-bound evaluation plan.
 */
export const EXECUTABLE_ACCEPTANCE_SCHEMA_REVISION = 2;
export const EXECUTABLE_ACCEPTANCE_CAPABILITY_REVISION = 2;
export const EXECUTABLE_ACCEPTANCE_N_MINUS_ONE_CAPABILITY_REVISION = 1;
export const LEGACY_EXECUTABLE_ACCEPTANCE_TIMEOUT_SECONDS = 120;
export const DEFAULT_EXECUTABLE_ACCEPTANCE_POLICY_CEILING_SECONDS = 3_600;
export const EXECUTABLE_ACCEPTANCE_MAX_TIMEOUT_SECONDS = 86_400;
export const EXECUTABLE_ACCEPTANCE_MAX_ATTEMPTS = 3;

export const ATTEMPT_TERMINATION_KINDS = [
  'EXITED',
  'TIMED_OUT',
  'CANCELLED',
  'SIGNALED',
  'START_FAILED',
  'INFRASTRUCTURE_LOST',
] as const;

export type AttemptTerminationKind = (typeof ATTEMPT_TERMINATION_KINDS)[number];
export type AdmissionDecision = 'ADMITTED' | 'REJECTED';
export type ExecutableCriterionState = 'SATISFIED' | 'UNSATISFIED' | 'ACTIONABLE';

export interface ExecutableAcceptancePlanInput {
  command: string;
  expectedExitCode: number;
  requestedTimeoutSeconds: number;
  ownerTimeoutCeilingSeconds: number;
  policyTimeoutCeilingSeconds: number;
  requiredSchemaRevision?: number;
  requiredCapabilityRevision?: number;
}

export interface ExecutableAcceptancePlan extends ExecutableAcceptancePlanInput {
  requiredSchemaRevision: number;
  requiredCapabilityRevision: number;
  commandDigest: string;
  evaluationPlanDigest: string;
}

export interface RunnerExecutableAcceptanceCapability {
  schemaRevision: number;
  capabilityRevision: number;
  hardMaxSeconds: number;
  /** Exact source image whose process will spawn the command. */
  runnerSha?: string | null;
}

export type ExecutableAdmissionRejectionCode =
  | 'INVALID_EVALUATION_PLAN'
  | 'OWNER_CEILING_INSUFFICIENT'
  | 'POLICY_CEILING_INSUFFICIENT'
  | 'RUNNER_CAPABILITY_MISSING'
  | 'RUNNER_SCHEMA_INCOMPATIBLE'
  | 'RUNNER_CAPABILITY_INCOMPATIBLE'
  | 'RUNNER_HARD_MAX_INSUFFICIENT';

export interface ExecutableAdmission {
  decision: AdmissionDecision;
  rejectionCode: ExecutableAdmissionRejectionCode | null;
  requestedTimeoutSeconds: number;
  ownerTimeoutCeilingSeconds: number;
  policyTimeoutCeilingSeconds: number;
  runnerHardMaxSeconds: number | null;
  runnerSchemaRevision: number | null;
  runnerCapabilityRevision: number | null;
  effectiveTimeoutSeconds: number | null;
  effectiveDeadline: Date | null;
  /** An admission never spawns. The runner increments this only at its start boundary. */
  spawnCount: 0;
}

export interface ExecutableAttemptResult {
  terminationKind: AttemptTerminationKind;
  expectedExitCode: number;
  actualExitCode: number | null;
}

export interface ExecutableContinuationDecision {
  goalActionable: boolean;
  kind: 'NONE' | 'RETRY' | 'DIAGNOSIS' | 'SUCCESSOR';
  reasonCode: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evaluationPlanBinding(value: {
  schemaRevision: number;
  capabilityRevision: number;
  commandDigest: string;
  expectedExitCode: number;
  requestedTimeoutSeconds: number;
  ownerTimeoutCeilingSeconds: number;
  policyTimeoutCeilingSeconds: number;
}): string {
  // Keep this byte-for-byte identical to executable_acceptance_plan_digest() in migration 0200.
  // A newline-delimited, named encoding is deliberately easier to reproduce in every runner than
  // relying on a language's object-key ordering or JSON number rendering.
  return [
    `schemaRevision=${value.schemaRevision}`,
    `capabilityRevision=${value.capabilityRevision}`,
    `commandDigest=${value.commandDigest}`,
    `expectedExitCode=${value.expectedExitCode}`,
    `requestedTimeoutSeconds=${value.requestedTimeoutSeconds}`,
    `ownerTimeoutCeilingSeconds=${value.ownerTimeoutCeilingSeconds}`,
    `policyTimeoutCeilingSeconds=${value.policyTimeoutCeilingSeconds}`,
  ].join('\n');
}

export function executableCommandDigest(command: string): string {
  return sha256(command);
}

export function executableEvaluationPlan(input: ExecutableAcceptancePlanInput): ExecutableAcceptancePlan {
  const requiredSchemaRevision = input.requiredSchemaRevision
    ?? EXECUTABLE_ACCEPTANCE_SCHEMA_REVISION;
  const requiredCapabilityRevision = input.requiredCapabilityRevision
    ?? EXECUTABLE_ACCEPTANCE_CAPABILITY_REVISION;
  const commandDigest = executableCommandDigest(input.command);
  const frozen = {
    schemaRevision: requiredSchemaRevision,
    capabilityRevision: requiredCapabilityRevision,
    commandDigest,
    expectedExitCode: input.expectedExitCode,
    requestedTimeoutSeconds: input.requestedTimeoutSeconds,
    ownerTimeoutCeilingSeconds: input.ownerTimeoutCeilingSeconds,
    policyTimeoutCeilingSeconds: input.policyTimeoutCeilingSeconds,
  };
  return {
    ...input,
    requiredSchemaRevision,
    requiredCapabilityRevision,
    commandDigest,
    evaluationPlanDigest: sha256(evaluationPlanBinding(frozen)),
  };
}

export function executableAcceptancePlanError(plan: ExecutableAcceptancePlan): string | null {
  if (plan.command.trim() === '') return 'command is blank';
  for (const [name, value] of [
    ['requestedTimeoutSeconds', plan.requestedTimeoutSeconds],
    ['ownerTimeoutCeilingSeconds', plan.ownerTimeoutCeilingSeconds],
    ['policyTimeoutCeilingSeconds', plan.policyTimeoutCeilingSeconds],
    ['requiredSchemaRevision', plan.requiredSchemaRevision],
    ['requiredCapabilityRevision', plan.requiredCapabilityRevision],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) return `${name} must be a positive integer`;
  }
  if (plan.requestedTimeoutSeconds > EXECUTABLE_ACCEPTANCE_MAX_TIMEOUT_SECONDS) {
    return `requestedTimeoutSeconds exceeds ${EXECUTABLE_ACCEPTANCE_MAX_TIMEOUT_SECONDS}`;
  }
  const expected = executableEvaluationPlan(plan);
  if (plan.commandDigest !== expected.commandDigest) return 'commandDigest does not bind command';
  if (plan.evaluationPlanDigest !== expected.evaluationPlanDigest) {
    return 'evaluationPlanDigest does not bind the current plan';
  }
  return null;
}

/**
 * Negotiate before dequeue returns the shell turn. Rejection has no effective timeout and cannot
 * be repaired by clamping: the only admitted value is exactly the requested value.
 */
export function negotiateExecutableAcceptance(
  plan: ExecutableAcceptancePlan,
  runner: RunnerExecutableAcceptanceCapability | null,
  now: Date,
): ExecutableAdmission {
  let rejectionCode: ExecutableAdmissionRejectionCode | null = null;
  if (executableAcceptancePlanError(plan)) rejectionCode = 'INVALID_EVALUATION_PLAN';
  else if (plan.ownerTimeoutCeilingSeconds < plan.requestedTimeoutSeconds) {
    rejectionCode = 'OWNER_CEILING_INSUFFICIENT';
  } else if (plan.policyTimeoutCeilingSeconds < plan.requestedTimeoutSeconds) {
    rejectionCode = 'POLICY_CEILING_INSUFFICIENT';
  } else if (runner == null) rejectionCode = 'RUNNER_CAPABILITY_MISSING';
  else if (runner.schemaRevision !== plan.requiredSchemaRevision) {
    rejectionCode = 'RUNNER_SCHEMA_INCOMPATIBLE';
  } else if (runner.capabilityRevision < plan.requiredCapabilityRevision) {
    rejectionCode = 'RUNNER_CAPABILITY_INCOMPATIBLE';
  } else if (!Number.isSafeInteger(runner.hardMaxSeconds)
    || runner.hardMaxSeconds < plan.requestedTimeoutSeconds) {
    rejectionCode = 'RUNNER_HARD_MAX_INSUFFICIENT';
  }

  const admitted = rejectionCode == null;
  const effectiveTimeoutSeconds = admitted ? plan.requestedTimeoutSeconds : null;
  return {
    decision: admitted ? 'ADMITTED' : 'REJECTED',
    rejectionCode,
    requestedTimeoutSeconds: plan.requestedTimeoutSeconds,
    ownerTimeoutCeilingSeconds: plan.ownerTimeoutCeilingSeconds,
    policyTimeoutCeilingSeconds: plan.policyTimeoutCeilingSeconds,
    runnerHardMaxSeconds: runner?.hardMaxSeconds ?? null,
    runnerSchemaRevision: runner?.schemaRevision ?? null,
    runnerCapabilityRevision: runner?.capabilityRevision ?? null,
    effectiveTimeoutSeconds,
    effectiveDeadline: effectiveTimeoutSeconds == null
      ? null
      : new Date(now.getTime() + effectiveTimeoutSeconds * 1_000),
    spawnCount: 0,
  };
}

/** Only a process that exited has produced an exit-code criterion fact. */
export function evaluateExecutableAttempt(result: ExecutableAttemptResult): {
  state: ExecutableCriterionState;
  goalActionable: boolean;
} {
  if (result.terminationKind !== 'EXITED' || result.actualExitCode == null) {
    return { state: 'ACTIONABLE', goalActionable: true };
  }
  return result.actualExitCode === result.expectedExitCode
    ? { state: 'SATISFIED', goalActionable: false }
    : { state: 'UNSATISFIED', goalActionable: true };
}

/**
 * Finite convergence for an attempt-ending fact. A mismatch is a criterion conclusion, while
 * infrastructure/process terminations retain the goal and vary the next action by budget.
 *
 * `sameFingerprintCount` counts this failure over the whole supersession lineage, not over one
 * Task -- a loop that files a fresh successor per failure gives every Task exactly one attempt, so
 * a per-Task count is the constant 1 and no budget is ever spent. See the caller in
 * `runner-api.controller.ts` for the relation that defines the lineage.
 */
export function continuationAfterExecutableAttempt(
  result: ExecutableAttemptResult,
  attemptNumber: number,
  sameFingerprintCount: number,
  maximumAttempts = EXECUTABLE_ACCEPTANCE_MAX_ATTEMPTS,
): ExecutableContinuationDecision {
  const criterion = evaluateExecutableAttempt(result);
  if (criterion.state === 'SATISFIED') {
    return { goalActionable: false, kind: 'NONE', reasonCode: 'EXPECTED_EXIT_OBSERVED' };
  }
  if (criterion.state === 'UNSATISFIED') {
    return { goalActionable: true, kind: 'DIAGNOSIS', reasonCode: 'UNEXPECTED_EXIT_OBSERVED' };
  }
  if (attemptNumber < maximumAttempts && sameFingerprintCount <= 1) {
    return {
      goalActionable: true,
      kind: 'RETRY',
      reasonCode: `ATTEMPT_${result.terminationKind}_RETRY_BUDGET_AVAILABLE`,
    };
  }
  if (attemptNumber < maximumAttempts) {
    return {
      goalActionable: true,
      kind: 'DIAGNOSIS',
      reasonCode: `ATTEMPT_${result.terminationKind}_FINGERPRINT_REPEATED`,
    };
  }
  // A SUCCESSOR is one more whole attempt budget spent on the same failure. Past
  // `maximumAttempts` occurrences this fingerprint has already outlived a complete budget -- a
  // count only the lineage can reach, since one Task cannot exceed its own -- so handing it
  // another identical successor is the loop this bounds. Route it for diagnosis instead: only
  // DIAGNOSIS opens a continuation obligation, so this is what reaches the Failure Continuation
  // Controller and lets it change the diagnostic path (ALTERNATE_DIAGNOSIS and beyond).
  if (sameFingerprintCount > maximumAttempts) {
    return {
      goalActionable: true,
      kind: 'DIAGNOSIS',
      reasonCode: `ATTEMPT_${result.terminationKind}_LINEAGE_BUDGET_EXHAUSTED`,
    };
  }
  return {
    goalActionable: true,
    kind: 'SUCCESSOR',
    reasonCode: `ATTEMPT_${result.terminationKind}_ATTEMPT_BUDGET_EXHAUSTED`,
  };
}

/**
 * The four inputs a failed attempt is identified by.
 *
 * Migration 0213 added a fifth -- a digest of the sites a command named on its own summary line --
 * and 0226 removed it with the failure router that was its only consumer. What is left is the
 * composition 0200 shipped, in the encoding the dead-man sweep in
 * `executable_acceptance_mark_stale_attempts()` writes: `evaluationPlanDigest`, `terminationKind`,
 * `actualExitCode` and `signal`, newline-delimited, `NULL` spelled out for the two that are absent
 * on every non-EXITED termination. Keep it byte-for-byte identical to that function -- one column
 * written by two writers has to have one scheme.
 */
export function executableFailureFingerprint(input: {
  evaluationPlanDigest: string;
  terminationKind: AttemptTerminationKind;
  actualExitCode?: number | null;
  signal?: string | null;
}): string {
  return sha256([
    `evaluationPlanDigest=${input.evaluationPlanDigest}`,
    `terminationKind=${input.terminationKind}`,
    `actualExitCode=${input.actualExitCode ?? 'NULL'}`,
    `signal=${input.signal ?? 'NULL'}`,
  ].join('\n'));
}
