import { MANAGED_RUNNER_NOT_ELIGIBLE, type ManagedRunnerReason } from '@orbit/shared';

/**
 * Who is given a managed runner: the one server-side decision both allocation entry points ask — a
 * sign-in (ManagedRunnerService.signedIn) and an explicit ensure — and that the status read reports
 * (docs/managed-runner-design.md, "Resource admission model supply and isolation").
 *
 * Asked only while the switch is on. Today every account is eligible, which is what switching the
 * feature on means. Sign-up is open on deployments with Google sign-in, while the first version's
 * isolation is meant for invited testers only, so this is where a narrower rule goes: a change to
 * `EVERY_ACCOUNT`, or another implementation provided under the token, and nowhere else. It reads
 * no configuration of its own.
 */
export interface ManagedRunnerEligibility {
  eligible(ownerId: string): Promise<boolean>;
}

/** The DI token of the decision. Unprovided, ManagedRunnerService asks `EVERY_ACCOUNT`. */
export const MANAGED_RUNNER_ELIGIBILITY = Symbol('MANAGED_RUNNER_ELIGIBILITY');

/** The current decision: with the switch on, every account. */
export const EVERY_ACCOUNT: ManagedRunnerEligibility = { eligible: async () => true };

export function managedRunnerNotEligibleReason(): ManagedRunnerReason {
  return {
    code: MANAGED_RUNNER_NOT_ELIGIBLE,
    message: 'This Orbit server does not give your account a managed runner. Your own runners are unaffected.',
    retryable: false,
  };
}
