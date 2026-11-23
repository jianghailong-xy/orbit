import { isAuthErrorText, isConnectionFailureText, isUsageLimitErrorText } from './events';

/**
 * What a failed run failed with, as the runner's engine adapter classified it
 * (docs/routing-account-health-design.md §4). Engine-agnostic: a kind says whether the failure is about the
 * task, the account or neither. Absent (null) is "not classified", the safe default.
 */
export enum RunFailureKind {
  /** The account's allowance is spent. */
  USAGE_LIMIT = 'USAGE_LIMIT',
  /** The provider is turning requests for a model away for now. */
  CAPACITY = 'CAPACITY',
  /** Signed in, but the account must be changed by a person (payment method, plan, a setting). */
  ACCOUNT_ACTION_REQUIRED = 'ACCOUNT_ACTION_REQUIRED',
  /** The credential itself is not accepted. */
  CREDENTIAL_REFUSED = 'CREDENTIAL_REFUSED',
  /** The credential is accepted but this use is not allowed. */
  ACCESS_DENIED = 'ACCESS_DENIED',
  /** The request did not get a real answer; says nothing of the account. */
  TRANSPORT = 'TRANSPORT',
  /** The provider refused this request (content policy, context too long). */
  REQUEST_REFUSED = 'REQUEST_REFUSED',
}

/** What a failure kind is about: the whole account (the default), one model on it, this machine, or the request. */
export type RunFailureScope = 'account' | 'model' | 'runner' | 'request';

export const RUN_FAILURE_SCOPES: readonly RunFailureScope[] = ['account', 'model', 'runner', 'request'];

/** The provider's own words are kept to this many characters (§5.1). */
export const RUN_FAILURE_SAID_MAX = 300;

/** A failed turn's classification on the wire: turn-complete, finalize and the SubAgent fallback request (§5.1). */
export interface RunFailure {
  kind: RunFailureKind;
  /** Omitted: 'account'. */
  scope?: RunFailureScope;
  /** When the provider says it can run again (ISO); only with USAGE_LIMIT or CAPACITY. */
  until?: string;
  /** The provider's own words, unedited, at most RUN_FAILURE_SAID_MAX characters: what the owner is shown. */
  said?: string;
}

/**
 * What a run's error says when the provider found the model at capacity ("Selected model is at capacity"),
 * matched case-insensitively as a substring. Keep it identical to isCodexCapacityError in src/runner-go/codex.go.
 */
export const MODEL_AT_CAPACITY_ERROR_MARKER = 'at capacity';

/** How a sign-in failure may open when the engine does not wrap it in `Failed to authenticate` (Codex, OAuth). */
const LOGIN_FAILURE_OPENINGS = ['not logged in', 'oauth session expired'];

/**
 * Whether a text is a failed login: the runtime's `Failed to authenticate` (isAuthErrorText, which leaves out a
 * dropped connection), or a text that opens as `Not logged in` / `OAuth session expired`. Kept in sync with
 * isSubagentLoginFailure in runner-go/subagent_fallback.go.
 */
export function isLoginFailureText(error: string | null | undefined): boolean {
  if (!error) return false;
  if (isAuthErrorText(error)) return true;
  const opening = error.trimStart().toLowerCase();
  return LOGIN_FAILURE_OPENINGS.some((marker) => opening.startsWith(marker));
}

const RUN_FAILURE_KINDS = new Set<string>(Object.values(RunFailureKind));

/** The stored or sent kind as a RunFailureKind; null for an absent or unknown one (a newer runner's kind). */
export function parseRunFailureKind(kind: unknown): RunFailureKind | null {
  return typeof kind === 'string' && RUN_FAILURE_KINDS.has(kind) ? (kind as RunFailureKind) : null;
}

/**
 * The legacy reading of a failure's text, for runs whose runner sent no kind (older runners, and history from
 * before the kinds). It adds no markers of its own: it is exactly the classifiers that existed before the kinds.
 */
export function legacyRunFailureKind(error: string | null | undefined): RunFailureKind | null {
  if (!error) return null;
  if (isUsageLimitErrorText(error)) return RunFailureKind.USAGE_LIMIT;
  if (error.toLowerCase().includes(MODEL_AT_CAPACITY_ERROR_MARKER)) return RunFailureKind.CAPACITY;
  if (isConnectionFailureText(error)) return RunFailureKind.TRANSPORT;
  if (isLoginFailureText(error)) return RunFailureKind.CREDENTIAL_REFUSED;
  return null;
}

/**
 * The failure kind of a released run (§5.4): the runner's, else what the legacy markers say of its error text.
 * The one reader every server decision about a failure's class goes through.
 */
export function runFailureKind(run: { failureKind?: string | null; error?: string | null }): RunFailureKind | null {
  return parseRunFailureKind(run.failureKind) ?? legacyRunFailureKind(run.error);
}

/**
 * A wire `failure` as it may be stored: a known kind, a known scope (else none), and the provider's words clipped.
 * Null for an absent or malformed one, or a kind this server does not know, which then reads through the markers.
 */
export function normalizeRunFailure(failure: unknown): { kind: RunFailureKind; scope: RunFailureScope | null; said: string | null } | null {
  if (!failure || typeof failure !== 'object') return null;
  const raw = failure as { kind?: unknown; scope?: unknown; said?: unknown };
  const kind = parseRunFailureKind(raw.kind);
  if (!kind) return null;
  const scope = RUN_FAILURE_SCOPES.find((value) => value === raw.scope) ?? null;
  const said = typeof raw.said === 'string' && raw.said.trim() ? raw.said.slice(0, RUN_FAILURE_SAID_MAX) : null;
  return { kind, scope, said };
}
