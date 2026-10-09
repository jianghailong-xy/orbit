import { ACCOUNT_DISABLED, MANAGED_RUNNER_NOT_ELIGIBLE, type ManagedRunnerReason } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

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
 *
 * Whatever the rule says, an account an administrator has disabled is not eligible: the service asks
 * the rule through `enabledAccountsOnly`, and only about an account that is not disabled.
 */
export interface ManagedRunnerEligibility {
  eligible(ownerId: string): Promise<boolean>;
}

/** The DI token of the rule. Unprovided, ManagedRunnerService asks `EVERY_ACCOUNT`. */
export const MANAGED_RUNNER_ELIGIBILITY = Symbol('MANAGED_RUNNER_ELIGIBILITY');

/** The current rule: with the switch on, every account. */
export const EVERY_ACCOUNT: ManagedRunnerEligibility = { eligible: async () => true };

/**
 * Whether an administrator has disabled the account (`User.disabledAt`, docs/google-sign-in-design.md
 * §5.5). Its runner is refused at every door then, so its managed runner is not given, started, woken
 * or kept running (docs/managed-runner-design.md, "Implementation record: disabled accounts"). One
 * read by the primary key; an account that is not there is not a disabled one.
 */
export async function ownerAccountDisabled(prisma: Pick<PrismaService, 'user'>, ownerId: string): Promise<boolean> {
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { disabledAt: true } });
  return !!owner?.disabledAt;
}

/**
 * The decision ManagedRunnerService asks: `rule`, about an account that is not disabled. A disabled
 * account is not eligible whatever the rule says, and the rule is not asked about it. `rule` is read
 * at each call, so a rule changed in place applies at once.
 */
export function enabledAccountsOnly(rule: ManagedRunnerEligibility, prisma: Pick<PrismaService, 'user'>): ManagedRunnerEligibility {
  return {
    eligible: async (ownerId) => {
      if (await ownerAccountDisabled(prisma, ownerId)) return false;
      return rule.eligible(ownerId);
    },
  };
}

export function managedRunnerNotEligibleReason(): ManagedRunnerReason {
  return {
    code: MANAGED_RUNNER_NOT_ELIGIBLE,
    message: 'This Orbit server does not give your account a managed runner. Your own runners are unaffected.',
    retryable: false,
  };
}

/** What a disabled owner's status says, and what each of its managed runner writes is refused with (403). */
export function managedRunnerAccountDisabledReason(): ManagedRunnerReason {
  return {
    code: ACCOUNT_DISABLED,
    message: 'This Orbit account is disabled, so its managed runner is not started or woken, and a running one is put to sleep with its data kept. An administrator can enable the account again.',
    retryable: false,
  };
}
