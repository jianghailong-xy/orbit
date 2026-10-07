import type { ManagedRunner, RunnerStatus } from '@prisma/client';
import {
  MANAGED_RUNNER_CONTRACT_VERSION,
  MANAGED_RUNNER_UNAVAILABLE,
  type ManagedRunnerReason,
  type ManagedRunnerStatus,
} from '@orbit/shared';

import { managedRunnerNotEligibleReason } from './managed-runner-eligibility';
import { managedRunnerDisabledReason } from './managed-runner-gate';

/** How fresh a heartbeat must be to count, when no profile says otherwise: the reaper's threshold. */
export const DEFAULT_HEARTBEAT_FRESH_MS = 90_000;

export interface ManagedRunnerStatusInput {
  /** The process's switch. */
  enabled: boolean;
  /** Enabled, and this server has a valid environment to reconcile in. */
  available: boolean;
  /** ManagedRunnerEligibility's answer for an owner without a mapping. Absent: eligible. */
  eligible?: boolean;
  mapping: ManagedRunner | null;
  runner: { status: RunnerStatus; lastHeartbeatAt: Date | null } | null;
  now: Date;
  heartbeatFreshMs: number;
}

export function managedRunnerUnavailableReason(): ManagedRunnerReason {
  return {
    code: MANAGED_RUNNER_UNAVAILABLE,
    message: "Managed runners are switched on, but this server's managed environment is not configured correctly. An operator has to fix it.",
    retryable: false,
  };
}

/** The stored cause, as clients may see it: code, sentence, retryable — never the operator detail. */
function storedReason(value: unknown): ManagedRunnerReason | null {
  if (!value || typeof value !== 'object') return null;
  const { code, message, retryable } = value as Record<string, unknown>;
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return { code, message, retryable: retryable === true };
}

/**
 * The owner's status, derived from what is stored. Pure: reading it allocates nothing and writes
 * nothing, which is what lets the capability and status reads be side-effect free.
 */
export function managedRunnerStatus(input: ManagedRunnerStatusInput): ManagedRunnerStatus {
  const { enabled, available, mapping, runner, now } = input;
  const operable = enabled && available;
  const actions = { canEnsure: false, canWake: false, canSleep: false, canRetry: false, canDelete: false };
  const switchReason = !enabled ? managedRunnerDisabledReason() : !available ? managedRunnerUnavailableReason() : null;

  if (!mapping) {
    const eligible = input.eligible !== false;
    return {
      contractVersion: MANAGED_RUNNER_CONTRACT_VERSION,
      enabled,
      revision: 0,
      managementState: 'NOT_PROVISIONED',
      desiredState: null,
      runnerId: null,
      workspaceId: null,
      heartbeatStatus: null,
      lastHeartbeatAt: null,
      usable: false,
      reason: switchReason ?? (eligible ? null : managedRunnerNotEligibleReason()),
      retryAfter: null,
      initialProvider: null,
      actions: { ...actions, canEnsure: operable && eligible },
    };
  }

  const reason = storedReason(mapping.lastError);
  const beat = runner?.lastHeartbeatAt ?? null;
  const fresh = !!beat && now.getTime() - beat.getTime() <= input.heartbeatFreshMs;
  return {
    contractVersion: MANAGED_RUNNER_CONTRACT_VERSION,
    enabled,
    revision: mapping.revision,
    managementState: mapping.managementState,
    desiredState: mapping.desiredState,
    runnerId: mapping.runnerId,
    workspaceId: mapping.defaultWorkspaceId,
    heartbeatStatus: runner?.status ?? null,
    lastHeartbeatAt: beat?.toISOString() ?? null,
    usable: mapping.managementState === 'READY' && fresh && runner?.status !== 'OFFLINE',
    reason: !enabled ? switchReason : (reason ?? switchReason),
    retryAfter: mapping.nextAttemptAt && mapping.nextAttemptAt > now ? mapping.nextAttemptAt.toISOString() : null,
    initialProvider: mapping.initialProvider,
    actions: { ...actions, canRetry: operable && mapping.managementState === 'FAILED' && reason?.retryable === true },
  };
}
