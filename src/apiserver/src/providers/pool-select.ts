import type { PlanUsageSnapshot, PlanUsageWindow } from '@orbit/shared';

/** A window counts as spent at 100% consumed — the line planUsageBlockedUntil draws too. */
const SPENT_UTILIZATION = 100;

/** What choosing needs of a member's row: an identity to stay on, and a slug to settle ties. */
export interface PoolMemberRow {
  id: string;
  slug: string;
}

export interface PoolCandidate<Row extends PoolMemberRow> {
  row: Row;
  /** The member's quota as ProviderPlanUsageService reads it; null when it has none to report. */
  usage: PlanUsageSnapshot | null;
  /** The usage endpoint refused this credential (401/403), which ProviderPlanUsageService takes as
   *  final and never asks about again. */
  refused: boolean;
}

/** A member no run can go to right now. */
export interface PoolMemberHold<Row extends PoolMemberRow> {
  row: Row;
  refused: boolean;
  /** When it can take work again. Like a single account it waits for every spent window, so this is
   *  the latest of their resets. Null when refused, or when a spent window reported no reset time. */
  resetsAt: Date | null;
}

/**
 * SELECTED names the member to run on. The other two say why there is none, and differ in whether
 * waiting helps:
 * - EXHAUSTED: every member that can run is spent. `resetsAt` is the EARLIEST member reset — across
 *   accounts one freeing up is enough to continue, the opposite direction from one account's own
 *   windows. Null when no spent member reported a reset time.
 * - UNAVAILABLE: no member can run and no reset will change that — every credential was refused, or
 *   the pool has no members.
 */
export type PoolSelection<Row extends PoolMemberRow> =
  | { kind: 'SELECTED'; row: Row }
  | { kind: 'EXHAUSTED'; resetsAt: Date | null; members: PoolMemberHold<Row>[] }
  | { kind: 'UNAVAILABLE'; members: PoolMemberHold<Row>[] };

/**
 * The member of an account pool the next run should go to: the one with the most room left in its
 * 5-hour window.
 *
 * - `stickyId`, the member the session already runs on, is kept for as long as it is usable, even
 *   when another has more room: moving accounts over a few percent gains nothing.
 * - A member with no 5-hour reading ranks after every member that has one. Not reported is not the
 *   same as not used, so it is never taken for 0%.
 * - A refused credential is no candidate at all, whatever its last snapshot said.
 * - Equal utilization goes to the lower slug, so the answer never depends on the order of the rows.
 *
 * Only the 5-hour window ranks, but any spent window rules a member out: a weekly limit stops an
 * account as surely as the 5-hour one. A spent window counts until its reset has passed, and so does
 * one that reported no reset at all — planUsageBlockedUntil lets that case through because holding a
 * lone account without a resume time would hold it forever, but here passing one member over just
 * sends the run to another.
 */
export function selectPoolMember<Row extends PoolMemberRow>(
  candidates: readonly PoolCandidate<Row>[],
  stickyId: string | null,
  now: Date,
): PoolSelection<Row> {
  const usable = candidates.filter((c) => !c.refused && spentResets(c.usage, now).length === 0);
  const chosen = usable.find((c) => c.row.id === stickyId) ?? usable.sort(byRoom)[0];
  if (chosen) return { kind: 'SELECTED', row: chosen.row };

  const members = candidates.map((c) => ({
    row: c.row,
    refused: c.refused,
    resetsAt: c.refused ? null : latestReset(spentResets(c.usage, now)),
  }));
  // Nothing is usable, so every member that is not refused is spent.
  if (members.every((m) => m.refused)) return { kind: 'UNAVAILABLE', members };
  const known = members.flatMap((m) => (m.resetsAt ? [m.resetsAt.getTime()] : []));
  return { kind: 'EXHAUSTED', resetsAt: known.length > 0 ? new Date(Math.min(...known)) : null, members };
}

/**
 * The resets of a member's spent windows: at or over 100% and not yet past their reset time. A window
 * with no reset time we can read is kept, as NaN — nothing says it has reset.
 */
function spentResets(usage: PlanUsageSnapshot | null, now: Date): number[] {
  if (!usage) return [];
  return [usage.fiveHour, usage.sevenDay, usage.sevenDayOpus, usage.sevenDaySonnet]
    .filter((w): w is PlanUsageWindow => w !== undefined && w.utilization >= SPENT_UTILIZATION)
    .map((w) => Date.parse(w.resetsAt ?? ''))
    .filter((resetsAt) => !(resetsAt <= now.getTime()));
}

/** Every one of them has to pass, so the latest — unknown if any one is. */
function latestReset(resets: number[]): Date | null {
  return resets.some(Number.isNaN) ? null : new Date(Math.max(...resets));
}

/** Least 5-hour utilization first, no reading last, then by slug. */
function byRoom<Row extends PoolMemberRow>(a: PoolCandidate<Row>, b: PoolCandidate<Row>): number {
  const used = (c: PoolCandidate<Row>) => c.usage?.fiveHour?.utilization ?? Number.POSITIVE_INFINITY;
  // Two members with no reading subtract to NaN, which falls through to the slug like any other tie.
  return used(a) - used(b) || (a.row.slug < b.row.slug ? -1 : a.row.slug > b.row.slug ? 1 : 0);
}
