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
 * The member a claim dispatches on: `selectPoolMember`'s choice, and when every member is spent still
 * one of the pool's own accounts — the session's member if it is one of them, else the one that frees
 * up first. The run then meets the limit, and the retry it arms waits out the reset, exactly as a
 * session on a single account does, rather than moving onto the runner's own login. Null only when no
 * member can run at all (UNAVAILABLE), which dispatches as a deleted provider does.
 */
export function choosePoolMember<Row extends PoolMemberRow>(
  candidates: readonly PoolCandidate<Row>[],
  stickyId: string | null,
  now: Date,
): Row | null {
  const selection = selectPoolMember(candidates, stickyId, now);
  if (selection.kind === 'SELECTED') return selection.row;
  if (selection.kind === 'UNAVAILABLE') return null;
  const spent = selection.members.filter((m) => !m.refused);
  const firstToReset = spent.find((m) => m.resetsAt?.getTime() === selection.resetsAt?.getTime());
  return (spent.find((m) => m.row.id === stickyId) ?? firstToReset ?? spent[0]).row;
}

/**
 * When work held back on an account pool's quota can go, for what holds work rather than choosing a
 * member: `now` while `selectPoolMember` still finds one, and EXHAUSTED's earliest reset once every
 * member that can run is spent.
 *
 * Null when the pool gives nothing to go by, and the caller holds the work as it would for any quota it
 * cannot see: no member that can run reports its quota at all — a pool nobody has reported on is not one
 * with room — or every member is spent and none named its reset.
 */
export function poolResumesAt<Row extends PoolMemberRow>(
  candidates: readonly PoolCandidate<Row>[],
  now: Date,
): Date | null {
  if (candidates.every((c) => c.refused || c.usage === null)) return null;
  const selection = selectPoolMember(candidates, null, now);
  if (selection.kind === 'SELECTED') return now;
  return selection.kind === 'EXHAUSTED' ? selection.resetsAt : null;
}

/** What saying why a session left a member needs to know about that member. */
export interface PoolSwitchFrom {
  label: string;
  enabled: boolean;
  usage: PlanUsageSnapshot | null;
  refused: boolean;
}

/**
 * The transcript line for a session moving onto `to`, naming why it left the member it ran on. Without
 * it, a 5-hour gauge that drops from 91% to 12% between two turns reads as a broken gauge. `from` is
 * null when that member is no longer in the pool.
 */
export function poolSwitchNotice(to: { label: string }, from: PoolSwitchFrom | null, now: Date): string {
  return `Switched to ${to.label} — ${from ? whyLeft(from, now) : 'the previous account is no longer in this pool'}`;
}

/**
 * The transcript line for a claim on a pool none of whose members can run (choosePoolMember's null): the
 * run goes to the Claude default, the runner's own login, as it always has — and without this line it
 * would spend that login in silence, on a session that was started on the pool's accounts.
 */
export function poolFallbackNotice(pool: { label: string }): string {
  return `Fell back to the Claude default (this runner's own login) — no account in the pool "${pool.label}" can run`;
}

function whyLeft(from: PoolSwitchFrom, now: Date): string {
  if (from.refused) return `${from.label}'s key was refused`;
  if (!from.enabled) return `${from.label} is disabled`;
  const spent = spentWindow(from.usage, now);
  return spent ? `${from.label}'s ${spent} window is spent` : `${from.label} is unavailable`;
}

/** Every Claude window a member can spend, with the name the transcript gives it. */
const WINDOWS = [
  ['fiveHour', '5-hour'],
  ['sevenDay', 'weekly'],
  ['sevenDayOpus', 'weekly Opus'],
  ['sevenDaySonnet', 'weekly Sonnet'],
] as const;

/**
 * At or over 100% and not yet past its reset time. A window with no reset time we can read counts as
 * spent — nothing says it has reset.
 */
function isSpent(w: PlanUsageWindow | undefined, now: Date): w is PlanUsageWindow {
  return w !== undefined && w.utilization >= SPENT_UTILIZATION && !(Date.parse(w.resetsAt ?? '') <= now.getTime());
}

/**
 * Whether one member is spent right now, for what shows the pool rather than choosing from it: undefined
 * when none of its windows is, else when it can take work again — the latest reset of its spent windows,
 * as for one account, and null when one of them named no reset. The same test `selectPoolMember` rules a
 * member out by, so what the page calls spent is what the claim passes over.
 */
export function spentUntil(usage: PlanUsageSnapshot | null, now: Date): Date | null | undefined {
  const resets = spentResets(usage, now);
  return resets.length === 0 ? undefined : latestReset(resets);
}

/** The resets of a member's spent windows, NaN for one with no reset time. */
function spentResets(usage: PlanUsageSnapshot | null, now: Date): number[] {
  if (!usage) return [];
  return WINDOWS.map(([key]) => usage[key])
    .filter((w): w is PlanUsageWindow => isSpent(w, now))
    .map((w) => Date.parse(w.resetsAt ?? ''));
}

/** The name of the first spent window, or null when none is. */
function spentWindow(usage: PlanUsageSnapshot | null, now: Date): string | null {
  return WINDOWS.find(([key]) => isSpent(usage?.[key], now))?.[1] ?? null;
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
