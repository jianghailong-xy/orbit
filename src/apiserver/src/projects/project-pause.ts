import type { ProjectPauseReason, ProjectPauseState } from '@orbit/shared';

/**
 * Pause project: the one switch for whether a started project moves (migration 0334).
 *
 * WHAT A PAUSE HOLDS, AND WHAT IT DOES NOT
 * =========================================
 * While `paused_at` is set nothing starts the project's tasks by itself and nothing merges it into
 * main by itself, and an agent's `task_start` is refused (`tasks/project-pause-dispatch.ts`). The
 * owner's own Run still starts a task, and a run that is already going is not stopped.
 *
 * TWO WAYS IN, AND WHICH WAY OUT EACH ONE HAS
 * ===========================================
 * - The owner presses Pause project (`POST /projects/:id/pause`): reason `OWNER`. Only Resume
 *   project (`POST /projects/:id/resume`) lifts it.
 * - A client that only knows the one Automatic switch turns it off (`PATCH /projects/:id
 *   {coordinatorEnabled: false}`): reason `LEGACY_AUTOMATIC_OFF`. On those clients that switch was
 *   the project's on switch, and "Nothing here starts or asks on its own" is what they promise when it
 *   is off — so its off still stops the project, and its on lifts that pause and no other. A newer
 *   client writes Automatic as `{automatic}`, which says who decides and leaves the pause alone.
 *
 * Only a started project is paused (0334's CHECK): an unstarted one runs nothing by itself already,
 * and a pause written on it would still be standing — unseen — after the owner pressed Start.
 */

/** A project row's start and pause, as a write reads them under the project lock. */
export interface ProjectPauseRow {
  startedAt: Date | null;
  pausedAt: Date | null;
  pausedReason: string | null;
}

/** What a write sets the two pause columns to — together, as 0334's CHECK holds them. */
export interface ProjectPauseWrite {
  pausedAt: Date | null;
  pausedReason: ProjectPauseReason | null;
}

/**
 * What an older client's Automatic switch does to the pause, or null when it leaves it as it is.
 *
 * Off pauses a started project that is not paused already. On lifts the pause an off wrote, and
 * leaves the owner's own pause standing: an owner who paused the project and then flips an older
 * client's switch has not pressed Resume.
 */
export function legacySwitchPauseWrite(
  coordinatorEnabled: boolean | undefined,
  row: ProjectPauseRow,
  at: Date,
): ProjectPauseWrite | null {
  if (coordinatorEnabled === false) {
    if (row.startedAt == null || row.pausedAt != null) return null;
    return { pausedAt: at, pausedReason: 'LEGACY_AUTOMATIC_OFF' };
  }
  if (coordinatorEnabled === true && row.pausedAt != null && row.pausedReason === 'LEGACY_AUTOMATIC_OFF') {
    return { pausedAt: null, pausedReason: null };
  }
  return null;
}

/**
 * What the owner's Pause project writes, null when nothing changes, or NOT_STARTED.
 *
 * A project the older switch paused becomes the owner's pause — same instant, since that is when it
 * stopped — so the older switch can no longer lift it.
 */
export function ownerPauseWrite(row: ProjectPauseRow, at: Date): ProjectPauseWrite | 'NOT_STARTED' | null {
  if (row.startedAt == null) return 'NOT_STARTED';
  if (row.pausedAt != null && row.pausedReason === 'OWNER') return null;
  return { pausedAt: row.pausedAt ?? at, pausedReason: 'OWNER' };
}

/** What the owner's Resume project writes, or null when the project is not paused. Lifts either pause. */
export function resumeWrite(row: ProjectPauseRow): ProjectPauseWrite | null {
  return row.pausedAt == null ? null : { pausedAt: null, pausedReason: null };
}

/** The answer both doors give: whether the project moves now, and why not. */
export function projectPauseState(projectId: string, row: ProjectPauseRow): ProjectPauseState {
  return {
    projectId,
    startedAt: row.startedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    pausedReason: row.pausedAt == null
      ? null
      : row.pausedReason === 'LEGACY_AUTOMATIC_OFF' ? 'LEGACY_AUTOMATIC_OFF' : 'OWNER',
  };
}

/** The refusal code a request made from a session gets at either door. */
export const PROJECT_PAUSE_OWNER_ONLY = 'PROJECT_PAUSE_OWNER_ONLY';

/**
 * Why this request may not pause or resume the project, or null when it carries no acting session.
 *
 * The owner's, like starting it: whether the project moves is the owner's decision, and an agent
 * that could resume a project would be undoing the one stop its owner has. Decided on the session
 * header alone, the way the start door decides it, so the credential the request came with does not
 * matter.
 */
export function projectPauseSessionRefusal(
  actingSessionId: string | null | undefined,
): { code: typeof PROJECT_PAUSE_OWNER_ONLY; message: string } | null {
  const session = actingSessionId?.trim();
  if (!session) return null;
  return {
    code: PROJECT_PAUSE_OWNER_ONLY,
    message:
      `this request carries the session header of ${session}, so an agent session is making it; `
      + 'pausing or resuming a project is the account owner’s, from the Orbit app with their own '
      + 'sign-in. Tell the owner what you would pause or resume and why.',
  };
}
