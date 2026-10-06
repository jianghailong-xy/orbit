import {
  RUNNER_SELF_UPDATE_STATES,
  type RunnerSelfUpdate,
  type RunnerSelfUpdateState,
} from '@orbit/shared';

/** Caps on what a runner may store here: enough for a real reason or path, bounded so a runaway
 *  report can't be stored as one. */
const REASON_MAX = 1000;
const DIR_MAX = 1024;
const VERSION_MAX = 64;

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
  const at = text(raw.lastUpdatedAt, 64);
  const lastUpdatedAt = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined;
  const lastUpdatedFrom = text(raw.lastUpdatedFrom, VERSION_MAX);
  const lastUpdatedTo = text(raw.lastUpdatedTo, VERSION_MAX);
  return {
    state: state as RunnerSelfUpdateState,
    ...(reason ? { reason } : {}),
    ...(installDir ? { installDir } : {}),
    ...(lastUpdatedAt ? { lastUpdatedAt } : {}),
    ...(lastUpdatedFrom ? { lastUpdatedFrom } : {}),
    ...(lastUpdatedTo ? { lastUpdatedTo } : {}),
  };
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replaceAll('\u0000', '').trim().slice(0, max);
  return clean || undefined;
}
