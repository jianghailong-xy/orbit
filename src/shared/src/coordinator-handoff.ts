/**
 * Coordinator handoff — "Start a new coordinator" with a handoff note (board 02,
 * docs/coordinator-handoff.md). The outgoing coordinator writes a note in a platform turn, then the
 * replacement (`POST /projects/:id/coordinator/replace`'s path) opens its successor with that note in
 * its opening, moves the outgoing coordinator's pending waits to it, and completes the outgoing one.
 *
 * ENDPOINTS (all owner-authenticated, ids public; each answers `CoordinatorHandoffView`, except the
 * preview):
 *
 *   GET  /projects/:id/coordinator/pending-waits  → CoordinatorPendingWait[]   (the confirm dialog)
 *   POST /projects/:id/coordinator/handoff        → start: queue the note turn (after a running turn)
 *   POST /projects/:id/coordinator/handoff/skip   → Skip the note / Hand over without a note
 *   POST /projects/:id/coordinator/handoff/cancel → Cancel handover / Keep this coordinator
 *   POST /projects/:id/coordinator/handoff/retry  → Try again (after FAILED)
 *
 * STATE ON SESSIONS: `GET /sessions/:id` and the realtime `session.updated` summary carry
 * `coordinatorHandoff` (on the outgoing coordinator) and `coordinatorHandoffReceived` (on its
 * successor), each null when there is nothing to show. Every transition publishes `session.updated`
 * for both sessions it touches, so an open client re-reads them.
 */

/** Every note turn's `clientTurnId` starts here: a platform turn, not the owner's message. */
export const COORDINATOR_HANDOFF_TURN_PREFIX = 'coordinator-handoff:v1:';

/** The four sections the note is asked for, in order, as the successor's card titles them. */
export const COORDINATOR_HANDOFF_SECTIONS = [
  'Where things stand',
  'Agreed with the owner',
  'Waiting on',
  'Next',
] as const;

/**
 * Where a handoff stands, as the outgoing coordinator shows it.
 *
 *   WRITING       — the note turn is queued (behind a running turn) or running: "Writing the handoff
 *                   note" with a timer from `startedAt`; Skip the note and Cancel handover offered.
 *   HANDING_OVER  — the note is in (or was skipped) and the replacement is running: "Handing over to
 *                   a new coordinator…".
 *   FAILED        — the note turn failed, timed out or was stopped, and nothing changed: the old
 *                   coordinator is still current and no wait moved. `failureReason` says why; Try
 *                   again, Hand over without a note and Keep this coordinator are offered.
 *   COMPLETED     — handed over: `handedOverToSessionId` is the successor ("Handed over to a new
 *                   coordinator. Open it").
 *
 * A cancelled handoff is not shown at all (`coordinatorHandoff: null`): Cancel changes nothing.
 */
export type CoordinatorHandoffState = 'WRITING' | 'HANDING_OVER' | 'FAILED' | 'COMPLETED';

/** Why a note was not written. `COORDINATOR_HANDOFF_FAILURE_REASONS` is the sentence for each. */
export type CoordinatorHandoffFailureCode =
  | 'TURN_FAILED'
  | 'TURN_STOPPED'
  | 'TIMED_OUT'
  | 'EMPTY_NOTE'
  | 'REPLACE_FAILED';

/** The end of "The handoff note wasn't written: …", per code. */
export const COORDINATOR_HANDOFF_FAILURE_REASONS: Readonly<Record<CoordinatorHandoffFailureCode, string>> = {
  TURN_FAILED: 'the turn failed.',
  TURN_STOPPED: 'the turn was stopped.',
  TIMED_OUT: 'the turn timed out.',
  EMPTY_NOTE: 'the reply was empty.',
  REPLACE_FAILED: 'the new coordinator could not be opened.',
};

/** One wait the outgoing coordinator set (a `task_await` or a watch), as the confirm dialog and the
 *  successor's "N waits moved here" list name it. A PAUSED watch moves too and stays paused. */
export interface CoordinatorPendingWait {
  /** The watch's id. */
  id: string;
  /** e.g. `Waiting for "Fix login redirect" to be DONE`. */
  label: string;
  /** True for a PAUSED watch: it moves and stays paused. */
  paused: boolean;
}

/** `coordinatorHandoff` on the OUTGOING coordinator's session (detail and `session.updated`). */
export interface SessionCoordinatorHandoff {
  state: CoordinatorHandoffState;
  /** When the current note turn was asked for (ISO) — the WRITING timer counts from it. */
  startedAt: string;
  failureCode: CoordinatorHandoffFailureCode | null;
  /** The whole failure sentence, e.g. "The handoff note wasn't written: the turn failed." Null unless FAILED. */
  failureReason: string | null;
  /** The successor, once COMPLETED; null before. */
  handedOverToSessionId: string | null;
}

/** `coordinatorHandoffReceived` on the SUCCESSOR's session (detail and `session.updated`). */
export interface SessionCoordinatorHandoffReceived {
  /** The previous coordinator, which the note card links to. */
  handoffFromSessionId: string;
  /** The note as the previous coordinator wrote it; null when the owner skipped it. */
  note: string | null;
  /** When the handover completed (ISO) — "Handoff from the previous coordinator · 3:42 PM". */
  handedOverAt: string;
  /** The waits that moved here, oldest first; `[]` when none did. */
  movedWaits: CoordinatorPendingWait[];
}

/** What every handoff endpoint answers: the project's handoff as it now stands. */
export interface CoordinatorHandoffView {
  projectId: string;
  /** The outgoing coordinator. */
  sessionId: string;
  /** CANCELLED only as the answer to a cancel; sessions never show it. */
  state: CoordinatorHandoffState | 'CANCELLED';
  startedAt: string;
  failureCode: CoordinatorHandoffFailureCode | null;
  failureReason: string | null;
  handedOverToSessionId: string | null;
  /** The moved waits once COMPLETED, `[]` before. */
  movedWaits: CoordinatorPendingWait[];
}

/** The sentence a FAILED handoff shows for a code. */
export function coordinatorHandoffFailureSentence(code: CoordinatorHandoffFailureCode): string {
  return `The handoff note wasn't written: ${COORDINATOR_HANDOFF_FAILURE_REASONS[code]}`;
}

/** Board 02's copy, verbatim, for the clients that draw it. */
export const COORDINATOR_HANDOFF_COPY = {
  confirmTitle: 'Hand over to a new coordinator?',
  confirmBody: (projectTitle: string) =>
    `This coordinator writes a handoff note, then ${projectTitle} continues in a new conversation that starts from that note. This one is completed — nothing is deleted.`,
  /** The confirm body while a turn is running. */
  confirmBodyWhileRunning: (projectTitle: string) =>
    `After the current turn ends, this coordinator writes a handoff note, then ${projectTitle} continues in a new conversation that starts from that note. This one is completed — nothing is deleted.`,
  noteRowTitle: 'Handoff note',
  noteRowDetail: 'Written by this coordinator before it hands over. Usually under a minute.',
  /** Hidden when there are no waits. */
  waitsRowTitle: (count: number) => (count === 1 ? '1 pending wait moves over' : `${count} pending waits move over`),
  cancel: 'Cancel',
  handOver: 'Hand over',
  badgeHandingOver: 'Handing over',
  writing: 'Writing the handoff note',
  compacting: 'Compacting…',
  skipNote: 'Skip the note',
  cancelHandover: 'Cancel handover',
  handingOver: 'Handing over to a new coordinator…',
  noteCardTitle: 'Handoff from the previous coordinator',
  waitsMovedHere: (count: number) => (count === 1 ? '1 wait moved here' : `${count} waits moved here`),
  handedOver: 'Handed over to a new coordinator.',
  openIt: 'Open it',
  tryAgain: 'Try again',
  handOverWithoutNote: 'Hand over without a note',
  keepThisCoordinator: 'Keep this coordinator',
} as const;
