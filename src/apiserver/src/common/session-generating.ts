import { Prisma, RunStatus } from '@prisma/client';

/**
 * Whether the engine is producing output for this session right now.
 *
 * RUNNING is the dispatched case. The second is a turn the runtime started for itself — a
 * background task reporting in, a scheduled wake-up — which never reaches /turn-complete and so
 * stays parked at AWAITING_INPUT for its whole duration (see Session.engineTurnActive).
 *
 * Deliberately a different question from `sessionHoldsRunnerSlot`: a self-driven turn acquired no
 * permit and must not be counted against a runner's concurrency. This one decides only what the
 * clients show — and which sessions can be holding a live approval, since a permission prompt
 * raised mid-wake-up needs answering exactly as much as one raised on a dispatched turn.
 *
 * Mirrors `isGenerating` in the web console and `Session.isGenerating` in OrbitKit.
 */
export const isSessionGenerating = (session: {
  status: RunStatus;
  engineTurnActive?: boolean | null;
}): boolean =>
  session.status === RunStatus.RUNNING ||
  (session.status === RunStatus.AWAITING_INPUT && session.engineTurnActive === true);

/** The same predicate as a Prisma filter, for counts that aggregate instead of fetching rows. */
export const GENERATING_SESSION_FILTER = {
  OR: [
    { status: RunStatus.RUNNING },
    { status: RunStatus.AWAITING_INPUT, engineTurnActive: true },
  ],
};

/**
 * The same predicate again, as SQL, for an aggregate that cannot go through the query builder —
 * per-project tallies group by a column `session` does not have (see `projectSessionCounts`).
 * Kept in this file, beside the other two spellings, so a change to what "generating" means is
 * one edit rather than a hunt.
 *
 * `alias` is however the calling query names the session table; an alias cannot be bound as a
 * parameter, hence `Prisma.raw` (same convention as `session-tree-sql.ts`).
 */
export const generatingSessionSql = (alias: string): Prisma.Sql => {
  const s = Prisma.raw(alias);
  return Prisma.sql`(${s}."status" = 'RUNNING'
    OR (${s}."status" = 'AWAITING_INPUT' AND ${s}."engine_turn_active"))`;
};
