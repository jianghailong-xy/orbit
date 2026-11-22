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
 * start, skip and retry take an optional body `CoordinatorHandoffRequest`: what the successor runs on.
 *
 * STATE ON SESSIONS: `GET /sessions/:id` and the realtime `session.updated` summary carry
 * `coordinatorHandoff` (on the outgoing coordinator) and `coordinatorHandoffReceived` (on its
 * successor), each null when there is nothing to show. Every transition publishes `session.updated`
 * for both sessions it touches, so an open client re-reads them.
 */

/** Every note turn's `clientTurnId` starts here: a platform turn, not the owner's message. */
export const COORDINATOR_HANDOFF_TURN_PREFIX = 'coordinator-handoff:v1:';

/** The note turn's first line. Its user event carries no turn key, so clients tell the platform's
 *  prompt by this line and keep it out of the transcript. */
export const COORDINATOR_HANDOFF_PROMPT_HEAD = 'From Orbit · handoff note';

/** The four sections the note is asked for, in order, as the successor's card titles them. Owner rulings are
 *  project records (`project_ruling`, coordinator handoff v2 §2): the note turn records them first, so "Rulings
 *  not yet recorded" is normally empty. */
export const COORDINATOR_HANDOFF_SECTIONS = [
  'Where things stand',
  'Rulings not yet recorded',
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
  | 'REPLACE_FAILED'
  /** The note turn never reached the engine: this coordinator's own model could not start. Only when no
   *  successor was picked; with one, the handover goes on without a note. */
  | 'COORDINATOR_CANT_RUN';

/** The end of "The handoff note wasn't written: …", per code. */
export const COORDINATOR_HANDOFF_FAILURE_REASONS: Readonly<Record<CoordinatorHandoffFailureCode, string>> = {
  TURN_FAILED: 'the turn failed.',
  TURN_STOPPED: 'the turn was stopped.',
  TIMED_OUT: 'the turn timed out.',
  EMPTY_NOTE: 'the reply was empty.',
  REPLACE_FAILED: 'the new coordinator could not be opened.',
  COORDINATOR_CANT_RUN: 'the model of this coordinator could not start. Pick another model and hand over without a note.',
};

/**
 * What kind of pending work a `CoordinatorPendingWait` is (docs/coordinator-handoff-v2-design.md §1):
 *
 *   WATCH     — a `task_await` or a watch; it moves to the successor in the swap.
 *   SUBAGENT  — a running `delegate` run owing its coordinator a wake; it keeps running where it is, and its
 *               wake goes to the successor ("Started by the previous coordinator: …").
 *   JOB       — a running `bg_run` job; the same as a SubAgent run.
 *   WAKEUP    — the pending `schedule_wakeup`; it moves in the swap and keeps its due time.
 *   LOOP      — the running wakeup loop; it moves in the swap and keeps its schedule.
 */
export type CoordinatorPendingWaitKind = 'WATCH' | 'SUBAGENT' | 'JOB' | 'WAKEUP' | 'LOOP';

/** One piece of pending work the outgoing coordinator has, as the confirm dialog and the successor's "N waits
 *  moved here" list name it. A PAUSED watch moves too and stays paused. */
export interface CoordinatorPendingWait {
  /** The watch's, run's, wakeup's or loop's id; a bg_run job's `bgj_…` id. */
  id: string;
  /** Added with v2: what kind of work it is. A client that predates it ignores it; a handoff recorded
   *  before it was added reads as WATCH. */
  kind: CoordinatorPendingWaitKind;
  /** e.g. `Waiting for "Fix login redirect" to be DONE`, or a run's or job's description such as
   *  "Deploy 55a189aa3 to production". */
  label: string;
  /** True for a PAUSED watch: it moves and stays paused. False for every other kind. */
  paused: boolean;
}

/**
 * The words after a wait's label naming its kind ("Deploy 55a189aa3 to production · SubAgent"); null for a
 * watch, whose label already says what it waits for, so a watch — and a wait from a server without `kind` —
 * reads as it did before kinds.
 */
export const COORDINATOR_PENDING_WAIT_KIND_LABELS: Readonly<Record<CoordinatorPendingWaitKind, string | null>> = {
  WATCH: null,
  SUBAGENT: 'SubAgent',
  JOB: 'Background job',
  WAKEUP: 'Scheduled wakeup',
  LOOP: 'Wakeup loop',
};

/** One wait as the confirm dialog and the moved-here list name it: its label, " (paused)" when paused, then
 *  " · <kind>" unless it is a watch. A missing or unknown kind reads as a watch. */
export function coordinatorPendingWaitLine(wait: Pick<CoordinatorPendingWait, 'label' | 'paused'> & { kind?: string | null }): string {
  const kind = wait.kind ? COORDINATOR_PENDING_WAIT_KIND_LABELS[wait.kind as CoordinatorPendingWaitKind] ?? null : null;
  return `${wait.label}${wait.paused ? ' (paused)' : ''}${kind ? ` · ${kind}` : ''}`;
}

/**
 * What the successor runs on, as the owner names it in the confirm dialog or beside Hand over without a note.
 * Each field as `POST /sessions` takes it (engine, provider slug, model id). All absent or null keeps the
 * previous coordinator's engine, provider and model, which is what a handoff did before this existed. Pick
 * another when the current one is the reason for handing over: a provider whose sign-in failed, an engine
 * that will not start.
 */
export interface CoordinatorHandoffSuccessor {
  engine?: string | null;
  provider?: string | null;
  model?: string | null;
}

/** The body of `POST …/handoff`, `…/handoff/skip` and `…/handoff/retry`. A successor named here replaces the
 *  one named earlier in the same handoff; `successor: null` ("Same as this one") clears it; left out keeps it. Refused 400/409 up front when that start would be
 *  refused, so the current coordinator is never completed for a successor that cannot open. */
export interface CoordinatorHandoffRequest {
  successor?: CoordinatorHandoffSuccessor | null;
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
  /** What the owner named for the successor to run on; null when nothing was (it keeps this coordinator's).
   *  A client that predates it ignores it. */
  successor?: CoordinatorHandoffSuccessor | null;
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
  /** As on `SessionCoordinatorHandoff`. */
  successor?: CoordinatorHandoffSuccessor | null;
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
  /**
   * The note card's line counting what this conversation does not draw (handoff v2 §4, board 3):
   * the records stamped before it was created. Null when there are none, and the line is omitted.
   */
  historyBefore: (decisions: number, merges: number): string | null =>
    decisions === 0 && merges === 0 ? null : `${decisions} ${decisions === 1 ? 'decision' : 'decisions'} and ${merges} ${merges === 1 ? 'merge' : 'merges'} before this conversation`,
  openPrevious: 'Open previous coordinator',
  handedOver: 'Handed over to a new coordinator.',
  openIt: 'Open it',
  tryAgain: 'Try again',
  handOverWithoutNote: 'Hand over without a note',
  keepThisCoordinator: 'Keep this coordinator',
  /** The successor's model row in the confirm dialog and under a failed handoff. */
  successorRowTitle: 'New coordinator runs on',
  successorKeep: 'Same as this one',
  successorRowDetail: "Pick another if this one's model or provider has stopped working.",
  /** A handoff press the server refused: the toast's title on web, the lead of the line on the phones and the Mac. */
  refused: "Couldn't hand over",
} as const;

/**
 * The phones' confirm body (board 03 iOS 2), on iOS and Android alike: board 02's confirm without the note row and the
 * wait names, the waits as a count only, and no count when there are none.
 */
export function coordinatorHandoffPhoneConfirmBody(waits: number, running: boolean): string {
  const lead = running ? 'After the current turn ends, this coordinator writes a handoff note' : 'This coordinator writes a handoff note';
  const moves = waits > 0 ? ` ${COORDINATOR_HANDOFF_COPY.waitsRowTitle(waits)}.` : '';
  return `${lead}, then the project continues in a new conversation.${moves} Nothing is deleted.`;
}
