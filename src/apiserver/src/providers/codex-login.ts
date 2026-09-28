import type { PlanUsageSnapshot } from '@orbit/shared';

/**
 * The account a codex login pool runs on: the owner's own ChatGPT/Codex subscription login, signed in by
 * this server with the official codex CLI and held encrypted (migration 0323,
 * docs/codex-shared-pool-design.md §2.4–§2.5 in this direction). Nothing in this file holds a token for
 * longer than the call that read it, and nothing it builds carries one: what a response shows of an
 * account is its email and `maskedAccount`'s last four characters.
 */

/** The sign-in page `codex login --device-auth` prints, and the one-time code the person types there. */
const DEVICE_URL = /https:\/\/auth\.openai\.com\/[^\s\x1b\x07"']*device[^\s\x1b\x07"']*/;
/** A code: two groups of upper-case letters and digits, as the CLI prints (`ZXHO-K06HC`). */
const DEVICE_CODE = /[A-Z0-9]{4,}-[A-Z0-9]{4,}/;

/** The half of the device flow the person needs: where to go, and what to type there. */
export interface DeviceChallenge {
  verificationUrl: string;
  userCode: string;
}

/**
 * The challenge in the CLI's output so far, or null until it has printed both halves — a URL with no code
 * leaves the person on a page they cannot get past, so neither is reported without the other. Read the
 * way the runner's own sign-in relay reads it (runner-go login.go): the code is anchored to the line that
 * announces it ("2. Enter this one-time code"), so nothing else that happens to look like one — a version
 * tag, an id in a warning — can be mistaken for it.
 */
export function codexDeviceChallenge(output: string): DeviceChallenge | null {
  const announced = output.indexOf('one-time code');
  if (announced < 0) return null;
  const urls = output.match(new RegExp(DEVICE_URL.source, 'g'));
  const userCode = DEVICE_CODE.exec(output.slice(announced))?.[0];
  if (!urls?.length || !userCode) return null;
  return { verificationUrl: urls[urls.length - 1], userCode };
}

/** What a person's login says of their account, read once and then held only as this. */
export interface CodexLoginTokens {
  accessToken: string;
  refreshToken: string;
  /** OpenAI's account id out of the token claims; TEXT in the database, and never a response. */
  accountId: string;
  email: string | null;
  /** The plan the claims name (`plus`, `pro`, …), when they name one. */
  plan: string | null;
  /** When the access token stops being good; see ACCESS_TOKEN_FALLBACK_MS. */
  expiresAt: Date;
}

/** A login whose files are not what the CLI writes. The message never repeats any of it. */
export class CodexAuthError extends Error {}

/**
 * How long an access token is assumed to be good for when its own claims carry no `exp`. The value is a
 * backstop, not a policy: the gateway refreshes on the upstream's own 401 whatever this says, and a token
 * whose lifetime is shorter than this is refreshed a little late rather than never.
 */
const ACCESS_TOKEN_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The claims inside a JWT, or null — a token that is not one, or whose part does not parse. */
function claimsOf(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const stringAt = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * The account id, email and plan inside one token's claims. Codex's tokens carry them under
 * `https://api.openai.com/auth` (the id and the plan) and at the top level (the email); the two spellings
 * are read in that order so a token that names only one is still understood.
 */
function accountOf(token: string) {
  const claims = claimsOf(token) ?? {};
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  return {
    accountId: stringAt(auth.chatgpt_account_id) ?? stringAt(auth.account_id),
    email: stringAt(claims.email),
    plan: stringAt(auth.chatgpt_plan_type) ?? stringAt(claims.chatgpt_plan_type),
    expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null,
  };
}

/**
 * The `auth.json` the codex CLI writes when a login completes, as the credential this server stores. The
 * file is read from the throwaway CODEX_HOME the sign-in ran in and never copied anywhere: only the four
 * values below leave this function, and two of them leave the process only encrypted.
 *
 * The account is read off the id token and falls back to the access token — both carry the same claim
 * block, and the id token is the one that is the account's identity. An account id is required: a file
 * without one is not a completed login, whatever else it holds.
 *
 * No signature is verified here, and none needs to be: the file was written by the official CLI in a
 * directory this server made for that one sign-in and removes the moment it has read it, and what the
 * claims say is naming — the email and plan a page shows. The token that is actually trusted is the
 * access token, and it is the upstream that judges it on every request the gateway forwards.
 */
export function parseCodexAuthJson(raw: string, now = new Date()): CodexLoginTokens {
  let parsed: { tokens?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexAuthError('the codex CLI left a file this server cannot read');
  }
  const tokens = parsed?.tokens ?? {};
  const accessToken = stringAt(tokens.access_token);
  const refreshToken = stringAt(tokens.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new CodexAuthError('the codex CLI left no token pair');
  }
  const identity = accountOf(stringAt(tokens.id_token) ?? accessToken);
  const accountId = stringAt(tokens.account_id) ?? identity.accountId;
  if (!accountId) throw new CodexAuthError('the codex CLI left no account id');
  const durable = identity.accountId ? identity : accountOf(accessToken);
  return {
    accessToken,
    refreshToken,
    accountId,
    email: identity.email ?? durable.email,
    plan: identity.plan ?? durable.plan,
    expiresAt: durable.expiresAt ?? new Date(now.getTime() + ACCESS_TOKEN_FALLBACK_MS),
  };
}

/** What every response names an account by: `…AB12`, its last four characters. */
export const maskedAccount = (accountId: string) => `…${accountId.slice(-4)}`;

/**
 * An account as the pool page and the login's poll read it. `state` is the whole of what has happened to
 * the CREDENTIAL — ACTIVE, or SIGNED_OUT once the upstream refused it (a 401 through the gateway, which is
 * what sets it). A quota that could not be read is not that and never moves this: `usage` is null and
 * `usageUnavailable` says why, and the account runs either way.
 */
export interface CodexLoginView {
  state: string;
  email: string | null;
  plan: string | null;
  fingerprint: string;
  lastError: string | null;
  expiresAt: string;
  linkedAt: string;
  /** The account's quota as something read it; null when nothing has (not a refusal, and not SPENT). */
  usage: PlanUsageSnapshot | null;
  usageUnavailable: string | null;
}

/** Why `usage` is null when it is: nothing has read this account's quota yet. */
export const CODEX_USAGE_UNREAD = 'no quota has been read for this account yet';

/** The stored account as a response reads it, or null when the pool has none. */
export function codexLoginView(
  row: {
    accountId: string;
    email: string | null;
    plan: string | null;
    state: string;
    lastError: string | null;
    expiresAt: Date;
    createdAt: Date;
  } | null,
  usage: PlanUsageSnapshot | null = null,
): CodexLoginView | null {
  if (!row) return null;
  return {
    state: row.state,
    email: row.email,
    plan: row.plan,
    fingerprint: maskedAccount(row.accountId),
    lastError: row.lastError,
    expiresAt: row.expiresAt.toISOString(),
    linkedAt: row.createdAt.toISOString(),
    usage,
    usageUnavailable: usage ? null : CODEX_USAGE_UNREAD,
  };
}

/**
 * Why a codex login pool can take no session: it has no account signed in, or the one it has was refused
 * and only its owner can sign in again. The doors that write a provider onto a session or a task refuse
 * such a pool with this string (QueueService.accountPoolRefusal) — the same shape the member pools'
 * refusals take, and for the same reason: taken, the claim could only run on the runner's own login.
 */
export function codexLoginUnavailableReason(
  label: string,
  account: { email: string | null; state: string } | null,
): string | null {
  if (!account) {
    return `the pool "${label}" has no ChatGPT account signed in — sign in on its page, or pick another provider`;
  }
  if (account.state !== 'ACTIVE') {
    const who = account.email ?? 'the account';
    return `the ChatGPT account ${who} on the pool "${label}" was rejected by OpenAI — sign in again on its page, or pick another provider`;
  }
  return null;
}
