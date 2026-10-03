import { AgentProvider, type PlanUsageSnapshot, type PlanUsageWindow } from '@orbit/shared';

/**
 * Subscription quota for a configured (BYOK) provider, read with that provider's *own*
 * credential.
 *
 * A runner reports the quota of the account its `claude` CLI is logged into (planusage.go). That
 * says nothing about a ModelProvider row, which bills its own key — which is why a session on a
 * configured slug is never shown the runner login's numbers. The credential is the thing that has
 * a quota, so the row's key is what has to be asked.
 */

/** Anthropic's own endpoint. Only it serves the subscription usage API, so a row pointed at a
 *  proxy or a compatible vendor is never probed — the request would leak the key to a third
 *  party that has no such endpoint. */
const ANTHROPIC_HOST = 'api.anthropic.com';

/** The usage endpoint Claude Code itself calls (same as the runner's planUsageURL). */
export const OAUTH_USAGE_URL = `https://${ANTHROPIC_HOST}/api/oauth/usage`;

/** anthropic-beta value Claude Code sends on OAuth-authenticated requests, mirrored so this
 *  request looks like the CLI's if the header is ever enforced. */
export const OAUTH_USAGE_BETA = 'oauth-2025-04-20';

/** Subscription OAuth access tokens — what `claude` stores after a browser login, and what a BYOK
 *  row holds when its "API key" is really a Claude subscription. A metered `sk-ant-api…` key has
 *  no 5-hour/weekly windows at all (the platform bills per token and reports only per-request
 *  rate-limit headers), so asking on its behalf could only ever 401. */
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat';

export interface UsageProbeRow {
  runtime: string;
  baseUrl: string;
}

/**
 * Whether this row's credential can answer the subscription usage endpoint: an Anthropic-dialect
 * runtime, pointed at Anthropic itself, holding a subscription token. Anything else is skipped
 * silently — there is no quota to show, not a failure to report.
 *
 * A provider configured with an API key is never asked. The endpoint reports the windows of a
 * *subscription*; an API key is metered per token and has no 5-hour or weekly window to report, so
 * the request could only ever be refused. The credential itself is the test — `sk-ant-api…` is a
 * key, `sk-ant-oat…` is a subscription token — because a ModelProvider row holds one field for
 * both (the connect form asks for "your API key", which is what all but one vendor issues).
 */
export function probesSubscriptionUsage(row: UsageProbeRow, apiKey: string): boolean {
  return subscriptionUsageRefusal(row, apiKey) === null;
}

/** The part of probesSubscriptionUsage's test a row fails. */
export type SubscriptionUsageRefusal = 'NOT_CLAUDE_RUNTIME' | 'NOT_SUBSCRIPTION_TOKEN' | 'NOT_ANTHROPIC_ENDPOINT';

/**
 * probesSubscriptionUsage's test, naming the part a row fails — null when it passes. Skipping in
 * silence is right for the probe, but an account pool has to say why it turns a provider away: a
 * member this test fails is never asked about its windows, so it could only ever sit in the pool
 * without being chosen.
 */
export function subscriptionUsageRefusal(row: UsageProbeRow, apiKey: string): SubscriptionUsageRefusal | null {
  if (
    row.runtime === AgentProvider.CODEX ||
    row.runtime === AgentProvider.KIMI ||
    row.runtime === AgentProvider.ANTIGRAVITY
  ) {
    return 'NOT_CLAUDE_RUNTIME';
  }
  if (!apiKey.trim().startsWith(OAUTH_TOKEN_PREFIX)) return 'NOT_SUBSCRIPTION_TOKEN';
  try {
    if (new URL(row.baseUrl).hostname.toLowerCase() === ANTHROPIC_HOST) return null;
  } catch {
    /* not a URL, so not Anthropic's */
  }
  return 'NOT_ANTHROPIC_ENDPOINT';
}

/** What the usage endpoint's refusal of a read says about the credential it was asked with. */
export type UsageFailureKind = 'KEY_REFUSED' | 'USAGE_UNKNOWN';

/**
 * Why a reading failed, as far as the credential is concerned, or null when the failure was outside it
 * (the endpoint unreachable, or answering for its own reasons) and the read is worth retrying.
 *
 * - `KEY_REFUSED` — 401: the token was not authenticated at all, which is the verdict a session's own
 *   request to the same endpoint would meet. Final for the key: a new one is the way back.
 * - `USAGE_UNKNOWN` — 403, and the 401 that names a scope requirement: the token is a credential this
 *   endpoint will not *report on*, while everything else about it is fine. A Claude Code setup token
 *   carries no `user:profile` scope, so the usage read is refused while sessions run on the very same
 *   token — which is no reason to call the key refused, and a reason to keep the member runnable with
 *   its quota unknown. Final for the read too: the same token would get the same answer.
 */
export function usageFailureKind(status: number, message: string): UsageFailureKind | null {
  if (status === 403) return 'USAGE_UNKNOWN';
  if (status !== 401) return null;
  return /\bscope\b/i.test(message) ? 'USAGE_UNKNOWN' : 'KEY_REFUSED';
}

/**
 * The message the endpoint sent with a refusal, for the log line that reports it.
 *
 * `HTTP 403` alone sends whoever reads it looking for the wrong thing — this endpoint's usual
 * refusal is a *scope* problem ("OAuth token does not meet scope requirement user:profile"), and
 * its 429 reads as rate limiting when it is nothing of the sort. Mirrors what the connect form's
 * probe already does with a vendor's error body (ProvidersService.testConnection).
 */
export function usageErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const message = (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ?? parsed.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 200);
  } catch {
    /* non-JSON body → status alone */
  }
  return '';
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** A window is omitted rather than reported as 0% when the endpoint sends null (plans without a
 *  seven_day_opus bucket) or leaves out the utilization — the same rule the runner parser uses. */
function window(raw: unknown): PlanUsageWindow | undefined {
  const w = raw as RawWindow | null | undefined;
  if (!w || typeof w.utilization !== 'number') return undefined;
  return {
    utilization: w.utilization,
    ...(typeof w.resets_at === 'string' ? { resetsAt: w.resets_at } : {}),
  };
}

/**
 * Map the endpoint's snake_case windows onto the shape the clients already render for a runner's
 * Claude login. Returns null when the payload carries no window we understand, so a changed API
 * surfaces as "no quota reported" rather than an empty gauge claiming 0%.
 */
export function parseSubscriptionUsage(body: unknown, fetchedAt: string): PlanUsageSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const windows = {
    fiveHour: window(raw.five_hour),
    sevenDay: window(raw.seven_day),
    sevenDayOpus: window(raw.seven_day_opus),
    sevenDaySonnet: window(raw.seven_day_sonnet),
  };
  if (!Object.values(windows).some(Boolean)) return null;
  return {
    provider: AgentProvider.CLAUDE,
    ...(windows.fiveHour ? { fiveHour: windows.fiveHour } : {}),
    ...(windows.sevenDay ? { sevenDay: windows.sevenDay } : {}),
    ...(windows.sevenDayOpus ? { sevenDayOpus: windows.sevenDayOpus } : {}),
    ...(windows.sevenDaySonnet ? { sevenDaySonnet: windows.sevenDaySonnet } : {}),
    fetchedAt,
  };
}
