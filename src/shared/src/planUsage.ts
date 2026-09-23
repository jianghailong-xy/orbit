import type { PlanUsage, PlanUsageSnapshot, PlanUsageWindow, RunnerEngineAccount } from './dto';

/** A window counts as exhausted at 100% consumed — the provider stops accepting work. */
const EXHAUSTED_UTILIZATION = 100;

/** The Codex account every runner has: the CODEX_HOME its own environment selects. Every other
 *  account is a slot the runner added, named by its id (RunnerEngineAccount.id). */
export const CODEX_DEFAULT_ACCOUNT = 'default';

/**
 * Every rate-limit window in one snapshot: the named Claude windows, the Codex
 * primary/secondary pair, and the per-bucket windows Codex reports under `rateLimits`.
 */
function windowsOf(snapshot: PlanUsageSnapshot): PlanUsageWindow[] {
  const windows = [
    snapshot.fiveHour,
    snapshot.sevenDay,
    snapshot.sevenDayOpus,
    snapshot.sevenDaySonnet,
    snapshot.primary,
    snapshot.secondary,
    ...(snapshot.rateLimits ?? []).flatMap((bucket) => [bucket.primary, bucket.secondary]),
  ];
  return windows.filter((w): w is PlanUsageWindow => !!w);
}

/**
 * The snapshot describing `provider`'s quota, or undefined when this runner reports none
 * for it. Newer runners nest one snapshot per runtime; older ones report a single flat
 * snapshot that names its own provider. A snapshot is never assumed to cover a provider it
 * does not name — an agent on a BYOK/custom provider slug (which borrows a built-in runtime
 * but bills its own key) must not inherit that runtime's subscription quota.
 */
function snapshotFor(usage: PlanUsage, provider: string): PlanUsageSnapshot | undefined {
  const nested = (usage as Record<string, unknown>)[provider];
  if (nested && typeof nested === 'object') return nested as PlanUsageSnapshot;
  return usage.provider === provider ? usage : undefined;
}

/**
 * One Codex account's own part of a runner's Codex snapshot. Default's is the snapshot's own windows,
 * and is undefined when the snapshot holds nothing of Default's, only other accounts (the runner has
 * not read Default); every other account's is its entry under `accounts`.
 */
export function codexAccountSnapshot(
  snapshot: PlanUsageSnapshot,
  account: string,
): PlanUsageSnapshot | undefined {
  if (account !== CODEX_DEFAULT_ACCOUNT) {
    const others = snapshot.accounts;
    const entry =
      others && typeof others === 'object' && Object.prototype.hasOwnProperty.call(others, account)
        ? others[account]
        : undefined;
    return entry && typeof entry === 'object' ? entry : undefined;
  }
  if (snapshot.accounts === undefined) return snapshot;
  const { accounts: _others, ...own } = snapshot;
  return Object.keys(own).some((key) => key !== 'provider') ? own : undefined;
}

/**
 * The snapshot of `provider`'s quota a run spends. For Codex that is one account's: `account` names
 * it (codexAccountOfEnv) and defaults to Default, the only account there was before accounts; null is
 * a run that spends no account's subscription, which no snapshot describes.
 */
function spentSnapshot(
  usage: PlanUsage,
  provider: string,
  account: string | null | undefined,
): PlanUsageSnapshot | undefined {
  const snapshot = snapshotFor(usage, provider);
  if (!snapshot || provider !== 'codex') return snapshot;
  return account === null ? undefined : codexAccountSnapshot(snapshot, account ?? CODEX_DEFAULT_ACCOUNT);
}

/** `path` with `.`, `..`, repeated and trailing separators resolved away; null unless absolute. */
function cleanAbsolutePath(path: string): string | null {
  if (!path.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}

/**
 * Which of a runner's Codex accounts a session spends, from the env it runs with (the workspace env
 * dispatch hands the runner) and the accounts that runner reports, resolved the way the runner
 * resolves it (codexSessionAccountSlot, src/runner-go/codex_state.go): no CODEX_HOME is Default, and a
 * CODEX_HOME — set, or moved by HOME — is the account living there. null when the session spends no
 * account's subscription this runner reports: a CODEX_API_KEY or OPENAI_* of its own (the variables
 * codexResetAccountOverride counts), or a CODEX_HOME none of its accounts lives in.
 */
export function codexAccountOfEnv(
  env: Readonly<Record<string, unknown>> | null | undefined,
  accounts: readonly RunnerEngineAccount[] | null | undefined,
): string | null {
  const vars = env ?? {};
  const set = (key: string) => {
    const value = vars[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  if (Object.keys(vars).some((key) => (key === 'CODEX_API_KEY' || key.startsWith('OPENAI_')) && set(key))) {
    return null;
  }
  const home = set('HOME');
  const codexHome = set('CODEX_HOME') ?? (home === undefined ? undefined : `${home}/.codex`);
  if (codexHome === undefined) return CODEX_DEFAULT_ACCOUNT;
  const where = cleanAbsolutePath(codexHome);
  if (where === null) return null;
  return (accounts ?? []).find((account) => cleanAbsolutePath(account.codexHome) === where)?.id ?? null;
}

/**
 * Does this runner report `provider`'s quota at all? This is the question
 * {@link planUsageBlockedUntil} cannot answer, because it collapses two very different
 * situations into the same `null`: "the quota is reported and demonstrably fine" and "there
 * is no quota data here to judge by".
 *
 * That distinction matters to anything holding work back after a usage-limit failure. With a
 * readable snapshot, a null verdict is positive knowledge — the window has reset, so work
 * should resume at once. With no snapshot the caller is blind, and resuming immediately is
 * what turns a multi-day quota outage into a once-a-minute respawn loop.
 *
 * For Codex the question is about one account, `account`: the one the run spends
 * (codexAccountOfEnv), Default when omitted, and null for a run spending no account's
 * subscription — about which this runner reports nothing.
 */
export function planUsageReported(
  usage: PlanUsage | null | undefined,
  provider: string,
  account?: string | null,
): boolean {
  if (!usage) return false;
  return spentSnapshot(usage, provider, account) !== undefined;
}

/**
 * When does `provider`'s quota on this runner free up again, if it is exhausted right now?
 * Returns the latest reset among the exhausted windows (all of them must clear before work
 * can resume), or null when nothing is exhausted, the provider isn't covered by this
 * snapshot, or no reset time was reported.
 *
 * Callers use this to avoid starting work that is certain to fail: a run dispatched against
 * an exhausted quota dies immediately with the provider's "usage limit" error, so retrying
 * before `resetsAt` only burns sessions. Requiring a *reported* reset time is deliberate —
 * without one there is no defensible moment to resume, so the caller's normal failure
 * backoff should handle it rather than this returning an indefinite block.
 *
 * The runner refreshes its snapshot shortly after a reset passes, so a stale-but-future
 * `resetsAt` is self-correcting; a past one is simply ignored here.
 *
 * A Codex runner can hold several accounts, each with its own quota, so what is judged is the
 * account the run will spend (`account`, as for {@link planUsageReported}): Default's exhausted
 * windows hold back a run on Default, never one on another account.
 */
export function planUsageBlockedUntil(
  usage: PlanUsage | null | undefined,
  provider: string,
  now: Date,
  account?: string | null,
): Date | null {
  if (!usage) return null;
  const snapshot = spentSnapshot(usage, provider, account);
  if (!snapshot) return null;
  let latest: number | null = null;
  for (const window of windowsOf(snapshot)) {
    if (window.utilization < EXHAUSTED_UTILIZATION) continue;
    if (!window.resetsAt) continue;
    const resetsAt = Date.parse(window.resetsAt);
    if (Number.isNaN(resetsAt) || resetsAt <= now.getTime()) continue;
    if (latest === null || resetsAt > latest) latest = resetsAt;
  }
  return latest === null ? null : new Date(latest);
}
