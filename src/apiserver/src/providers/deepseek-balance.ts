import { isDeepSeekKey, type ProviderBalanceAmount, type ProviderBalanceFailure } from '@orbit/shared';

/**
 * The DeepSeek account balance behind a configured provider's key.
 *
 * DeepSeek reports one thing about an account's money: what is left of it, per currency
 * (`GET /user/balance`). It has no API for what a request or a day spent, so what Orbit can show is
 * the whole account's balance — every app and person using that account draws on it — never what a
 * session cost.
 */

/** Fixed, and never derived from a row's baseUrl: both presets point at DeepSeek's /anthropic
 *  compatibility path, under which there is no /user/balance. */
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

const DEEPSEEK_HOST = 'api.deepseek.com';

/** How long the balance request may take; the clients name it when it ran out. */
export const BALANCE_TIMEOUT_MS = 10_000;

/**
 * Whether a row's key is a DeepSeek account's — the only rows a balance is asked for. The same rule
 * the compatibility table runs DeepSeek Harness by (shared `isDeepSeekKey`), so the two never
 * disagree: a preset row is decided by its preset, a custom one (no preset) by its endpoint being
 * DeepSeek's own host.
 */
export function isDeepSeekAccountRow(row: { presetSlug: string | null; baseUrl: string }): boolean {
  return isDeepSeekKey(row);
}

/** DeepSeek's documented names for its error statuses (api-docs.deepseek.com/quick_start/error_codes). */
const DEEPSEEK_STATUS: Readonly<Record<number, string>> = {
  400: 'Invalid Format',
  401: 'Authentication Fails',
  402: 'Insufficient Balance',
  422: 'Invalid Parameters',
  429: 'Rate Limit Reached',
  500: 'Server Error',
  503: 'Server Overloaded',
};

const statusName = (status: number) => (DEEPSEEK_STATUS[status] ? `${status} ${DEEPSEEK_STATUS[status]}` : `HTTP ${status}`);

export interface BalanceFailure {
  reason: ProviderBalanceFailure;
  message: string;
}

/**
 * What a non-OK answer says. Only the status is read, never DeepSeek's error text: a rejected-key
 * message can quote part of the key, and nothing of the key goes to a client.
 */
export function balanceFailureOf(status: number): BalanceFailure {
  if (status === 401 || status === 403) {
    return { reason: 'KEY_REJECTED', message: `DeepSeek rejected this API key (${statusName(status)}).` };
  }
  return {
    reason: 'UPSTREAM_ERROR',
    message: `DeepSeek answered ${statusName(status)}. The key itself wasn't checked.`,
  };
}

/** The request never got an answer: DeepSeek was not reached, or not in time. */
export function networkFailure(timedOut: boolean): BalanceFailure {
  return {
    reason: 'NETWORK',
    message: timedOut
      ? `Couldn't reach ${DEEPSEEK_HOST} — the request timed out after ${BALANCE_TIMEOUT_MS / 1000} s. The key itself wasn't checked.`
      : `Couldn't reach ${DEEPSEEK_HOST}. The key itself wasn't checked.`,
  };
}

/** A 200 whose body is not the balance this reads. */
export const UNREADABLE_BALANCE: BalanceFailure = {
  reason: 'UPSTREAM_ERROR',
  message: "DeepSeek answered with a balance Orbit couldn't read.",
};

/** A decimal amount as DeepSeek writes it ("110.00"); anything else is no amount at all. */
function amount(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
}

/**
 * DeepSeek's `{ is_available, balance_infos: [{ currency, total_balance, granted_balance,
 * topped_up_balance }] }`, or null when the body is anything else — including a list with no
 * currency in it: there is then no balance to show, and an empty one must not read as zero.
 */
export function parseDeepSeekBalance(body: unknown): { isAvailable: boolean; balances: ProviderBalanceAmount[] } | null {
  if (!body || typeof body !== 'object') return null;
  const { is_available: isAvailable, balance_infos: infos } = body as Record<string, unknown>;
  if (typeof isAvailable !== 'boolean' || !Array.isArray(infos) || infos.length === 0) return null;
  const balances: ProviderBalanceAmount[] = [];
  for (const info of infos) {
    if (!info || typeof info !== 'object') return null;
    const entry = info as Record<string, unknown>;
    const currency = typeof entry.currency === 'string' ? entry.currency.trim().toUpperCase() : '';
    const totalBalance = amount(entry.total_balance);
    const grantedBalance = amount(entry.granted_balance);
    const toppedUpBalance = amount(entry.topped_up_balance);
    if (!currency || totalBalance === null || grantedBalance === null || toppedUpBalance === null) return null;
    balances.push({ currency, totalBalance, grantedBalance, toppedUpBalance });
  }
  return { isAvailable, balances };
}
