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

/** The one line a command prints to name where it failed; ids follow, space separated. */
export const FAILURE_SITE_SUMMARY_MARKER = '##orbit-failure-sites:v1';

/** Why a fingerprint carries the site identity it carries. A degradation is named, never silent. */
export const FAILURE_SITE_SOURCES = ['REPORTED', 'ABSENT', 'UNPARSABLE'] as const;

export const ATTEMPT_TERMINATION_KINDS = [
  'EXITED',
  'TIMED_OUT',
  'CANCELLED',
  'SIGNALED',
  'START_FAILED',
  'INFRASTRUCTURE_LOST',
] as const;

export type AttemptTerminationKind = (typeof ATTEMPT_TERMINATION_KINDS)[number];
export type FailureSiteSource = (typeof FAILURE_SITE_SOURCES)[number];
export type AdmissionDecision = 'ADMITTED' | 'REJECTED';
export type ExecutableCriterionState = 'SATISFIED' | 'UNSATISFIED' | 'ACTIONABLE';

/** A site id is a plain token so that TypeScript and PL/pgSQL can agree on it without a parser. */
const FAILURE_SITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ExecutableFailureSiteIdentity {
  source: FailureSiteSource;
  /** Sorted and de-duplicated; empty unless the source is REPORTED. */
  sites: string[];
  digest: string;
}

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
  return {
    goalActionable: true,
    kind: 'SUCCESSOR',
    reasonCode: `ATTEMPT_${result.terminationKind}_ATTEMPT_BUDGET_EXHAUSTED`,
  };
}

function failureSiteIdentity(
  source: FailureSiteSource,
  sites: string[],
): ExecutableFailureSiteIdentity {
  return {
    source,
    sites,
    digest: sha256([
      'executable-failure-site:v1',
      `source=${source}`,
      ...sites.map((site) => `site=${site}`),
    ].join('\n')),
  };
}

/**
 * Where the attempt failed, as a value a fingerprint can carry.
 *
 * Only the summary line is read, and only node ids off it: no timestamp, path, pid, nonce or log
 * body reaches the digest, so the same set of failing sites digests the same on every run and a
 * different set digests differently.  A command that prints no parseable summary degrades to a
 * NAMED source instead of to silence -- the source is persisted beside the fingerprint it produced,
 * so a constant fingerprint is readable as "nothing said where", not mistaken for "same failure".
 *
 * Keep this byte-for-byte identical to executable_failure_site_identity() in migration 0213.
 */
export function executableFailureSiteIdentity(
  rawOutput: string | null | undefined,
): ExecutableFailureSiteIdentity {
  // The summary is printed last, so a later line supersedes anything the run echoed earlier.
  const line = rawOutput == null ? undefined : rawOutput
    .split('\n')
    .map((value) => value.replace(/\r+$/, ''))
    .filter((value) => value === FAILURE_SITE_SUMMARY_MARKER
      || value.startsWith(`${FAILURE_SITE_SUMMARY_MARKER} `))
    .at(-1);
  if (line == null) return failureSiteIdentity('ABSENT', []);
  const sites = [...new Set(line
    .slice(FAILURE_SITE_SUMMARY_MARKER.length + 1)
    .split(' ')
    .filter((value) => value !== ''))].sort();
  if (sites.some((site) => !FAILURE_SITE_ID.test(site))) {
    return failureSiteIdentity('UNPARSABLE', []);
  }
  return failureSiteIdentity('REPORTED', sites);
}

/** Keep this byte-for-byte identical to executable_failure_fingerprint() in migration 0213. */
export function executableFailureFingerprint(input: {
  evaluationPlanDigest: string;
  terminationKind: AttemptTerminationKind;
  actualExitCode?: number | null;
  signal?: string | null;
  failureSiteDigest: string;
}): string {
  return sha256([
    'executable-failure-fingerprint:v2',
    `evaluationPlanDigest=${input.evaluationPlanDigest}`,
    `terminationKind=${input.terminationKind}`,
    `actualExitCode=${input.actualExitCode ?? 'NULL'}`,
    `signal=${input.signal ?? 'NULL'}`,
    `failureSiteDigest=${input.failureSiteDigest}`,
  ].join('\n'));
}
