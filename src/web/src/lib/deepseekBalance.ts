import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProviderBalance, ProviderBalanceAmount, ProviderBalanceFailure } from '@orbit/shared';
import { api } from '../api';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from './providerAdmin';

// The DeepSeek account balance behind a DeepSeek key (GET /providers/mine/:id/balance). The server
// asks DeepSeek with the stored key and answers with the balance alone; it is the whole account's
// balance, not what Orbit or a session spent — DeepSeek has no spend API to ask.

/** Where DeepSeek takes a top-up. Orbit can't top up for anyone; it only links there. */
export const DEEPSEEK_TOP_UP_URL = 'https://platform.deepseek.com/top_up';

const DEEPSEEK_PRESETS = ['deepseek', 'deepseek-harness'];

/**
 * Whether a row has a DeepSeek account balance to show: a key the server can ask with, and a key of
 * DeepSeek's — one of its two presets, or a custom endpoint on DeepSeek's own host. The server
 * applies the same test (deepseek-balance.ts) and refuses any other row.
 */
export function hasDeepSeekBalance(row: Pick<ProviderRow, 'presetSlug' | 'baseUrl' | 'hasApiKey'>): boolean {
  if (!row.hasApiKey) return false;
  if (row.presetSlug) return DEEPSEEK_PRESETS.includes(row.presetSlug);
  try {
    return new URL(row.baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Under the providers list's key, so saving or deleting a provider reads its balance again. */
export const deepseekBalanceKey = (id: string) => [...PROVIDERS_LIST_KEY, id, 'balance'];

export const deepseekBalanceQuery = (id: string) =>
  queryOptions({
    queryKey: deepseekBalanceKey(id),
    queryFn: () => api<ProviderBalance>(`${PROVIDERS_BASE}/${id}/balance`),
    // The server serves one read for 90 s; asking again sooner only gets that read back.
    staleTime: 60_000,
  });

/**
 * One provider's balance, and a refresh that asks DeepSeek again (the server lets that through at
 * most once per 10 s for a key). Providers holding the same key share the server's read, so they
 * are read again with it.
 */
export function useDeepSeekBalance(id: string) {
  const qc = useQueryClient();
  const query = useQuery(deepseekBalanceQuery(id));
  const refresh = useMutation({
    mutationFn: () => api<ProviderBalance>(`${PROVIDERS_BASE}/${id}/balance?refresh=1`),
    onSuccess: (read) => {
      qc.setQueryData(deepseekBalanceKey(id), read);
      for (const sibling of read.sharedWith) void qc.invalidateQueries({ queryKey: deepseekBalanceKey(sibling.id) });
    },
  });
  return { query, refresh };
}

/** What a failure is, in the few words a provider row has room for. */
export const BALANCE_FAILURE_LABEL: Record<ProviderBalanceFailure, string> = {
  KEY_REJECTED: 'API key rejected',
  NETWORK: 'network error',
  UPSTREAM_ERROR: 'DeepSeek error',
};

/**
 * What a balance read comes to on screen. There is no state in which a number stands in for an
 * answer: until one arrives it is `loading`, and a read that failed — or a request that never
 * reached the server — is `failed`, with why, and no amount at all.
 */
export type BalanceView =
  | { kind: 'loading' }
  | { kind: 'read'; balance: Extract<ProviderBalance, { ok: true }> }
  | { kind: 'failed'; reason: ProviderBalanceFailure | null; label: string; message: string; triedAt: string | null };

export function balanceView(data: ProviderBalance | undefined, error: Error | null): BalanceView {
  if (data?.ok) return { kind: 'read', balance: data };
  if (data) {
    return { kind: 'failed', reason: data.reason, label: BALANCE_FAILURE_LABEL[data.reason], message: data.message, triedAt: data.fetchedAt };
  }
  if (error) return { kind: 'failed', reason: null, label: "couldn't load", message: error.message, triedAt: null };
  return { kind: 'loading' };
}

const SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' };

/** An amount as DeepSeek wrote it, with two decimals and its currency's sign: "¥110.00", "$5.00",
 *  or "12.30 EUR" for a currency without one here. */
export function formatBalance(amount: string, currency: string): string {
  const n = Number(amount);
  const text = Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
  return SYMBOL[currency] ? `${SYMBOL[currency]}${text}` : `${text} ${currency}`;
}

/** The granted and topped-up shares of one currency's bar, in percent — or null when DeepSeek's
 *  two parts add up to nothing to split. */
export function balanceSplit(balance: ProviderBalanceAmount): { granted: number; toppedUp: number } | null {
  const granted = Number(balance.grantedBalance);
  const toppedUp = Number(balance.toppedUpBalance);
  const sum = granted + toppedUp;
  if (!(sum > 0) || granted < 0 || toppedUp < 0) return null;
  return { granted: (granted / sum) * 100, toppedUp: (toppedUp / sum) * 100 };
}

/** "just now", "2 min ago", "3 h ago", "2 d ago": when the server last asked DeepSeek. */
export function balanceAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}
