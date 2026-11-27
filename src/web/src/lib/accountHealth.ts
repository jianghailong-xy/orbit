import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';

/**
 * One blocked account (GET /account-health; docs/routing-account-health-design.md §8 item 2). `kind` is a classified
 * refusal the provider stated, or `UNCLASSIFIED_ADMISSION`, Orbit's own guess after runs failed to start.
 */
export interface AccountHealthBlock {
  /** What POST /account-health/:id/check takes. */
  id: string;
  subjectKey: string;
  runnerId: string | null;
  engine: string | null;
  account: string | null;
  providerId: string | null;
  poolId: string | null;
  scopeModel: string;
  kind: string;
  said: string | null;
  trips: number;
  since: string;
  nextTrialAt: string | null;
  trialRunning: boolean;
  line: string;
}

export const ACCOUNT_HEALTH_QUERY_KEY = ['account-health'] as const;

export const accountHealthQuery = queryOptions({
  queryKey: ACCOUNT_HEALTH_QUERY_KEY,
  meta: { entities: ['provider', 'workspace'] },
  queryFn: () => api<{ blocks?: AccountHealthBlock[] }>('/account-health'),
  staleTime: 30_000,
});

export const checkAgain = (id: string) => api(`/account-health/${id}/check`, { method: 'POST' });

/** The whole-account block of a runner's sign-in, if there is one. */
export function runnerAccountBlock(
  blocks: readonly AccountHealthBlock[] | undefined,
  runnerId: string,
  engine: string,
  account: string,
): AccountHealthBlock | undefined {
  return blocks?.find((b) => b.runnerId === runnerId && b.engine === engine && b.account === account && b.scopeModel === '');
}

/** A task held because no account that could run it can run now (`accountHold` on the task reads; §7.5). */
export interface TaskAccountHold {
  kind: 'ACCOUNT_NEEDS_ACTION';
  /** The sentence to show: the provider's words and the next try. */
  reason: string;
  /** When the first account is tried again (ISO). */
  until: string;
  accounts: Array<{ provider: string; engine: string | null; line: string; until: string }>;
  /** A pinned task held with relaxation off: `orbit-settings:relaxBlockedPins`. */
  setting?: string;
}
