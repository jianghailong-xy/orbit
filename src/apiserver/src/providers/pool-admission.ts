import { decryptSecret } from './provider-crypto';
import { subscriptionUsageRefusal, type SubscriptionUsageRefusal } from './plan-usage';

/** Why a provider may not be in an account pool — see poolMemberRefusal. */
export type PoolMemberRefusal = 'SHARED_PROVIDER' | 'KEY_UNREADABLE' | SubscriptionUsageRefusal;

/** What each refusal tells the owner. */
export const POOL_MEMBER_REFUSALS: Record<PoolMemberRefusal, string> = {
  SHARED_PROVIDER: 'Shared provider — only your own keys can join a pool',
  KEY_UNREADABLE: "Stored key can't be read — add it again",
  NOT_CLAUDE_RUNTIME: 'Not a Claude runtime — no 5-hour window',
  NOT_SUBSCRIPTION_TOKEN: 'Metered API key — no 5-hour window',
  NOT_ANTHROPIC_ENDPOINT: 'Endpoint is not api.anthropic.com',
};

/** What admitting a provider to a pool reads of its row. */
export interface PoolAdmissionRow {
  ownerId: string | null;
  runtime: string;
  baseUrl: string;
  apiKeyEnc: string;
}

/**
 * Why this provider may not be in an account pool, or null when it may. One test for every place that
 * asks: the writes that refuse a member — joining a pool (ProvidersService.assertPoolMembers) and an edit
 * to one already in it (ProvidersService.update) — the list that warns before either is tried (listMine),
 * so the form can never offer a row the write then turns away, or grey out one it takes, and which
 * members a claim may choose from (isPoolCandidate).
 */
export function poolMemberRefusal(row: PoolAdmissionRow): PoolMemberRefusal | null {
  if (row.ownerId === null) return 'SHARED_PROVIDER';
  try {
    return subscriptionUsageRefusal(row, decryptSecret(row.apiKeyEnc));
  } catch {
    return 'KEY_UNREADABLE';
  }
}

/**
 * Whether a claim may choose this member at all. A disabled one is no candidate, and neither is one the
 * pool would turn away today — a metered key, another endpoint, a key that cannot be read. Such a member
 * reports no quota (the usage probe skips it by the same test), so taken as a candidate it would be
 * dispatched on as if it were idle: the metered key into the job env, the subscription token to another
 * endpoint. The claim, the brakes that hold work for a pool, the doors that refuse one and the pools page
 * all choose from these members and no others.
 */
export function isPoolCandidate(row: PoolAdmissionRow & { enabled: boolean }): boolean {
  return row.enabled && poolMemberRefusal(row) === null;
}

/**
 * Why a pool none of whose members can run (selectPoolMember's UNAVAILABLE) is refused, naming why each
 * of them is out: disabled, turned away by the pool's own admission, or — the one reason left once
 * neither is — its key refused. A door that took such a pool would write a session its claim can only
 * run on the Claude default, the runner's own login.
 */
export function poolUnavailableReason(
  label: string,
  members: Array<PoolAdmissionRow & { label: string; enabled: boolean }>,
): string {
  if (members.length === 0) {
    return `the account pool "${label}" has no accounts in it — add one on the Providers page, or pick another provider`;
  }
  const out = members.map((member) => {
    const refusal = poolMemberRefusal(member);
    const why = !member.enabled ? 'disabled' : refusal ? POOL_MEMBER_REFUSALS[refusal] : 'key refused';
    return `${member.label}: ${why}`;
  });
  return (
    `no account in the pool "${label}" can run (${out.join('; ')}) — ` +
    'fix one on the Providers page, or pick another provider'
  );
}
