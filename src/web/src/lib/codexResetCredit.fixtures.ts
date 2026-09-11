import {
  AgentProvider,
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  type CodexRateLimitResetConsumeOutcome,
  type CodexRateLimitResetFailureCode,
  type CodexRateLimitResetOperationStatus,
  type CodexRateLimitResetOperationView,
  type CodexRateLimitResetResultCode,
  type PlanUsageRateLimitReset,
  type PlanUsageRateLimitResetCredit,
} from '@orbit/shared';
import type { CodexResetRunner } from './codexResetCredit';

/** Contract-valid Codex reset fixtures for the reset specs. Nothing in the app imports this. */

export const RESET_RUNNER_ID = 'Runner1';
export const RESET_LEASE = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';
export const RESET_FINGERPRINT = 'cxa1_92381c922ad04574cc61964161fd5687';
export const OTHER_FINGERPRINT = 'cxa1_0123456789abcdef0123456789abcdef';
export const RESET_REQUEST_ID = '9b2c4a1e-5d6f-4a7b-8c9d-0e1f2a3b4c5d';

export function resetCredit(overrides: Partial<PlanUsageRateLimitResetCredit> = {}): PlanUsageRateLimitResetCredit {
  return {
    id: 'rlrc_fixture_1',
    resetType: 'codexRateLimits',
    status: 'available',
    grantedAt: '2026-08-29T10:40:00Z',
    expiresAt: '2026-09-16T09:00:00Z',
    title: 'Earned reset',
    description: null,
    ...overrides,
  };
}

/** A SUPPORTED block with one listed credit, read two minutes before `now`. */
export function resetBlock(now: Date, overrides: Partial<PlanUsageRateLimitReset> = {}): PlanUsageRateLimitReset {
  return {
    protocolVersion: 1,
    support: 'SUPPORTED',
    accountFingerprint: RESET_FINGERPRINT,
    rateLimitResetCredits: { availableCount: 1, credits: [resetCredit()] },
    fetchedAt: new Date(now.getTime() - 2 * 60_000).toISOString(),
    generation: RESET_LEASE,
    sequence: 3,
    ...overrides,
  };
}

/** An online runner that may reset: capability, lease, not draining, and a 92% / 68% Codex snapshot. */
export function resetRunner(
  now: Date,
  overrides: Partial<CodexResetRunner> = {},
  block: PlanUsageRateLimitReset | null = resetBlock(now),
): CodexResetRunner & { id: string; name: string } {
  return {
    id: RESET_RUNNER_ID,
    name: 'wikova',
    online: true,
    capabilities: [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1],
    heartbeatLeaseOwner: RESET_LEASE,
    heartbeatDraining: false,
    planUsage: {
      codex: {
        provider: AgentProvider.CODEX,
        primary: {
          utilization: 92,
          windowDurationMins: 300,
          resetsAt: new Date(now.getTime() + 100 * 60_000).toISOString(),
        },
        secondary: {
          utilization: 68,
          windowDurationMins: 7 * 24 * 60,
          resetsAt: new Date(now.getTime() + 4 * 24 * 60 * 60_000).toISOString(),
        },
        ...(block ? { rateLimitReset: block } : {}),
      },
    },
    ...overrides,
  };
}

/** An operation view whose checkpoints derive `status` (contract §7.3), as the user API renders it. */
export function resetOperation(
  status: CodexRateLimitResetOperationStatus,
  overrides: {
    id?: string;
    clientRequestId?: string;
    accountFingerprint?: string;
    outcome?: CodexRateLimitResetConsumeOutcome;
    failureCode?: CodexRateLimitResetFailureCode;
    lastErrorCode?: CodexRateLimitResetResultCode | null;
  } = {},
): CodexRateLimitResetOperationView {
  const at = '2026-09-11T11:59:00.000Z';
  const later = '2026-09-11T11:59:30.000Z';
  const base = {
    id: overrides.id ?? 'Op1',
    runnerId: RESET_RUNNER_ID,
    clientRequestId: overrides.clientRequestId ?? RESET_REQUEST_ID,
    accountFingerprint: overrides.accountFingerprint ?? RESET_FINGERPRINT,
    status,
    failureCode: null,
    lastErrorCode: overrides.lastErrorCode ?? null,
    createdAt: at,
    updatedAt: later,
    consumeConfirmedAt: null,
    completedAt: null,
  };
  const outcome = overrides.outcome ?? 'reset';
  switch (status) {
    case 'PENDING':
      return { ...base, consumeState: 'PENDING', consumeOutcome: null, refreshState: 'NONE' };
    case 'CONSUMING':
      return { ...base, consumeState: 'CLAIMED', consumeOutcome: null, refreshState: 'NONE' };
    case 'REFRESHING':
      return { ...base, consumeState: 'CONFIRMED', consumeOutcome: outcome, refreshState: 'PENDING', consumeConfirmedAt: later };
    case 'SUCCEEDED':
      return {
        ...base,
        consumeState: 'CONFIRMED',
        consumeOutcome: outcome,
        refreshState: 'SUCCEEDED',
        consumeConfirmedAt: later,
        completedAt: later,
      };
    case 'REFRESH_FAILED':
      return {
        ...base,
        consumeState: 'CONFIRMED',
        consumeOutcome: outcome,
        refreshState: 'FAILED',
        failureCode: overrides.failureCode ?? 'REFRESH_EXPIRED',
        consumeConfirmedAt: later,
        completedAt: later,
      };
    case 'NOTHING_TO_RESET':
      return {
        ...base,
        consumeState: 'CONFIRMED',
        consumeOutcome: 'nothingToReset',
        refreshState: 'NOT_REQUIRED',
        consumeConfirmedAt: later,
        completedAt: later,
      };
    case 'NO_CREDIT':
      return {
        ...base,
        consumeState: 'CONFIRMED',
        consumeOutcome: 'noCredit',
        refreshState: 'NOT_REQUIRED',
        consumeConfirmedAt: later,
        completedAt: later,
      };
    case 'NOT_ATTEMPTED':
      return {
        ...base,
        consumeState: 'NOT_ATTEMPTED',
        consumeOutcome: null,
        refreshState: 'NOT_REQUIRED',
        failureCode: overrides.failureCode ?? 'CONSUME_EXPIRED',
        completedAt: later,
      };
    case 'UNRESOLVED':
      return {
        ...base,
        consumeState: 'UNRESOLVED',
        consumeOutcome: null,
        refreshState: 'NOT_REQUIRED',
        failureCode: overrides.failureCode ?? 'CONSUME_EXPIRED',
        completedAt: later,
      };
  }
}
