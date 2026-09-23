import type {
  LoginEngine,
  ReportedEngine,
  RunnerEngineAccount,
  RunnerEngineHealth,
  RunnerEngineUpdate,
} from '@orbit/shared';
import { CODEX_ACCOUNT_PATTERN } from '../runners/dto';

/** The engines a runner can sign into (LoginEngine's full set), in the order they're shown. */
export const LOGIN_ENGINES: readonly LoginEngine[] = ['claude', 'codex', 'kimi'];

export function isLoginEngine(value: unknown): value is LoginEngine {
  return typeof value === 'string' && LOGIN_ENGINES.includes(value as LoginEngine);
}

/**
 * Every engine a runner reports health for, in the order they're shown.
 *
 * Wider than LOGIN_ENGINES on purpose: OpenCode can't be signed into from the browser, but it is
 * installed on the machine and updated by the same daily pass. Filtering it out here is what used
 * to make the runner's own update summary mention an engine the control plane had no record of.
 * Sign-in stays gated on isLoginEngine, where that question actually belongs.
 */
export const REPORTED_ENGINES: readonly ReportedEngine[] = [...LOGIN_ENGINES, 'opencode'];

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
    const version =
      typeof entry.version === 'string' && entry.version.trim()
        ? entry.version.trim().slice(0, 120)
        : undefined;
    const update = sanitizeEngineUpdate(entry.update);
    // Only Codex signs in more than one account on a machine.
    const accounts = entry.engine === 'codex' ? sanitizeEngineAccounts(entry.accounts) : undefined;
    byEngine.set(entry.engine, {
      engine: entry.engine,
      installed: entry.installed === true,
      ...(version ? { version } : {}),
      // Only the CLI's own yes/no counts; everything else is the third state, which exists so
      // an engine that wouldn't answer is never shown as signed in.
      auth: entry.auth === 'yes' || entry.auth === 'no' ? entry.auth : 'unknown',
      ...(update ? { update } : {}),
      ...(accounts ? { accounts } : {}),
    });
  }
  if (!byEngine.size) return null;
  return REPORTED_ENGINES.map((engine) => byEngine.get(engine)).filter(
    (entry): entry is RunnerEngineHealth => !!entry,
  );
}

/** How many Codex accounts one report may carry. Each is a sign-in somebody made by hand, so a
 *  real machine sits far below this: what it bounds is a runaway report, not a user. */
export const ENGINE_ACCOUNTS_MAX = 16;
/** StartLoginDto's limit on a new account's name, the way a name reaches a runner from here. */
const ACCOUNT_NAME_MAX = 60;
/** A CODEX_HOME is shown, not followed; this is room for any real home directory, not a log line. */
const ACCOUNT_PATH_MAX = 400;
/** `cxa1_` and 8 hex digits: the start of the fingerprint the rate-limit reset reports. */
const FINGERPRINT_PREFIX = /^cxa1_[0-9a-f]{8}$/;

/**
 * Normalize the Codex accounts one engine report lists.
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
    if (typeof entry.id !== 'string' || !CODEX_ACCOUNT_PATTERN.test(entry.id) || seen.has(entry.id)) {
      continue;
    }
    const auth = entry.auth;
    if (auth !== 'yes' && auth !== 'no' && auth !== 'unknown') continue;
    const codexHome =
      typeof entry.codexHome === 'string' ? entry.codexHome.trim().slice(0, ACCOUNT_PATH_MAX) : '';
    if (!codexHome) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, ACCOUNT_NAME_MAX) : '';
    const fingerprintPrefix =
      typeof entry.fingerprintPrefix === 'string' && FINGERPRINT_PREFIX.test(entry.fingerprintPrefix)
        ? entry.fingerprintPrefix
        : undefined;
    seen.add(entry.id);
    out.push({
      id: entry.id,
      ...(name ? { name } : {}),
      codexHome,
      auth,
      ...(fingerprintPrefix ? { fingerprintPrefix } : {}),
    });
  }
  return out.length ? out : undefined;
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
