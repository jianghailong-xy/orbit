/**
 * What a scheduled run's session is doing, read from the session's one published state and nothing else
 * (sessions/session-phase.ts: the phase fields, and `sessionWakes` from the same row). Every decision the runs
 * service makes about a run's session — the watch pass, the landing, completing a NO_CHANGE session, a stray before
 * a start — asks this, so none of them reads a session column as state (docs/session-three-state-design.md §11.5).
 *
 *   WORKING    held, and something executes or a turn is queued (phase RUNNING or PENDING). A queued turn kept from
 *              starting by a hold (`waitingOn: HOLD`) is WORKING too: its wait counts toward the run limit.
 *   WILL_WAKE  nothing executes, but something will give it a turn without anybody writing: a watch, a scheduled
 *              wake-up or an armed retry on a held session; on a released one only what revives a release. Asked
 *              beside PERSON, so an owner request the run filed does not hide it.
 *   IDLE       held, nothing executes and nothing will wake it.
 *   FAILED     released by a failure (the turn FAILED, no end asked for) that nothing revives.
 *   ENDED      released any other way that nothing revives: an end somebody asked for, or the engine's own exit.
 */
import type { SessionPhaseFields } from '@orbit/shared';

import { readSessionPhaseReadings, type SessionPhaseReading } from '../sessions/session-phase';

type Db = Parameters<typeof readSessionPhaseReadings>[0];

export type RunSessionReading = 'WORKING' | 'WILL_WAKE' | 'IDLE' | 'FAILED' | 'ENDED';

/** Released by a failure: released, its last turn FAILED, and no end asked for (session_get's own definition). */
export function releasedByFailure(fields: SessionPhaseFields): boolean {
  return fields.released && fields.lastTurnOutcome === 'FAILED' && fields.endReason === null;
}

export function runSessionReading({ fields, wakes }: SessionPhaseReading): RunSessionReading {
  if (fields.released) {
    if (wakes) return 'WILL_WAKE';
    return releasedByFailure(fields) ? 'FAILED' : 'ENDED';
  }
  if (fields.phase !== 'IDLE') return 'WORKING';
  return wakes ? 'WILL_WAKE' : 'IDLE';
}

/** The sessions' phase readings by id, with the run reading beside them; a session that is not there is absent. */
export async function readRunSessions(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, SessionPhaseReading & { reading: RunSessionReading }>> {
  const readings = await readSessionPhaseReadings(db, ids);
  return new Map([...readings].map(([id, r]) => [id, { ...r, reading: runSessionReading(r) }]));
}
