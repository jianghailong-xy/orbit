import {
  AgentProvider,
  type InstallEngine,
  type LoginEngine,
  type PlanUsageBucket,
  type PlanUsageSnapshot,
  type ReportedEngine,
  type RunnerEngineAccount,
  type RunnerEngineHealth,
  type RunnerEngineUpdate,
  type DshRuntimeHealth,
} from '@orbit/shared';
import { ACCOUNT_ID_PATTERN } from '../runners/dto';
import { runnerAccountPausedUntil } from './account-pause';

/**
 * The engines a runner can sign into (LoginEngine's full set), in the order they're shown. Only a
 * runner that can relay Antigravity's Google sign-in is asked to (antigravityGoogleLogin).
 */
export const LOGIN_ENGINES: readonly LoginEngine[] = ['claude', 'codex', 'kimi', 'antigravity'];

/**
 * The engines whose CLI keeps one login per config directory, so one machine can sign in several
 * accounts of them: a Codex CODEX_HOME, a Claude Code CLAUDE_CONFIG_DIR, an Antigravity Google
 * sign-in's Gemini directory. Everything account-shaped — a per-account sign-in, the account list on a
 * report, a workspace pinning a session to one — is gated on this rather than on the engine name, so
 * the next engine is a line here and a descriptor on the runner (src/runner-go/account_slot.go).
 */
export const ACCOUNT_ENGINES: readonly LoginEngine[] = ['claude', 'codex', 'antigravity'];

export function engineKeepsAccounts(engine: unknown): engine is LoginEngine {
  return typeof engine === 'string' && ACCOUNT_ENGINES.includes(engine as LoginEngine);
}

export function isLoginEngine(value: unknown): value is LoginEngine {
  return typeof value === 'string' && LOGIN_ENGINES.includes(value as LoginEngine);
}

export function isInstallEngine(value: unknown): value is InstallEngine {
  return isLoginEngine(value) || value === 'dsh' || value === 'opencode';
}

/**
 * Every engine a runner reports health for, in the order they're shown — Antigravity still last,
 * where it was listed before it could be signed into.
 *
 * Wider than LOGIN_ENGINES on purpose: OpenCode can't be signed into from the browser, but it is
 * installed on the machine and updated by the same periodic pass. Filtering it out here is what
 * used to make the runner's own update summary mention an engine the control plane had no record
 * of. Sign-in stays gated on isLoginEngine, where that question actually belongs.
 */
export const REPORTED_ENGINES: readonly ReportedEngine[] = [
  'claude',
  'codex',
  'kimi',
  'opencode',
  'antigravity',
  'dsh',
];

export function isReportedEngine(value: unknown): value is ReportedEngine {
  return typeof value === 'string' && REPORTED_ENGINES.includes(value as ReportedEngine);
}

/**
 * Normalize the per-engine health a runner reported.
 *
 * Heartbeat JSON is stored as sent, so every read has to survive a partial report or a runner
 * that sent something unexpected. Unrecognizable entries are dropped rather than repaired: a
 * half-parsed one would render as a confident claim about someone else's machine. Returns null
 * when nothing usable is there — which the UI shows as "not reported", not as "nothing installed".
 */
export function sanitizeRunnerEngines(value: unknown): RunnerEngineHealth[] | null {
  if (!Array.isArray(value)) return null;
  const byEngine = new Map<ReportedEngine, RunnerEngineHealth>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (!isReportedEngine(entry.engine) || byEngine.has(entry.engine)) continue;
    const rawVersion =
      typeof entry.version === 'string' && entry.version.trim()
        ? entry.version.trim().slice(0, 120)
        : undefined;
    const version = entry.engine === 'dsh' && rawVersion && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawVersion)
      ? undefined : rawVersion;
    const update = sanitizeEngineUpdate(entry.update);
    // Only the engines whose CLI keeps a login per directory sign in more than one account.
    const accounts = engineKeepsAccounts(entry.engine)
      ? sanitizeEngineAccounts(entry.accounts)
      : undefined;
    // Only the CLI's own yes/no counts; everything else is the third state, which exists so
    // an engine that wouldn't answer is never shown as signed in.
    const auth = entry.engine !== 'dsh' && (entry.auth === 'yes' || entry.auth === 'no') ? entry.auth : 'unknown';
    const dsh = entry.engine === 'dsh' ? sanitizeDshHealth(entry.dsh) : undefined;
    const installationError = entry.engine === 'dsh' ? dshDiagnosticCode(entry.installationError) : undefined;
    // Antigravity alone says which credential `auth` is about, and carries the quota its Google
    // accounts read (docs/antigravity-runtime-contract.md §16.6): Default's while the runner's own
    // sign-in answers yes, every other account's under `accounts`.
    const authSource =
      entry.engine === 'antigravity' && (entry.authSource === 'google' || entry.authSource === 'env_key')
        ? entry.authSource
        : undefined;
    const planUsage = entry.engine === 'antigravity'
      ? sanitizeGooglePlanUsage(entry.planUsage, authSource === 'google' && auth === 'yes')
      : undefined;
    byEngine.set(entry.engine, {
      engine: entry.engine,
      installed: entry.installed === true,
      ...(version ? { version } : {}),
      auth,
      ...(update ? { update } : {}),
      ...(accounts ? { accounts } : {}),
      ...(authSource ? { authSource } : {}),
      ...(planUsage ? { planUsage } : {}),
      ...(dsh ? { dsh } : {}),
      ...(installationError ? { installationError } : {}),
    });
  }
  if (!byEngine.size) return null;
  return REPORTED_ENGINES.map((engine) => byEngine.get(engine)).filter(
    (entry): entry is RunnerEngineHealth => !!entry,
  );
}

const DSH_DIAGNOSTIC_CODES = [
  'DSH_CREDENTIAL_MISSING', 'DSH_CREDENTIAL_INVALID', 'DSH_REQUEST_FAILED',
  'DSH_SANDBOX_UNAVAILABLE', 'DSH_CATALOG_STARTUP_FAILED', 'DSH_VERSION_INCOMPATIBLE',
  'DSH_PLATFORM_UNSUPPORTED', 'DSH_NODE_UNSUPPORTED', 'DSH_NOT_INSTALLED', 'DSH_INSTALL_FAILED',
];

function dshDiagnosticCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.split(':', 1)[0];
  return DSH_DIAGNOSTIC_CODES.includes(code) ? code : undefined;
}

function sanitizeDshHealth(value: unknown): DshRuntimeHealth | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const requestValidation = raw.requestValidation === 'valid' || raw.requestValidation === 'invalid'
    ? raw.requestValidation : 'unknown';
  const sandboxEnforcement = raw.sandboxEnforcement === 'full' || raw.sandboxEnforcement === 'partial' || raw.sandboxEnforcement === 'unavailable'
    ? raw.sandboxEnforcement : 'unknown';
  const diagnostic = dshDiagnosticCode(raw.diagnostic);
  return {
    versionCompatible: raw.versionCompatible === true,
    credentialPresent: raw.credentialPresent === true,
    modelCatalogReadable: raw.modelCatalogReadable === true,
    requestValidation,
    sandboxEnforcement,
    ...(diagnostic ? { diagnostic } : {}),
  };
}

/** How many accounts one report may carry. Each is a sign-in somebody made by hand, so a real
 *  machine sits far below this: what it bounds is a runaway report, not a user. */
export const ENGINE_ACCOUNTS_MAX = 16;
/** StartLoginDto's limit on a new account's name, the way a name reaches a runner from here — and
 *  RenameAccountDto's, the way one reaches `runner.account_names`. */
const ACCOUNT_NAME_MAX = 60;
/** A config directory is shown, not followed; this is room for any real home directory, not a log
 *  line. */
const ACCOUNT_PATH_MAX = 400;
/** `cxa1_` and 8 hex digits: the start of the fingerprint the rate-limit reset reports. */
const FINGERPRINT_PREFIX = /^cxa1_[0-9a-f]{8}$/;
/** How many quota buckets one report may carry. agy 1.2.16 reports four — a weekly and a 5-hour
 *  limit for each of two model groups — so this bounds a runaway report, not an account. */
export const PLAN_USAGE_BUCKETS_MAX = 16;
/** A bucket's id and window are agy's own lowercase identifiers (`gemini-weekly`, `3p-5h`, `5h`),
 *  never prose: one that isn't shaped like that is not a bucket this was built to read. Dropping it
 *  is also what keeps an address or a token from riding in on one — an email has its `@`, a refresh
 *  token its `/`, and an access token or a JWT its capitals. */
const BUCKET_LABEL = /^[a-z0-9][a-z0-9._-]{0,47}$/;

/** An account a runner added: 4 random bytes in lowercase hex (src/runner-go/account_slot.go). Default
 *  is no entry of a snapshot's `accounts`: its buckets are the snapshot's own. */
const ADDED_ACCOUNT_ID = /^[0-9a-f]{8}$/;

/**
 * Normalize the quota an Antigravity engine reported, the way an account is normalized: rebuilt from
 * the four fields of each bucket the contract names, so nothing else the report carried — an email,
 * a token, agy's descriptions — is stored or served. Default's buckets are kept only when `own` (the
 * runner's own sign-in answered yes); every other account's under `accounts`, by the id of an account
 * the runner added, at most ENGINE_ACCOUNTS_MAX of them. A bucket that can't be read is dropped whole
 * rather than repaired; with none left anywhere there is no quota to show, and the engine's row reads
 * as one that has not reported any.
 */
function sanitizeGooglePlanUsage(value: unknown, own: boolean): PlanUsageSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const buckets = own ? sanitizeBuckets(raw.buckets) : [];
  const accounts: Record<string, PlanUsageSnapshot> = {};
  let kept = 0;
  const reported = raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)
    ? Object.entries(raw.accounts as Record<string, unknown>) : [];
  for (const [id, entry] of reported) {
    if (kept === ENGINE_ACCOUNTS_MAX) break;
    if (!ADDED_ACCOUNT_ID.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const theirs = sanitizeBuckets((entry as Record<string, unknown>).buckets);
    if (!theirs.length) continue;
    const fetchedAt = isoOrUndefined((entry as Record<string, unknown>).fetchedAt);
    accounts[id] = { provider: AgentProvider.ANTIGRAVITY, ...(fetchedAt ? { fetchedAt } : {}), buckets: theirs };
    kept += 1;
  }
  if (!buckets.length && !kept) return undefined;
  const fetchedAt = buckets.length ? isoOrUndefined(raw.fetchedAt) : undefined;
  return {
    provider: AgentProvider.ANTIGRAVITY,
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(buckets.length ? { buckets } : {}),
    ...(kept ? { accounts } : {}),
  };
}

/** The buckets of one Antigravity snapshot, each rebuilt from the four fields the contract names. */
function sanitizeBuckets(value: unknown): PlanUsageBucket[] {
  if (!Array.isArray(value)) return [];
  const buckets: PlanUsageBucket[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (buckets.length === PLAN_USAGE_BUCKETS_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const bucket = item as Record<string, unknown>;
    const { id, window, remainingFraction } = bucket;
    if (typeof id !== 'string' || !BUCKET_LABEL.test(id) || seen.has(id)) continue;
    if (typeof window !== 'string' || !BUCKET_LABEL.test(window)) continue;
    // What is LEFT, as agy reports it: zero is a spent bucket, not a missing one.
    if (typeof remainingFraction !== 'number' || !(remainingFraction >= 0 && remainingFraction <= 1)) continue;
    const resetTime = isoOrUndefined(bucket.resetTime);
    seen.add(id);
    buckets.push({ id, window, remainingFraction, ...(resetTime ? { resetTime } : {}) });
  }
  return buckets;
}

/**
 * Normalize the accounts one engine report lists.
 *
 * The rule of the report around it: an account that can't be read is dropped whole, never
 * repaired — a half-read one would put a confident sign-in state on the row of somebody's account.
 * So unlike the engine's own `auth`, an account's is not rounded to `unknown`: an entry that doesn't
 * say which of the three states it is in is not a report about an account. The fingerprint prefix
 * is dropped on its own, like an engine's update record: it only labels the row, and whatever sits
 * there when it isn't one could be the raw account id that never leaves the machine (contract §3).
 * Returns undefined when nothing usable is left, which reads as the one account a runner had
 * before accounts.
 */
function sanitizeEngineAccounts(value: unknown): RunnerEngineAccount[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: RunnerEngineAccount[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length === ENGINE_ACCOUNTS_MAX) break;
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    // A second report for the same account loses to the first, as a second engine report does.
    if (typeof entry.id !== 'string' || !ACCOUNT_ID_PATTERN.test(entry.id) || seen.has(entry.id)) {
      continue;
    }
    const auth = entry.auth;
    if (auth !== 'yes' && auth !== 'no' && auth !== 'unknown') continue;
    // `home` is the engine-neutral name a current runner sends; `codexHome` is what a runner
    // older than it sends, and what a Codex account still carries alongside.
    const raw_home = typeof entry.home === 'string' ? entry.home : entry.codexHome;
    const home = typeof raw_home === 'string' ? raw_home.trim().slice(0, ACCOUNT_PATH_MAX) : '';
    if (!home) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, ACCOUNT_NAME_MAX) : '';
    const fingerprintPrefix =
      typeof entry.fingerprintPrefix === 'string' && FINGERPRINT_PREFIX.test(entry.fingerprintPrefix)
        ? entry.fingerprintPrefix
        : undefined;
    seen.add(entry.id);
    // A Codex account keeps reporting its directory under the codex-named field as well, so a
    // reader older than `home` still sees it.
    const codexHome =
      typeof entry.codexHome === 'string' ? entry.codexHome.trim().slice(0, ACCOUNT_PATH_MAX) : '';
    // When a signed-in account's login lapses (src/runner-go claudeLoginExpiry): only a real instant,
    // re-written as ISO, so nothing but a time rides on it.
    const loginExpiresAt = auth === 'yes' ? isoInstant(entry.loginExpiresAt) : undefined;
    out.push({
      id: entry.id,
      ...(name ? { name } : {}),
      home,
      ...(codexHome ? { codexHome } : {}),
      auth,
      ...(fingerprintPrefix ? { fingerprintPrefix } : {}),
      ...(loginExpiresAt ? { loginExpiresAt } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** An instant a runner reported (RFC 3339), as ISO 8601 — or undefined for anything that isn't one. */
function isoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The names the user gave a runner's accounts in Orbit, by engine and then account id. */
export type AccountNames = Partial<Record<LoginEngine, Record<string, string>>>;

/**
 * Read `runner.account_names` (which RunnersService.renameAccount writes) the way a report is read:
 * an engine that keeps accounts, an id an account can have, a name renameAccount could have written.
 * Anything else is dropped rather than shown.
 */
export function sanitizeAccountNames(value: unknown): AccountNames {
  const out: AccountNames = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [engine, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!engineKeepsAccounts(engine) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const names: Record<string, string> = {};
    for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
      if (!ACCOUNT_ID_PATTERN.test(id) || typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (trimmed && trimmed.length <= ACCOUNT_NAME_MAX) names[id] = trimmed;
    }
    if (Object.keys(names).length) out[engine] = names;
  }
  return out;
}

/**
 * A runner's engines as everything that NAMES an account has to read them: the report
 * (sanitizeRunnerEngines) with the name the user gave each account in Orbit laid over the one the
 * machine reports. Default is never named by the machine, so this is the only name it can have.
 *
 * `accountNames` is required on purpose: a select that forgets the column would otherwise compile, and
 * name every account the way the runner does whatever it was renamed to.
 */
export function namedRunnerEngines(runner: { engines: unknown; accountNames: unknown; accountPauses?: unknown }): RunnerEngineHealth[] | null {
  const engines = sanitizeRunnerEngines(runner.engines);
  const names = sanitizeAccountNames(runner.accountNames);
  if (!engines) return engines;
  return engines.map((entry) => {
    const own = engineKeepsAccounts(entry.engine) ? names[entry.engine] : undefined;
    if (!entry.accounts) return entry;
    return {
      ...entry,
      accounts: entry.accounts.map((account) => {
        const pausedUntil = runnerAccountPausedUntil(runner.accountPauses, entry.engine, account.id);
        return {
          ...account,
          ...(own?.[account.id] ? { name: own[account.id] } : {}),
          ...(pausedUntil ? { pausedUntil: pausedUntil.toISOString() } : {}),
        };
      }),
    };
  });
}

/** How long a message from the runner may be. Long enough for an installer's last words plus the
 *  path it choked on; short enough that a runaway log line can't be stored as one. */
const UPDATE_MESSAGE_MAX = 400;

/**
 * Normalize one engine's update record.
 *
 * Dropped whole rather than repaired when anything essential is off: this drives a claim about
 * whether a machine is being kept current, and a half-read one would be shown with the same
 * confidence as a real answer. Absent is a state the UI already handles — "not reported yet".
 */
function sanitizeEngineUpdate(value: unknown): RunnerEngineUpdate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  // `ok` is accepted for as long as runners predating the updated/checked split are still
  // reporting — dropping it would blank the update column on every machine that hasn't picked up
  // the new binary yet, which reads as "Orbit stopped updating this" rather than "not yet known".
  if (status !== 'updated' && status !== 'checked' && status !== 'failed' && status !== 'skipped' && status !== 'ok') {
    return undefined;
  }
  const at = isoOrUndefined(raw.at);
  // Without a time this can't be aged, and "updated at some point" is not worth a line.
  if (!at) return undefined;
  const okAt = isoOrUndefined(raw.okAt);
  const updatedAt = isoOrUndefined(raw.updatedAt);
  const behindSince = isoOrUndefined(raw.behindSince);
  const latest =
    typeof raw.latest === 'string' && raw.latest.trim() ? raw.latest.trim().slice(0, 120) : undefined;
  const message =
    typeof raw.message === 'string' && raw.message.trim()
      ? raw.message.trim().slice(0, UPDATE_MESSAGE_MAX)
      : undefined;
  return {
    status,
    at,
    ...(okAt ? { okAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(latest ? { latest } : {}),
    ...(behindSince ? { behindSince } : {}),
    ...(message ? { message } : {}),
  };
}

/** A timestamp is only useful here if it parses; anything else would render as "Invalid Date ago". */
function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
