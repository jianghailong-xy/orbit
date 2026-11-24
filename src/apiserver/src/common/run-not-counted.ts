import { Prisma } from '@prisma/client';
import { MODEL_AT_CAPACITY_ERROR_MARKER, parseRunFailureKind, RunFailureKind, USAGE_LIMIT_ERROR_MARKERS } from '@orbit/shared';
import type { ModelRoutingNotCounted } from '../tasks/model-routing';

/**
 * Whether a failed run is held against its task (docs/routing-account-health-design.md §7.4): one definition, read by
 * tier escalation (task-route-decision.ts readRunHistory) and by the auto-run failure budget (autoRunHoldOff, through
 * notCountedFilter, its SQL twin), so the two cannot disagree (model-routing-design.md §3.3).
 *
 * Not counted, in this order:
 * - the runner's kind says the failure was the account's or the provider's: a usage limit, a model at capacity, an
 *   account that needs action, a refused credential, an access denial, a lost connection;
 * - with no kind, the legacy markers that already exempted a run before the kinds: a usage limit or a model at
 *   capacity anywhere in its error (the SQL `contains` reading);
 * - with neither, account health acted on it (session.account_health_effect): the breaker struck or blocked the
 *   account, or the run was a refused trial. An unclassified admission failure counts again once health no longer
 *   acts on it, because then the evidence points at the task.
 * A kind health has no word for (REQUEST_REFUSED) and an ordinary failure count.
 */
export function runNotCounted(run: {
  failureKind: string | null;
  error: string | null;
  accountHealthEffect: string | null;
}): ModelRoutingNotCounted | null {
  const kind = parseRunFailureKind(run.failureKind);
  if (kind) {
    const byKind = KIND_NOT_COUNTED[kind];
    if (byKind) return byKind;
  } else {
    const error = run.error?.toLowerCase() ?? '';
    if (LEGACY_USAGE.some((marker) => error.includes(marker))) return 'usage-limit';
    if (LEGACY_CAPACITY.some((marker) => error.includes(marker))) return 'capacity';
  }
  if (run.accountHealthEffect) return kind ? 'account' : 'admission';
  return null;
}

const KIND_NOT_COUNTED: Partial<Record<RunFailureKind, ModelRoutingNotCounted>> = {
  [RunFailureKind.USAGE_LIMIT]: 'usage-limit',
  [RunFailureKind.CAPACITY]: 'capacity',
  [RunFailureKind.ACCOUNT_ACTION_REQUIRED]: 'account',
  [RunFailureKind.CREDENTIAL_REFUSED]: 'account',
  [RunFailureKind.ACCESS_DENIED]: 'account',
  [RunFailureKind.TRANSPORT]: 'transport',
};

/** The kinds runNotCounted exempts outright. */
export const NOT_COUNTED_KINDS = Object.keys(KIND_NOT_COUNTED) as RunFailureKind[];

// The legacy markers failureKindIs (run-failure-kind-filter.ts) reads: plain lowercase substrings, for SQL too.
const LEGACY_USAGE: readonly string[] = USAGE_LIMIT_ERROR_MARKERS;
const LEGACY_CAPACITY: readonly string[] = [MODEL_AT_CAPACITY_ERROR_MARKER];

/**
 * A Prisma session filter: the failed run counts against its task (runNotCounted answers null). Written out rather
 * than as a NOT of the exemptions, because a negated match is not true of a NULL (failureKindIsNot).
 */
export function countedFilter(): Prisma.SessionWhereInput {
  const markers = [...LEGACY_USAGE, ...LEGACY_CAPACITY]
    .map((marker) => ({ error: { contains: marker, mode: Prisma.QueryMode.insensitive } }));
  return {
    AND: [
      { accountHealthEffect: null },
      {
        OR: [
          { AND: [{ NOT: { failureKind: null } }, { failureKind: { notIn: [...NOT_COUNTED_KINDS] } }] },
          { failureKind: null, OR: [{ error: null }, { NOT: { OR: markers } }] },
        ],
      },
    ],
  };
}
