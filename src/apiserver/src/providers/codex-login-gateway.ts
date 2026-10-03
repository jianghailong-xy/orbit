import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { AgentProvider, type PlanUsageSnapshot, type PlanUsageWindow } from '@orbit/shared';
import { forwardedHeaders } from './pool-gateway.service';

/**
 * The Codex backend a pool of the account owner's own ChatGPT login sends to (P3-b), as the official
 * codex CLI talks to it — what pool-login-gateway.service.ts holds itself to. Each fact here was read off
 * codex 0.158 signed in with a ChatGPT login against a recorder (runner-go
 * codex_chatgpt_backend_recording_test.go, fixture providers/fixtures/codex-chatgpt-backend-recording.json)
 * and against its source (openai/codex rust-v0.158.0: codex-api api_bridge.rs and rate_limits.rs,
 * model-provider auth.rs, login auth/manager.rs).
 */

/**
 * Where the gateway sends a login pool's requests: the Codex backend of ChatGPT, the codex CLI's own
 * default for a ChatGPT login (codex-rs CHATGPT_CODEX_BASE_URL); codex appends `/responses`. Fixed here —
 * nothing a request carries can point a login elsewhere. Provided under POOL_LOGIN_UPSTREAM so a spec can
 * stand a recorder in its place.
 */
export const CHATGPT_CODEX_BASE = 'https://chatgpt.com/backend-api/codex';
export const POOL_LOGIN_UPSTREAM = 'POOL_LOGIN_UPSTREAM';

/**
 * Where a login's access token is refreshed, and with which OAuth client — the official CLI's own
 * (codex-rs login REFRESH_TOKEN_URL and CLIENT_ID). Provided under POOL_LOGIN_TOKEN_ENDPOINT for specs.
 */
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const POOL_LOGIN_TOKEN_ENDPOINT = 'POOL_LOGIN_TOKEN_ENDPOINT';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/**
 * How long before an access token's own expiry it is refreshed rather than sent — the codex CLI's
 * CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES.
 */
export const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * When a spent subscription names no reset at all — neither `resets_at` nor a window at 100% with a reset
 * of its own nor `retry-after` — the session is held this long, the length of the subscription's shorter
 * window, and asked again: a wrong guess costs one more 429, never a request on another account.
 */
const UNNAMED_RESET_MS = 5 * 60 * 60_000;

/**
 * What codex sent, with the login as its credential: `Authorization: Bearer <access token>` and
 * `ChatGPT-Account-ID: <account id>` — the pair the official CLI authenticates to the Codex backend with
 * (codex-rs model-provider auth.rs; recorded, lower-cased as HTTP carries it, as `chatgpt-account-id`).
 * Nothing else is added: the CLI's own `version`, `x-codex-routing-hint` and zstd body are what it sends
 * as the built-in provider, and a session's codex, on a configured provider, sends none of them. An
 * incoming account header is not codex's to send, and is replaced like the credential.
 */
export function loginForwardedHeaders(
  incoming: IncomingHttpHeaders,
  accessToken: string,
  accountId: string,
  length: number,
): OutgoingHttpHeaders {
  const own = Object.fromEntries(
    Object.entries(incoming).filter(([name]) => name.toLowerCase() !== 'chatgpt-account-id'),
  ) as IncomingHttpHeaders;
  return { ...forwardedHeaders(own, accessToken, length), 'chatgpt-account-id': accountId };
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const number = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** One x-codex-* window, as codex-api rate_limits.rs parse_rate_limit_window reads it. */
function codexWindow(headers: IncomingHttpHeaders, which: 'primary' | 'secondary'): PlanUsageWindow | undefined {
  const used = number(header(headers, `x-codex-${which}-used-percent`));
  if (used === undefined) return undefined;
  const minutes = number(header(headers, `x-codex-${which}-window-minutes`));
  const resetAt = number(header(headers, `x-codex-${which}-reset-at`));
  if (used === 0 && !minutes && resetAt === undefined) return undefined;
  return {
    utilization: used,
    ...(resetAt !== undefined ? { resetsAt: new Date(resetAt * 1000).toISOString() } : {}),
    ...(minutes ? { windowDurationMins: minutes } : {}),
  };
}

/**
 * The subscription's windows as the backend's answer states them — the `x-codex-primary-*` and
 * `x-codex-secondary-*` headers and the credits ones — in the Codex PlanUsageSnapshot shape a runner's own
 * reading has; null when the answer carries none (an API key's answers never do).
 */
export function codexUsageSnapshot(headers: IncomingHttpHeaders, now: Date): PlanUsageSnapshot | null {
  const primary = codexWindow(headers, 'primary');
  const secondary = codexWindow(headers, 'secondary');
  if (!primary && !secondary) return null;
  const hasCredits = header(headers, 'x-codex-credits-has-credits');
  const unlimited = header(headers, 'x-codex-credits-unlimited');
  const balance = header(headers, 'x-codex-credits-balance')?.trim();
  return {
    provider: AgentProvider.CODEX,
    limitId: 'codex',
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(hasCredits !== undefined && unlimited !== undefined
      ? { credits: { hasCredits: hasCredits === 'true', unlimited: unlimited === 'true', ...(balance ? { balance } : {}) } }
      : {}),
    fetchedAt: now.toISOString(),
  };
}

/** The spent window of a snapshot — at or over 100% — or null. */
function spentWindow(snapshot: PlanUsageSnapshot | null): PlanUsageWindow | null {
  return [snapshot?.primary, snapshot?.secondary].find((window) => window && window.utilization >= 100) ?? null;
}

/**
 * Until when a subscription whose usage limit is reached stays so: the `resets_at` (unix seconds) of the
 * backend's `usage_limit_reached` — what the codex CLI reads its "try again at" from — else the reset of a
 * window the headers say is spent, else `retry-after`, else UNNAMED_RESET_MS from now.
 */
export function usageLimitResetAt(body: unknown, headers: IncomingHttpHeaders, now: Date): Date {
  const error = (body as { error?: { resets_at?: unknown } } | undefined)?.error;
  const resetsAt = typeof error?.resets_at === 'number' ? error.resets_at * 1000 : NaN;
  if (Number.isFinite(resetsAt) && resetsAt > now.getTime()) return new Date(resetsAt);
  const window = spentWindow(codexUsageSnapshot(headers, now));
  const windowReset = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (Number.isFinite(windowReset) && windowReset > now.getTime()) return new Date(windowReset);
  const after = header(headers, 'retry-after');
  if (after !== undefined) {
    const seconds = Number(after);
    const at = Number.isFinite(seconds) ? now.getTime() + seconds * 1000 : Date.parse(after);
    if (Number.isFinite(at) && at > now.getTime()) return new Date(at);
  }
  return new Date(now.getTime() + UNNAMED_RESET_MS);
}

/**
 * The refresh the codex CLI sends for a ChatGPT login (recorded): a JSON POST of exactly these three
 * fields, in this order.
 */
export function refreshRequestBody(refreshToken: string): string {
  return JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** The codex CLI's own words for a refresh that can never succeed (login auth/manager.rs). */
const REFRESH_REFUSED: Record<string, string> = {
  refresh_token_expired:
    'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  refresh_token_reused:
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
  refresh_token_invalidated:
    'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
};
const REFRESH_REFUSED_OTHERWISE = 'Your access token could not be refreshed. Please log out and sign in again.';

/**
 * What a token endpoint's refusal means, as the codex CLI classifies it (classify_refresh_token_failure):
 * PERMANENT — a 401, a 400 `invalid_grant`, or one of the three refresh_token_* codes — and the login can
 * only be signed in again; TRANSIENT otherwise, and the next request tries again. `message` is the CLI's
 * sentence for it, which is what the pool page shows as the reason.
 */
export function refreshRefusal(status: number, body: unknown): { permanent: boolean; message: string } {
  const record = (body ?? {}) as { error?: unknown; code?: unknown; error_code?: unknown };
  const nested = record.error && typeof record.error === 'object' ? (record.error as { code?: unknown }) : null;
  const code = [nested?.code, record.error_code, record.code, record.error]
    .find((value): value is string => typeof value === 'string' && value !== '')
    ?.toLowerCase();
  const known = code ? REFRESH_REFUSED[code] : undefined;
  if (known) return { permanent: true, message: known };
  if (status === 401 || (status === 400 && code === 'invalid_grant')) {
    return { permanent: true, message: REFRESH_REFUSED_OTHERWISE };
  }
  return { permanent: false, message: `the token endpoint answered ${status}` };
}

/** How an account is named in the words below: its email, else its masked id. */
export function accountName(login: { email: string | null; accountId: string }): string {
  return login.email ?? `…${login.accountId.slice(-4)}`;
}

/** A window's name, as the personal pools' notices give it (pool-select.ts WINDOWS). */
export function windowName(window: PlanUsageWindow | null): string | null {
  const minutes = window?.windowDurationMins;
  if (!minutes) return null;
  if (minutes === 300) return '5-hour';
  if (minutes === 7 * 24 * 60) return 'weekly';
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The transcript line a session of a login pool is owed when its account's usage limit is reached: which
 * window, on which account, and when the session goes again. Not "Switched to …": that is the line of the
 * claim that moves the session to another account (pool-login-select.ts loginSwitchNotice), which says it
 * in this one's place. This one stands when the session stays and waits for its account.
 */
export function loginSpentNotice(login: { email: string | null; accountId: string }, snapshot: PlanUsageSnapshot | null, resetAt: Date): string {
  const window = windowName(spentWindow(snapshot));
  const what = window ? `The ${window} window on ${accountName(login)} is spent` : `The usage limit on ${accountName(login)} is reached`;
  return `${what} — this session waits for its reset at ${utcMinute(resetAt)}`;
}

/**
 * Why a session of a Codex pool can send nothing: its account was signed out by OpenAI, and signing it in
 * again is the person who signed it in's alone (migration 0371; the pool's owner's alone before that, and
 * an admin of the pool cannot either — they have no credential for that account). `byContributor` says
 * whose session is owed the line — the account's own contributor's, or somebody else's, who can only ask.
 * The gateway's refusal, and the line the transcript is owed when it happens.
 */
export function loginSignedOutNotice(
  login: { email: string | null; accountId: string },
  poolLabel: string,
  byContributor = true,
): string {
  const way = byContributor
    ? 'only you can sign in again'
    : 'only the person who signed it in can sign in again';
  return `The ChatGPT account ${accountName(login)} on "${poolLabel}" was signed out by OpenAI — ${way}, on the pool's page`;
}

/** Why a session of a Codex pool can send nothing because the pool holds no account. Whoever may add one
 *  (an admin, or a member while the pool's rule for it is on) does it there, so the sentence is one. */
export function loginMissingReason(poolLabel: string): string {
  return `"${poolLabel}" has no ChatGPT account signed in — sign one in on the pool's page`;
}
