/**
 * The cards five more of Orbit's own turns are drawn as, rather than as the reader's bubble or an
 * empty bubble with the block folded under it (docs/mocks/orbit-turn-cards/). Each is read by the
 * turn's own key from the rows the block was rendered from, and carried on the `user` event's payload
 * under the field name of the same spelling, and on the queued and active turn rows.
 */

/** `evidence-review:v1:` — a revision handed to the session that dispatched its task. */
export interface EvidenceReviewCard {
  evidenceId: string;
  taskId: string;
  title: string;
  revision: string;
  runSessionId: string;
  /** When the owner is asked if this session has not decided; null until the turn is handed out. */
  dueAt: string | null;
  /** What the run claims, as its evidence envelope states it; null for an unstructured revision. */
  claim: string | null;
  /**
   * OPEN: waiting for a decision. SUPERSEDED: a later revision is the one waiting (`latestRevision`).
   * DECIDED: answered (`decision`). CLOSED: the task is neither OPEN nor IN_PROGRESS any more.
   */
  state: 'OPEN' | 'SUPERSEDED' | 'DECIDED' | 'CLOSED';
  latestRevision: string;
  decision: 'CONFIRM' | 'SEND_BACK' | null;
}

/** `evidence-send-back:v1:` — a send-back's note handed to the run that submitted the revision. */
export interface EvidenceSendBackCard {
  decisionId: string;
  taskId: string;
  title: string;
  revision: string;
  note: string;
  /** OWNER: the account owner pressed Send back. SESSION: a session decided (`bySessionId` when known). */
  by: 'OWNER' | 'SESSION';
  bySessionId: string | null;
  byTitle: string | null;
}

/** `run-question:v1:` — a task run's question routed to its project's coordinator. */
export interface RunQuestionCard {
  requestId: string;
  approvalId: string;
  taskId: string | null;
  taskTitle: string;
  runSessionId: string;
  replyBy: string;
  /** The request's state: OPEN, REPLIED (this session answered), OWNER_ANSWERED, NO_REPLY, UNDELIVERED… */
  state: string;
  approvalStatus: string;
  questions: Array<{
    question: string;
    multiSelect?: boolean;
    options?: Array<{ label: string; description?: string }>;
  }>;
  /** What was answered, keyed by question text, once answered. */
  answers: Record<string, string[]> | null;
  /** SESSION: the coordinator answered it. OWNER: the account owner did. Null while unanswered. */
  answeredBy: 'SESSION' | 'OWNER' | null;
}

/** How much of a run's `notify` message is stored and handed to its coordinator. */
export const RUN_NOTICE_MESSAGE_MAX = 2000;

/** `run-notify:v1:` — a task run's notify, which reaches its coordinator and not the owner. */
export interface RunNoticeCard {
  requestId: string;
  taskId: string | null;
  taskTitle: string;
  runSessionId: string;
  message: string;
  state: string;
}

/**
 * The opening turn of a session Orbit opened with a prompt of its own (`session.prompt_by_orbit`):
 * drawn as one line saying why, with the brief folded under it.
 */
export interface SessionOpeningCard {
  kind: 'COORDINATOR' | 'JUDGMENT' | 'DISPATCH' | 'MENTION' | 'OTHER';
  /** What the session was opened for: the project it coordinates or judges for, the task a judgment
   *  or a mention is about, the list it dispatches. Null when it cannot be read any more. */
  target: { kind: 'PROJECT' | 'TASK' | 'LIST'; id: string; title: string } | null;
  /** The owner's comment, for a mention's reply: their own words, shown as theirs. */
  mention: string | null;
}
