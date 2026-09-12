import {
  CODEX_RATE_LIMIT_RESET_ENUMS,
  CODEX_RATE_LIMIT_RESET_TIMING,
  CODEX_RATE_LIMIT_RESET_WIRE,
  codexRateLimitResetOf,
  codexRateLimitResetViolations,
  codexResetCreditDetails,
  codexResetOperationViewViolations,
  codexResetRefusal,
  codexResetSnapshotFresh,
  isCodexAccountFingerprint,
  isCodexResetUuid,
  type CodexRateLimitResetOperations,
  type CodexRateLimitResetOperationView,
  type CodexRateLimitResetRefusalCode,
  type CodexRateLimitResetResultCode,
  type CodexResetCreditDetails,
  type PlanUsage,
  type PlanUsageRateLimitReset,
} from '@orbit/shared';
import { ApiError } from '../api';

/**
 * The web half of Codex earned rate-limit reset (docs/codex-rate-limit-reset-contract.md §6.1, §7.3).
 *
 * Everything here is a pure reading of what the API already said: which entry the Plan usage popover
 * offers, how a confirmation is remembered across a reload, and what each operation state means to
 * the person who pressed. The browser only ever holds the clientRequestId of its own confirmation;
 * the provider idempotency key never reaches it.
 */

export const CODEX_RESET_CLIENT_TIMING = {
  /** §6.1: a page polls every 2–3 seconds while an operation is active. */
  pollMs: 2_500,
  /** A create with no answer by then is abandoned and sent again under the same clientRequestId. */
  postTimeoutMs: 15_000,
  /** Automatic re-sends of an unanswered create before the card hands Retry to the user. */
  retryDelaysMs: [2_000, 5_000] as number[],
  /** How often the "Updated N min ago" line is re-read while the card can be seen. */
  clockTickMs: 30_000,
  /** A settled result stays on the card across reloads until dismissed, but not indefinitely. */
  settledIntentTtlMs: 24 * 60 * 60_000,
};

/** The runner fields reset admission reads, as GET /runners carries them. */
export interface CodexResetRunner {
  id: string;
  name?: string;
  displayName?: string | null;
  online?: boolean;
  capabilities?: readonly string[] | null;
  heartbeatLeaseOwner?: string | null;
  heartbeatDraining?: boolean | null;
  planUsage?: PlanUsage | null;
}

export type CodexResetAvailability =
  | { kind: 'ready' }
  | { kind: 'in-flight' }
  | { kind: 'blocked'; code: CodexRateLimitResetRefusalCode; reason: string };

export interface CodexResetCard {
  block: PlanUsageRateLimitReset;
  accountFingerprint: string;
  details: CodexResetCreditDetails;
  availability: CodexResetAvailability;
}

/** What each refusal tells the reader. Codes the card never draws a button for still need words:
 *  the create route can answer with any of them. */
export const CODEX_RESET_REFUSAL_REASON: Readonly<Record<CodexRateLimitResetRefusalCode, string>> = {
  REQUEST_ID_REUSED: "That request couldn't be matched to this runner. Try again.",
  ACCOUNT_OVERRIDE:
    "This workspace doesn't run on the runner's own Codex sign-in, so its reset credits can't be used here.",
  OPERATION_IN_FLIGHT: 'A reset is already in progress for this Codex account.',
  RUNNER_OFFLINE: 'The runner is offline.',
  CAPABILITY_MISSING: 'Update this runner to use reset credits.',
  NO_ACTIVE_LEASE: "The runner hasn't checked in yet.",
  RUNNER_DRAINING: 'The runner is restarting.',
  SNAPSHOT_MISSING: "This runner hasn't reported reset credits.",
  UNSUPPORTED_AUTH: 'Reset credits need a ChatGPT sign-in on this runner.',
  PROVIDER_UNSUPPORTED: "This runner's Codex CLI doesn't support reset credits.",
  ACCOUNT_UNIDENTIFIED: "Codex didn't say which account this is.",
  ACCOUNT_MISMATCH: "The runner's Codex account changed. Check the updated usage before trying again.",
  SNAPSHOT_STALE: 'Usage is out of date. Waiting for the runner to refresh it.',
  CREDITS_UNAVAILABLE: "Codex isn't reporting reset credits right now.",
  NO_CREDIT_AVAILABLE: 'No reset credits available.',
};

/** SNAPSHOT_STALE for a block still inside the freshness window, which only `readRequiredAfter` refuses:
 *  it was read before a reset that may have used a credit settled, and no read since has confirmed the
 *  count. "Out of date" beside "Updated 2 min ago" would explain nothing. */
export const CODEX_RESET_UNREFRESHED_SPEND_REASON =
  "The last reset may have used a credit, and usage hasn't refreshed since. Try again once the runner refreshes it.";

/** §6.1's "hide" answers: nothing about reset credits is worth drawing for these. */
export const CODEX_RESET_HIDDEN_REFUSALS: ReadonlySet<CodexRateLimitResetRefusalCode> = new Set([
  'ACCOUNT_OVERRIDE',
  'SNAPSHOT_MISSING',
  'UNSUPPORTED_AUTH',
  'PROVIDER_UNSUPPORTED',
  'ACCOUNT_UNIDENTIFIED',
]);

/**
 * The create route's `readRequiredAfter` for this account, read off the runner's operation list
 * (CodexRateLimitResetRepository.unrefreshedSpendSettledAt): when the latest operation settled, if it is
 * this account's and may have used a credit no refresh confirmed — consumeState UNRESOLVED, or CONFIRMED
 * with refreshState FAILED. The latest is enough: one account's operations run one at a time, each was
 * admitted only on a read later than every such settlement before it, and the stored block never moves
 * back (contract §8). But the list's latest is the runner's, whatever its account: when another account's
 * operation came after this account's last one, an earlier settlement is out of sight, and the create
 * route can still refuse what the card offers (runbook §8 R3).
 */
function unrefreshedSpendSettledAt(
  operations: CodexRateLimitResetOperations | null | undefined,
  accountFingerprint: string,
): string | null {
  const latest = operations?.latest;
  if (!latest || latest.accountFingerprint !== accountFingerprint) return null;
  const unrefreshed =
    latest.consumeState === 'UNRESOLVED' || (latest.consumeState === 'CONFIRMED' && latest.refreshState === 'FAILED');
  return unrefreshed ? latest.completedAt : null;
}

/**
 * The reset card for one runner, or null when there is nothing to show: no block (an older runner),
 * a block that fails the contract, or a support answer the contract hides. The button's state is
 * `codexResetRefusal` over the same inputs the create route reads — the account override is the
 * create route's to judge, since only it knows the workspace's derived provider and env — with the
 * runner's operation list standing in for the rows it reads about earlier resets.
 */
export function codexResetCard(
  runner: CodexResetRunner,
  now: Date,
  activeOperation: boolean,
  operations?: CodexRateLimitResetOperations | null,
): CodexResetCard | null {
  const block = codexRateLimitResetOf(runner.planUsage);
  if (!block || codexRateLimitResetViolations(block).length > 0) return null;
  if (block.support !== 'SUPPORTED' && block.support !== 'CREDITS_UNAVAILABLE') return null;
  const accountFingerprint = block.accountFingerprint;
  if (!isCodexAccountFingerprint(accountFingerprint)) return null;
  const refusal = codexResetRefusal({
    now,
    accountOverride: false,
    activeOperation,
    runnerOnline: runner.online === true,
    runnerCapabilities: runner.capabilities,
    heartbeatLeaseOwner: runner.heartbeatLeaseOwner,
    runnerDraining: runner.heartbeatDraining === true,
    rateLimitReset: block,
    expectedAccountFingerprint: accountFingerprint,
    readRequiredAfter: unrefreshedSpendSettledAt(operations, accountFingerprint),
  });
  return {
    block,
    accountFingerprint,
    details: codexResetCreditDetails(block),
    availability:
      refusal === null
        ? { kind: 'ready' }
        : refusal === 'OPERATION_IN_FLIGHT'
          ? { kind: 'in-flight' }
          : {
              kind: 'blocked',
              code: refusal,
              reason:
                refusal === 'SNAPSHOT_STALE' && codexResetSnapshotFresh(block, now)
                  ? CODEX_RESET_UNREFRESHED_SPEND_REASON
                  : CODEX_RESET_REFUSAL_REASON[refusal],
            },
  };
}

/** The count, from `availableCount` alone: the credit list is detail and may be null or capped. */
export function codexResetCountLabel(details: CodexResetCreditDetails): string {
  return details.availableCount === null ? 'Count unavailable' : `${details.availableCount} available`;
}

export interface CodexResetExpiry {
  label: string;
  /** The instant the label names, for a full-precision tooltip. */
  at: string | null;
}

/**
 * What the listed credits say about expiry — and no more. With no list, a capped list, or a list
 * holding fewer available credits than the count, an unlisted credit may expire sooner or never, so
 * the label says the list is partial instead of stating a date for every credit.
 */
export function codexResetExpiry(
  block: PlanUsageRateLimitReset,
  formatDate: (iso: string) => string,
): CodexResetExpiry | null {
  const summary = block.rateLimitResetCredits;
  if (!summary || summary.availableCount === 0) return null;
  if (summary.credits === null) return { label: 'Expiry not reported', at: null };
  const { details, nextExpiresAt } = codexResetCreditDetails(block);
  const listed = summary.credits.filter((credit) => credit.status === 'available');
  const partial = details === 'TRUNCATED' || listed.length < summary.availableCount;
  if (nextExpiresAt) {
    const date = formatDate(nextExpiresAt);
    if (partial) return { label: `Earliest listed expires ${date} · partial list`, at: nextExpiresAt };
    return { label: summary.availableCount > 1 ? `Next expires ${date}` : `Expires ${date}`, at: nextExpiresAt };
  }
  if (listed.length === 0) return { label: 'Expiry not reported', at: null };
  return { label: partial ? 'Listed credits don’t expire · partial list' : 'Doesn’t expire', at: null };
}

export interface CodexResetFreshness {
  label: string;
  stale: boolean;
}

/** How old the block is, by the read's own start time — the same fetchedAt admission judges. */
export function codexResetFreshness(block: PlanUsageRateLimitReset, now: Date): CodexResetFreshness {
  const at = Date.parse(block.fetchedAt);
  const stale = !codexResetSnapshotFresh(block, now);
  if (at > now.getTime() + CODEX_RATE_LIMIT_RESET_TIMING.snapshotFutureSkewMs) {
    return { label: "Updated at a time ahead of this device's clock", stale };
  }
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  const ago = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
  return { label: stale ? `Updated ${ago} · out of date` : `Updated ${ago}`, stale };
}

export type CodexResetTone = 'progress' | 'success' | 'info' | 'warning' | 'error';

/** Whether a credit was spent, as far as the operation's checkpoints can say. */
export type CodexResetCreditSpent = 'no' | 'not-yet' | 'maybe' | 'yes';

export interface CodexResetStatusCopy {
  tone: CodexResetTone;
  title: string;
  detail: string;
  spent: CodexResetCreditSpent;
}

const RECOVERING: Partial<Record<CodexRateLimitResetResultCode, string>> = {
  PROVIDER_ERROR: 'Codex returned an error',
  PROVIDER_TIMEOUT: 'Codex took too long to answer',
  APP_SERVER_UNAVAILABLE: "The runner couldn't start Codex",
  READ_FAILED: "The runner couldn't read the Codex account",
  ACCOUNT_UNIDENTIFIED: "Codex didn't say which account this is",
  RUNNER_DRAINING: 'The runner is restarting',
};

const ACCOUNT_FAILURES = new Set(['ACCOUNT_CHANGED', 'ACCOUNT_MISMATCH']);

/**
 * What an operation means to the person who confirmed it (§7.3). The one line that must never be
 * blurred: once the consume is CONFIRMED with `reset` or `alreadyRedeemed`, a credit was used —
 * whatever became of the refresh after it.
 */
export function codexResetStatusCopy(
  op: CodexRateLimitResetOperationView,
  context: { runnerOnline: boolean; accountChanged: boolean },
): CodexResetStatusCopy {
  const recovering = op.lastErrorCode ? RECOVERING[op.lastErrorCode] : undefined;
  const already = op.consumeOutcome === 'alreadyRedeemed';
  const used = already
    ? 'Codex had already applied this reset (1 credit, used once)'
    : 'Codex used 1 credit and reset your eligible usage windows';
  switch (op.status) {
    case 'PENDING':
      return {
        tone: 'progress',
        spent: 'not-yet',
        title: 'Starting reset…',
        detail: context.accountChanged
          ? "The runner's Codex account changed, so this reset will stop without using a credit."
          : context.runnerOnline
            ? 'Waiting for the runner to pick this up. No credit has been used yet.'
            : 'Waiting for the runner to come back online. No credit has been used yet.',
      };
    case 'CONSUMING':
      return {
        tone: 'progress',
        spent: 'not-yet',
        title: 'Using reset credit…',
        detail: context.accountChanged
          ? "The runner's Codex account changed. Waiting for the runner to report whether a credit was used."
          : !context.runnerOnline
            ? 'The runner went offline while redeeming. Orbit finishes once it reconnects, reusing the same request, so at most 1 credit is used.'
            : recovering
              ? `${recovering}. Retrying the same request, so at most 1 credit is used.`
              : 'The runner is redeeming 1 credit with Codex.',
      };
    case 'REFRESHING':
      return {
        tone: 'progress',
        spent: 'yes',
        title: already ? 'Reset already applied — refreshing usage…' : 'Limits reset — refreshing usage…',
        detail: context.accountChanged
          ? `${used}. The runner's Codex account changed, so usage may not refresh.`
          : !context.runnerOnline
            ? `${used}. Usage refreshes once the runner reconnects.`
            : recovering
              ? `${used}. ${recovering}; retrying the usage refresh.`
              : `${used}. Waiting for updated usage.`,
      };
    case 'SUCCEEDED':
      return {
        tone: 'success',
        spent: 'yes',
        title: 'Usage limits reset',
        detail: already
          ? 'Codex had already applied this reset, so no extra credit was used. Plan usage has been refreshed.'
          : '1 credit used. Plan usage has been refreshed.',
      };
    case 'REFRESH_FAILED':
      return {
        tone: 'warning',
        spent: 'yes',
        title: 'Limits reset — usage not refreshed',
        detail: `${used}, but Orbit couldn't read the updated usage${
          op.failureCode && ACCOUNT_FAILURES.has(op.failureCode) ? " because the runner's Codex account changed" : ''
        }. The numbers above may be out of date until the runner's next update.`,
      };
    case 'NOTHING_TO_RESET':
      return {
        tone: 'info',
        spent: 'no',
        title: 'Nothing to reset',
        detail: 'None of your Codex usage windows can be reset right now. No credit was used.',
      };
    case 'NO_CREDIT':
      return {
        tone: 'info',
        spent: 'no',
        title: 'No reset credit available',
        detail: 'Codex reports no earned reset credits on this account. No credit was used.',
      };
    case 'NOT_ATTEMPTED':
      if (op.failureCode && ACCOUNT_FAILURES.has(op.failureCode)) {
        return {
          tone: 'warning',
          spent: 'no',
          title: 'Codex account changed',
          detail: 'The runner is signed in to a different Codex account, so nothing was reset. No credit was used.',
        };
      }
      if (op.failureCode === 'CONSUME_EXPIRED') {
        return {
          tone: 'warning',
          spent: 'no',
          title: "Reset didn't start",
          detail: "The runner didn't pick up the request in time. No credit was used.",
        };
      }
      return {
        tone: 'warning',
        spent: 'no',
        title: 'Reset not available',
        detail:
          op.failureCode === 'UNSUPPORTED_AUTH'
            ? 'Reset credits need a ChatGPT sign-in on this runner. No credit was used.'
            : "This runner's Codex can't use reset credits. No credit was used.",
      };
    case 'UNRESOLVED':
      return {
        tone: 'error',
        spent: 'maybe',
        title: 'Result unknown',
        detail: `${
          op.failureCode && ACCOUNT_FAILURES.has(op.failureCode)
            ? "The runner's Codex account changed before Codex confirmed the reset."
            : 'The runner stopped reporting before Codex confirmed the reset.'
        } A credit may have been used — check the count once usage refreshes.`,
      };
  }
}

export function codexResetOperationActive(op: Pick<CodexRateLimitResetOperationView, 'status'>): boolean {
  return CODEX_RATE_LIMIT_RESET_ENUMS.activeOperationStatus.includes(op.status);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const VIEW_FIELDS = Object.keys(CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetOperationView);

/**
 * An operation as the user API sends it, or null when it is not one. The API adds public-id twins
 * (`publicId`, `runnerPublicId`) and a newer server may add fields, so only the contract's own fields
 * are kept — and those are held to the contract, status derivation included.
 */
export function decodeCodexResetOperation(value: unknown): CodexRateLimitResetOperationView | null {
  if (!isObject(value)) return null;
  const view = Object.fromEntries(VIEW_FIELDS.filter((key) => key in value).map((key) => [key, value[key]]));
  return codexResetOperationViewViolations(view).length === 0
    ? (view as unknown as CodexRateLimitResetOperationView)
    : null;
}

export function decodeCodexResetOperations(value: unknown): CodexRateLimitResetOperations | null {
  if (!isObject(value) || !('active' in value) || !('latest' in value)) return null;
  const active = value.active === null ? null : decodeCodexResetOperation(value.active);
  const latest = value.latest === null ? null : decodeCodexResetOperation(value.latest);
  if ((value.active !== null && active === null) || (value.latest !== null && latest === null)) return null;
  return { active, latest };
}

export type CodexResetCreateFailure =
  | { kind: 'refused'; code: CodexRateLimitResetRefusalCode; operationId?: string }
  | { kind: 'rejected'; status: number }
  | { kind: 'unanswered' };

/**
 * What a failed create proves. A 409 refusal and any other 4xx are the server declining before it
 * wrote anything, so this confirmation created nothing. Everything else — no response, a timeout, a
 * 5xx, 408 or 429 — may or may not have landed, and is answered only by sending the same request again.
 */
export function codexResetCreateFailure(error: unknown): CodexResetCreateFailure {
  if (!(error instanceof ApiError)) return { kind: 'unanswered' };
  const code = error.code as CodexRateLimitResetRefusalCode | undefined;
  if (error.status === 409 && code !== undefined && CODEX_RATE_LIMIT_RESET_ENUMS.refusalCode.includes(code)) {
    const operationId = error.body?.operationId;
    return typeof operationId === 'string' && operationId.length > 0
      ? { kind: 'refused', code, operationId }
      : { kind: 'refused', code };
  }
  if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
    return { kind: 'rejected', status: error.status };
  }
  return { kind: 'unanswered' };
}

/**
 * One confirmation, as this browser remembers it until its result has been seen. It carries the
 * clientRequestId minted when the user confirmed — reused by every retry, including one made after
 * a reload — and, once the API has answered, the operation it became. An entry with no
 * clientRequestId follows an operation some other confirmation started.
 */
export interface CodexResetIntent {
  v: 1;
  runnerId: string;
  accountFingerprint: string;
  confirmedAt: string;
  clientRequestId?: string;
  workspaceId?: string;
  operationId?: string;
  settledAt?: string;
}

const INTENT_KEY_PREFIX = 'orbit.codexReset:';

function intentStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const isInstant = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function readCodexResetIntent(runnerId: string): CodexResetIntent | null {
  const store = intentStore();
  if (!store) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(store.getItem(INTENT_KEY_PREFIX + runnerId) ?? 'null');
  } catch {
    raw = undefined;
  }
  if (raw === null) return null;
  const intent = (isObject(raw) ? raw : {}) as Partial<Record<keyof CodexResetIntent, unknown>>;
  const valid =
    intent.v === 1 &&
    intent.runnerId === runnerId &&
    isCodexAccountFingerprint(intent.accountFingerprint) &&
    isInstant(intent.confirmedAt) &&
    (intent.clientRequestId === undefined || isCodexResetUuid(intent.clientRequestId)) &&
    (intent.operationId === undefined || isNonEmpty(intent.operationId)) &&
    (intent.clientRequestId !== undefined || intent.operationId !== undefined) &&
    (intent.workspaceId === undefined || isNonEmpty(intent.workspaceId)) &&
    (intent.settledAt === undefined || (isInstant(intent.settledAt) && intent.operationId !== undefined));
  if (!valid) {
    clearCodexResetIntent(runnerId);
    return null;
  }
  return intent as CodexResetIntent;
}

export function writeCodexResetIntent(intent: CodexResetIntent): void {
  try {
    intentStore()?.setItem(INTENT_KEY_PREFIX + intent.runnerId, JSON.stringify(intent));
  } catch {
    // Private mode or a full quota: the confirmation still runs, it just can't outlive the page.
  }
}

export function clearCodexResetIntent(runnerId: string): void {
  try {
    intentStore()?.removeItem(INTENT_KEY_PREFIX + runnerId);
  } catch {
    // Nothing stored to lose.
  }
}

export type CodexResetResume = 'follow-operation' | 'send-again' | 'look-up' | 'forget';

/**
 * What a page that finds a remembered confirmation does with it. Within the consume deadline an
 * unanswered create is sent again under its own clientRequestId: the API replays it if it landed and
 * creates it exactly once if it did not. Past the deadline, a create that never landed would start a
 * reset nobody is waiting on any more, so the page only looks for the one that may have landed.
 */
export function codexResetResume(intent: CodexResetIntent, now: Date): CodexResetResume {
  const age = (instant: string) => now.getTime() - Date.parse(instant);
  if (intent.settledAt) {
    return age(intent.settledAt) > CODEX_RESET_CLIENT_TIMING.settledIntentTtlMs ? 'forget' : 'follow-operation';
  }
  if (intent.operationId) return 'follow-operation';
  if (!intent.clientRequestId) return 'forget';
  return age(intent.confirmedAt) <= CODEX_RATE_LIMIT_RESET_TIMING.consumeDeadlineMs ? 'send-again' : 'look-up';
}

/** The operation a remembered, unanswered confirmation became, if the runner's list still shows it. */
export function codexResetLookUp(
  intent: CodexResetIntent,
  operations: CodexRateLimitResetOperations,
): CodexRateLimitResetOperationView | null {
  for (const op of [operations.active, operations.latest]) {
    if (op && intent.clientRequestId && op.clientRequestId === intent.clientRequestId) return op;
  }
  return null;
}
