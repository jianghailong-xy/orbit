import type {
  LoginEngine,
  ReportedEngine,
  RunnerEngineHealth,
  RunnerEngineUpdate,
} from '@orbit/shared';

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
    byEngine.set(entry.engine, {
      engine: entry.engine,
      installed: entry.installed === true,
      ...(version ? { version } : {}),
      // Only the CLI's own yes/no counts; everything else is the third state, which exists so
      // an engine that wouldn't answer is never shown as signed in.
      auth: entry.auth === 'yes' || entry.auth === 'no' ? entry.auth : 'unknown',
      ...(update ? { update } : {}),
    });
  }
  if (!byEngine.size) return null;
  return REPORTED_ENGINES.map((engine) => byEngine.get(engine)).filter(
    (entry): entry is RunnerEngineHealth => !!entry,
  );
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
