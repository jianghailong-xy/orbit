import { RUNNER_RESTART_INTERRUPT_REASON, RUNNER_UPDATE_INTERRUPT_REASON } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';

/** The interrupt reasons a runner stop writes: its turns wait for the runner to come back, not for an engine. */
const RUNNER_STOP_REASONS = [RUNNER_RESTART_INTERRUPT_REASON, RUNNER_UPDATE_INTERRUPT_REASON];

/** What the clock reads: the session's own activity clock, and the newest runner-stop cut of a turn still unanswered. */
export interface RuntimeStartupFacts {
  lastTurnAt: Date | null;
  /** The cut's interrupt event, when it was received, and its turn's latest delivery. */
  cut: { at: Date; turnDeliveredAt: Date | null } | null;
}

/**
 * The instant the reaper's "runtime not initialized" watchdog counts from, or null while it must not
 * count at all (task 34wNtnf94bNWNz0bmcieV).
 *
 * The watchdog measures a RUNNING session whose dynamic runtime never reported its id from
 * `lastTurnAt`. A turn a runner restart or the owner's Update Now cut (interrupt `runner_restart` /
 * `runner_update`) waits for the runner to come back, which can take minutes, and nothing moves
 * `lastTurnAt` meanwhile: counted that way the downtime alone would fail the run. So:
 *  - cut and not delivered since: the turn waits for its runner. No clock. A runner that never
 *    comes back is the offline branch's (RUNNER_REAP_AFTER_MS), which runs before this one.
 *  - re-delivered after the cut: the clock starts at that delivery, as a fresh start would.
 *  - no such cut: `lastTurnAt`, as before.
 */
export function runtimeStartupClock(facts: RuntimeStartupFacts): number | null {
  const last = facts.lastTurnAt?.getTime() ?? 0;
  if (!facts.cut) return last;
  const delivered = facts.cut.turnDeliveredAt?.getTime();
  if (delivered === undefined || delivered <= facts.cut.at.getTime()) return null;
  return Math.max(last, delivered);
}

/** Read RuntimeStartupFacts for one session: two indexed lookups, made only once its grace has run out. */
export async function readRuntimeStartupFacts(
  prisma: Pick<PrismaService, 'runEvent' | 'conversationTurn'>,
  sessionId: string,
  lastTurnAt: Date | null,
): Promise<RuntimeStartupFacts> {
  const cuts = await prisma.runEvent.findMany({
    where: {
      sessionId,
      type: 'interrupt',
      turnId: { not: null },
      OR: RUNNER_STOP_REASONS.map((reason) => ({ payload: { path: ['reason'], equals: reason } })),
    },
    orderBy: { seq: 'desc' },
    take: 1,
    select: { turnId: true, createdAt: true, ingestedAt: true },
  });
  const cut = cuts[0];
  if (!cut?.turnId) return { lastTurnAt, cut: null };
  const turn = await prisma.conversationTurn.findUnique({
    where: { id: cut.turnId },
    select: { answeredAt: true, deliveredAt: true },
  });
  // A cut turn that has since been answered is history: the run in flight now is another one.
  if (!turn || turn.answeredAt) return { lastTurnAt, cut: null };
  // The receive time, on the database's clock as delivered_at is; a historical row has only the runner's.
  return { lastTurnAt, cut: { at: cut.ingestedAt ?? cut.createdAt, turnDeliveredAt: turn.deliveredAt } };
}

/** Whether the watchdog's grace has run out on `clock` (null: it is not counting). */
export function runtimeStartupOverdue(clock: number | null, now: number, grace: number): boolean {
  return clock !== null && now - clock > grace;
}
