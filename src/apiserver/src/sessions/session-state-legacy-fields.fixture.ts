/**
 * Every combination of the stored facts the legacy wire fields are projected from (plan step 4.8 of
 * docs/session-three-state-plan.md): the seven stored statuses, every end reason a row can carry (none, the empty
 * string, the six SessionEndReason values and the two legacy ones), and the filing facts (open, filed through
 * `completed_at`, filed through the legacy `archived_at` mirror alone, trashed, filed and trashed).
 *
 * Beside the stored word each row carries the facts the words are derived from (sessions/session-legacy-words.ts), as
 * a session that ran has them: `finished_at` set exactly on the three released statuses (session_release_fact_chk),
 * the turn state of a held word (migration 1611), `last_turn_outcome` FAILED on a FAILED release (every failure
 * writer records it; migration 1441 wrote it for the rest) and none otherwise, a start, no import marker, a
 * conversation. The stored word is not read by the projector.
 *
 * No imports, so the golden table (session-state-legacy-fields.golden.json) can be generated from this file at the
 * base commit by the built projector alone.
 */

export const STORED_STATUSES = [
  'PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
] as const;

export const STORED_END_REASONS: readonly (string | null)[] = [
  null, '', 'task_done', 'task_cancelled', 'ended', 'completed', 'deleted', 'cancelled', 'idle', 'orphaned',
];

const AT = '2026-11-21T00:00:00.000Z';

const FILING: Record<string, { completedAt: string | null; archivedAt: string | null; deletedAt: string | null }> = {
  open: { completedAt: null, archivedAt: null, deletedAt: null },
  filed: { completedAt: AT, archivedAt: AT, deletedAt: null },
  filedLegacyMirror: { completedAt: null, archivedAt: AT, deletedAt: null },
  trashed: { completedAt: null, archivedAt: null, deletedAt: AT },
  filedAndTrashed: { completedAt: AT, archivedAt: AT, deletedAt: AT },
};

const RELEASED = new Set<string>(['SUCCEEDED', 'FAILED', 'CANCELLED']);

const TURN_STATE: Record<string, string> = { PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED' };

export interface LegacyFieldsCase {
  key: string;
  row: {
    status: string;
    endReason: string | null;
    completedAt: string | null;
    archivedAt: string | null;
    deletedAt: string | null;
    finishedAt: string | null;
    turnState: string | null;
    lastTurnOutcome: string | null;
    startedAt: string | null;
    importSourceCwd: string | null;
    sessionKind: string;
  };
}

export function combinations(): LegacyFieldsCase[] {
  const cases: LegacyFieldsCase[] = [];
  for (const status of STORED_STATUSES) {
    for (const endReason of STORED_END_REASONS) {
      for (const [filing, facts] of Object.entries(FILING)) {
        cases.push({
          key: `${status}|${endReason === null ? '<null>' : endReason === '' ? '<empty>' : endReason}|${filing}`,
          row: {
            status,
            endReason,
            ...facts,
            finishedAt: RELEASED.has(status) ? AT : null,
            turnState: TURN_STATE[status] ?? null,
            lastTurnOutcome: status === 'FAILED' ? 'FAILED' : null,
            startedAt: AT,
            importSourceCwd: null,
            sessionKind: 'CONVERSATION',
          },
        });
      }
    }
  }
  return cases;
}
