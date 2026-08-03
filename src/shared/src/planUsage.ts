import type { PlanUsage, PlanUsageSnapshot, PlanUsageWindow } from './dto';

/** A window counts as exhausted at 100% consumed — the provider stops accepting work. */
const EXHAUSTED_UTILIZATION = 100;

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
 */
export function planUsageBlockedUntil(
  usage: PlanUsage | null | undefined,
  provider: string,
  now: Date,
): Date | null {
  if (!usage) return null;
  const snapshot = snapshotFor(usage, provider);
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
