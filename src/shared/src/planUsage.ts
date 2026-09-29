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
 * The snapshot of `provider`'s quota a run spends. For an engine whose CLI keeps a login per
 * directory — Codex, Claude — that is one account's: `account` names it (accountOfEnv) and defaults to
 * Default, the only account there was before accounts; null is a run that spends no account's
 * subscription, which no snapshot describes. Both engines' runners report their other accounts the
 * same way, under the snapshot's `accounts` (codexAccountSnapshot).
 */
function spentSnapshot(
  usage: PlanUsage,
  provider: string,
  account: string | null | undefined,
): PlanUsageSnapshot | undefined {
  const snapshot = snapshotFor(usage, provider);
  if (!snapshot || (provider !== 'codex' && provider !== 'claude')) return snapshot;
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

/** The directory one account lives in, under whichever name its report carries it (home, or the
 *  codex-named field an older runner sends). */
export function accountDir(account: RunnerEngineAccount): string {
  return account.home ?? account.codexHome ?? '';
}

/** The variables that mean a run brings a credential of its own rather than spending a login the
 *  machine holds, per engine. Read where the run is judged: such a run spends no account's
 *  subscription, so no account's quota holds it back. */
const OWN_CREDENTIAL_KEYS: Partial<Record<string, readonly string[]>> = {
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
};

/** The directory an engine's own login lives in when the run names none: what its CLI resolves
 *  (CODEX_HOME else ~/.codex; CLAUDE_CONFIG_DIR else ~/.claude). */
const ENGINE_DEFAULT_DIR: Partial<Record<string, (home: string | undefined) => string | undefined>> = {
  codex: (home) => (home === undefined ? undefined : `${home}/.codex`),
  claude: (home) => (home === undefined ? undefined : `${home}/.claude`),
};

/**
 * Which of a runner's accounts a session spends, from the env it runs with (the workspace env
 * dispatch hands the runner) and the accounts that runner reports — resolved the way the runner
 * resolves it: no config-directory variable is Default, and one that is set (or moved by HOME) is
 * the account living there. Engines that keep no login per directory have no account to name, and
 * answer null.
 *
 * null means the session spends no account's subscription this runner reports: a credential of its
 * own (OWN_CREDENTIAL_KEYS — what the runner's hasInjectedCredentials reads), or a directory none
 * of its accounts lives in.
 */
export function accountOfEnv(
  provider: string | null | undefined,
  env: Readonly<Record<string, unknown>> | null | undefined,
  accounts: readonly RunnerEngineAccount[] | null | undefined,
): string | null {
  const vars = env ?? {};
  const set = (key: string) => {
    const value = vars[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  const own = OWN_CREDENTIAL_KEYS[provider ?? ''];
  const defaultDir = ENGINE_DEFAULT_DIR[provider ?? ''];
  if (!own || !defaultDir) return null;
  if (Object.keys(vars).some((key) => own.includes(key) && set(key))) return null;
  const varName = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const dir = set(varName) ?? defaultDir(set('HOME'));
  if (dir === undefined) return CODEX_DEFAULT_ACCOUNT;
  const where = cleanAbsolutePath(dir);
  if (where === null) return null;
  return (accounts ?? []).find((account) => cleanAbsolutePath(accountDir(account)) === where)?.id ?? null;
}

/**
 * Which of a runner's Codex accounts a session spends (accountOfEnv). The runner resolves it the
 * same way (codexSessionAccountSlot, src/runner-go/codex_state.go).
 */
export function codexAccountOfEnv(
  env: Readonly<Record<string, unknown>> | null | undefined,
  accounts: readonly RunnerEngineAccount[] | null | undefined,
): string | null {
  return accountOfEnv('codex', env, accounts);
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
 * For Codex and Claude the question is about one account, `account`: the one the run spends
 * (accountOfEnv), Default when omitted, and null for a run spending no account's subscription —
 * about which this runner reports nothing.
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
 * A runner can hold several Codex or Claude accounts, each with its own quota, so what is judged is
 * the account the run will spend (`account`, as for {@link planUsageReported}): Default's exhausted
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

/** The engines whose CLI keeps a login per directory — a CODEX_HOME, a CLAUDE_CONFIG_DIR — so that a
 *  runner can hold several accounts of them, each with its own quota. */
export type AccountEngine = 'codex' | 'claude';

/**
 * Which of a runner's accounts of `engine` a new session starts on when neither it nor its workspace
 * picked one: the one with the most room right now. The server makes this choice once, when the
 * session is created, and stores it on the session; the New Session screen asks the same question to
 * say where a session would start.
 *
 * - Only an account the CLI does not say is signed out is a candidate.
 * - One with a spent window — at 100% and not past its reset, or with no reset time to go by — is
 *   passed over while another can run.
 * - Among the rest, the most room is the least used of each account's tightest window: accounts report
 *   different windows (a Plus login a 5-hour and a weekly one, a Pro login only a weekly one), and the
 *   one closest to its limit is the one that stops it. An account with nothing reported ranks after
 *   every account with a reading, since unread is not the same as unused.
 * - Every candidate spent: the one that frees up first, where the session's run then waits.
 * - Ties go to Default, then to the lower id, so the answer never depends on the order of the report.
 *
 * Null when there is nothing to choose between — fewer than two accounts reported, or none signed in —
 * and the session runs where it always did.
 */
export function roomiestAccount(
  engine: AccountEngine,
  accounts: readonly RunnerEngineAccount[] | null | undefined,
  usage: PlanUsage | null | undefined,
  now: Date,
): string | null {
  if (!accounts || accounts.length < 2) return null;
  const candidates = rankAccounts(engine, accounts, usage, now);
  const usable = candidates.filter((c) => c.spentUntil === null);
  if (usable.length > 0) return usable[0].id;
  const first = [...candidates].sort((a, b) => (a.spentUntil ?? 0) - (b.spentUntil ?? 0) || byAccountId(a, b))[0];
  return first?.id ?? null;
}

/** {@link roomiestAccount} for Codex: its thread lives in the chosen account's CODEX_HOME. */
export function roomiestCodexAccount(
  accounts: readonly RunnerEngineAccount[] | null | undefined,
  usage: PlanUsage | null | undefined,
  now: Date,
): string | null {
  return roomiestAccount('codex', accounts, usage, now);
}

/**
 * Which of a runner's accounts of `engine` a session whose own account (`from`) just hit its usage
 * limit can move to, between turns: another account that can run now — not signed out, no spent
 * window — the one with the most room, ranked as {@link roomiestAccount} ranks. Never a spent one: when
 * no other account has room, moving gains nothing, and the session waits for its own account's reset.
 * Null then, and for a runner with no second account.
 */
export function accountToMoveTo(
  engine: AccountEngine,
  accounts: readonly RunnerEngineAccount[] | null | undefined,
  usage: PlanUsage | null | undefined,
  now: Date,
  from: string,
): string | null {
  if (!accounts || accounts.length < 2) return null;
  return (
    rankAccounts(engine, accounts, usage, now).find((c) => c.id !== from && c.spentUntil === null)?.id ?? null
  );
}

/** {@link accountToMoveTo} for Codex. */
export function codexAccountToMoveTo(
  accounts: readonly RunnerEngineAccount[] | null | undefined,
  usage: PlanUsage | null | undefined,
  now: Date,
  from: string,
): string | null {
  return accountToMoveTo('codex', accounts, usage, now, from);
}

/** Ties go to Default, then to the lower id, so no answer depends on the order of the report. */
const byAccountId = (a: { id: string }, b: { id: string }) =>
  Number(b.id === CODEX_DEFAULT_ACCOUNT) - Number(a.id === CODEX_DEFAULT_ACCOUNT) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The accounts that are candidates at all — the CLI does not say they are signed out — most room
 * first: least-used tightest window, unread after read. `spentUntil` is set for one with a spent window
 * (100% and not past its reset, or with no reset to go by): the latest of those resets, Infinity when
 * one named none.
 */
function rankAccounts(
  engine: AccountEngine,
  accounts: readonly RunnerEngineAccount[],
  usage: PlanUsage | null | undefined,
  now: Date,
): Array<{ id: string; tightest: number; spentUntil: number | null }> {
  const reported = usage ? snapshotFor(usage, engine) : undefined;
  return accounts
    .filter((account) => account.auth !== 'no')
    .map((account) => {
      const snapshot = reported ? codexAccountSnapshot(reported, account.id) : undefined;
      const windows = snapshot ? windowsOf(snapshot) : [];
      const spent = windows.filter(
        (w) => w.utilization >= EXHAUSTED_UTILIZATION && !(Date.parse(w.resetsAt ?? '') <= now.getTime()),
      );
      const resets = spent.map((w) => Date.parse(w.resetsAt ?? ''));
      return {
        id: account.id,
        tightest: windows.length > 0 ? Math.max(...windows.map((w) => w.utilization)) : Number.POSITIVE_INFINITY,
        spentUntil: spent.length === 0 ? null : resets.some(Number.isNaN) ? Number.POSITIVE_INFINITY : Math.max(...resets),
      };
    })
    // Two accounts with no reading subtract to NaN, which falls through to the id like any other tie.
    .sort((a, b) => a.tightest - b.tightest || byAccountId(a, b));
}
