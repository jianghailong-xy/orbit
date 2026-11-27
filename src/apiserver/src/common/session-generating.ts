import { isParked, turnStateFilter, type TurnStateFacts } from '../sessions/session-turn-state';
import { DISPATCHED_TURN, ENGINE_TURN } from './session-working';

/**
 * Whether the engine is producing output for this session right now.
 *
 * A dispatched turn (the turn state IN_FLIGHT) is the first case. The second is a turn the runtime started for
 * itself — a background task reporting in, a scheduled wake-up — which never reaches /turn-complete and so
 * stays parked (held, no turn state: what AWAITING_INPUT said) for its whole duration (see Session.engineTurnActive).
 * A row read with TURN_STATE_SELECT (sessions/session-turn-state.ts).
 *
 * Deliberately a different question from `sessionHoldsRunnerSlot`: a self-driven turn acquired no
 * permit and must not be counted against a runner's concurrency. This one decides only what the
 * clients show — and which sessions can be holding a live approval, since a permission prompt
 * raised mid-wake-up needs answering exactly as much as one raised on a dispatched turn.
 *
 * Mirrors `isGenerating` in the web console and `Session.isGenerating` in OrbitKit. Built from the
 * facts in ./session-working.ts; it is narrower than `isSessionExecuting` on purpose (no subagent,
 * no background job, only a parked session's engine turn).
 */
export const isSessionGenerating = (session: TurnStateFacts & {
  engineTurnActive?: boolean | null;
}): boolean =>
  DISPATCHED_TURN.holds(session) ||
  (isParked(session) && ENGINE_TURN.holds(session));

/** The same predicate as a Prisma filter, for counts that aggregate instead of fetching rows. */
export const GENERATING_SESSION_FILTER = {
  OR: [
    DISPATCHED_TURN.where,
    { AND: [turnStateFilter([null]), ENGINE_TURN.where] },
  ],
};
