import {
  RUNNER_SELF_UPDATE_PHASES,
  RUNNER_SELF_UPDATE_STATES,
  type QueuedRunnerUpdate,
  type RunnerSelfUpdate,
  type RunnerSelfUpdatePhase,
  type RunnerSelfUpdateState,
} from '@orbit/shared';

/** Caps on what a runner may store here: enough for a real reason or path, bounded so a runaway
 *  report can't be stored as one. */
const REASON_MAX = 1000;
const DIR_MAX = 1024;
const VERSION_MAX = 64;
const TURNS_MAX = 10_000;

/**
 * Normalize the self-update report a runner sent (RunnerHeartbeatRequest.selfUpdate) — on the way
 * into the row, and again on the way out, since the column holds whatever an earlier shape stored.
 *
 * Null when there is no usable report: absent, not an object, or a state this server does not know.
 * That is stored and returned as "not reported", which keeps the clients on the behaviour they had
 * before the field, rather than drawing a card from a report half understood. Optional fields that
 * are malformed are dropped one by one; a NUL, which Postgres cannot store, is removed.
 */
export function sanitizeRunnerSelfUpdate(value: unknown): RunnerSelfUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const state = raw.state;
  if (typeof state !== 'string' || !RUNNER_SELF_UPDATE_STATES.includes(state as RunnerSelfUpdateState)) {
    return null;
  }
  const reason = text(raw.reason, REASON_MAX);
  const installDir = text(raw.installDir, DIR_MAX);
  const lastUpdatedAt = isoTime(raw.lastUpdatedAt);
  const lastUpdatedFrom = text(raw.lastUpdatedFrom, VERSION_MAX);
  const lastUpdatedTo = text(raw.lastUpdatedTo, VERSION_MAX);
  // The release and the drain's start travel with or without a phase (queuedRunnerUpdateOf reads
  // them); the Update card's other fields only with a phase this server knows, so an unknown phase
  // leaves the clients on the wording they have for a runner that sends none.
  const targetVersion = text(raw.targetVersion, VERSION_MAX);
  const drainingSince = isoTime(raw.drainingSince);
  const phase = RUNNER_SELF_UPDATE_PHASES.includes(raw.phase as RunnerSelfUpdatePhase)
    ? (raw.phase as RunnerSelfUpdatePhase)
    : undefined;
  const availableSince = phase ? isoTime(raw.availableSince) : undefined;
  const postponedUntil = phase ? isoTime(raw.postponedUntil) : undefined;
  const turnsInFlight = phase ? count(raw.turnsInFlight) : undefined;
  const turnsAtDrain = phase ? count(raw.turnsAtDrain) : undefined;
  return {
    state: state as RunnerSelfUpdateState,
    ...(reason ? { reason } : {}),
    ...(installDir ? { installDir } : {}),
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(lastUpdatedFrom ? { lastUpdatedFrom } : {}),
    ...(lastUpdatedTo ? { lastUpdatedTo } : {}),
    ...(phase ? { phase } : {}),
    ...(targetVersion ? { targetVersion } : {}),
    ...(availableSince ? { availableSince } : {}),
    ...(drainingSince ? { drainingSince } : {}),
    ...(postponedUntil ? { postponedUntil } : {}),
    ...(turnsInFlight ? { turnsInFlight } : {}),
    ...(turnsAtDrain ? { turnsAtDrain } : {}),
  };
}

/** The runner's RFC3339 time as the ISO the other dates in this API use; anything else is dropped. */
function isoTime(value: unknown): string | undefined {
  const at = text(value, 64);
  return at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined;
}

/**
 * The explanation a session held by queuedReason 'runner_updating' carries, from the columns the
 * session list reads beside the gate. Null for any other row. The release and the drain's start come
 * from the runner's own report when it sends them; without a drainingSince, the session's own wait is
 * the clock.
 */
export function queuedRunnerUpdateOf(row: {
  queuedReason: string | null;
  queuedRunnerSelfUpdate: unknown;
  queuedRunnerTurns: Array<{ id: string; title: string | null }> | null;
  queuedSince: Date | null;
}): QueuedRunnerUpdate | null {
  if (row.queuedReason !== 'runner_updating') return null;
  const report = sanitizeRunnerSelfUpdate(row.queuedRunnerSelfUpdate);
  return {
    targetVersion: report?.targetVersion ?? null,
    since: report?.drainingSince ?? row.queuedSince?.toISOString() ?? null,
    turns: row.queuedRunnerTurns ?? [],
  };
}

/** A turn count: a whole number from 1 to TURNS_MAX; 0 is the same as absent. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= TURNS_MAX ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replaceAll('\u0000', '').trim().slice(0, max);
  return clean || undefined;
}
