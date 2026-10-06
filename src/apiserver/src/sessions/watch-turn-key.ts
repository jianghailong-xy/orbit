import { BadRequestException } from '@nestjs/common';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from '../tasks/executable-acceptance-round';

/**
 * The namespace the Watch delivery worker queues its wakes in: `watch:<watchId>:<generation>` for a
 * Match, and `watch:<watchId>:expired` / `:revoked` / `:unresolvable` for a watch that ended unmatched
 * (docs/watch-contract.md §6; the keys themselves are written by watch-delivery.service.ts).
 */
export const WATCH_TURN_KEY_PREFIX = 'watch:';

/**
 * The namespace the platform hands a session request's outcome back in (sessions/session-request.ts,
 * docs/session-request-reply-contract.md §4.2). Spelled here, not imported from there, for the reason
 * the guard below lives here: every door imports this file, and it must not drag the request module in.
 */
export const SESSION_REPLY_TURN_KEY_PREFIX = 'session-reply:';

/**
 * The namespace the auto-retry sweep re-sends a failed message under (sessions/auto-retry.service.ts).
 * A re-send of another session's message keeps its sender, and is the platform's re-send rather than
 * a message that session sent again (docs/session-request-reply-contract.md §2.1). Reserved so that a
 * turn under it is always the platform's own re-send, as a turn under the two prefixes above is always
 * the platform's own delivery.
 */
export const AUTO_RETRY_TURN_KEY_PREFIX = 'auto-retry:';

/**
 * The three namespaces a confirmation request's review is carried in
 * (docs/owner-confirmation-review-contract.md §10 G6, tasks/owner-confirmation-review-turn.ts): the
 * request handed to its reviewer, the reviewer's return handed to the run, and the owner's answers
 * handed back to the reviewer. Each key is derived from the row it carries, so a caller who took one
 * would stand between that row and its only delivery. Spelled here for the reason the reply prefix
 * is.
 */
export const OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX = 'owner-confirmation-review:v1:';
export const CONFIRMATION_RETURN_TURN_KEY_PREFIX = 'confirmation-return:v1:';
export const OWNER_CONFIRMATION_ANSWERS_TURN_KEY_PREFIX = 'owner-confirmation-answers:v1:';

/**
 * The namespace an evidence revision of a task filed outside any project is handed to the session
 * that dispatched it in, for that session to decide (tasks/evidence-review.ts). Keyed by the evidence
 * row, for the reason the three above are.
 */
export const EVIDENCE_REVIEW_TURN_KEY_PREFIX = 'evidence-review:v1:';

/** Every prefix a caller's own `clientTurnId` may not start with. */
const RESERVED_TURN_KEY_PREFIXES = [
  WATCH_TURN_KEY_PREFIX,
  SESSION_REPLY_TURN_KEY_PREFIX,
  AUTO_RETRY_TURN_KEY_PREFIX,
  OWNER_CONFIRMATION_REVIEW_TURN_KEY_PREFIX,
  CONFIRMATION_RETURN_TURN_KEY_PREFIX,
  OWNER_CONFIRMATION_ANSWERS_TURN_KEY_PREFIX,
  EVIDENCE_REVIEW_TURN_KEY_PREFIX,
  // A shell turn under it is delivered to the runner as the task's EXECUTABLE acceptance command
  // (`taskAcceptance`), which the runner executes itself even where a person's `!` shell is refused
  // (DeepSeek Harness, P5), and whose exit code is judged against the task. Only the server queues one.
  TASK_ACCEPTANCE_CLIENT_TURN_PREFIX,
] as const;

/**
 * Refuse a caller-supplied `clientTurnId` that reaches into the wake namespace — or into the one the
 * outcomes of session requests are handed back in, for the same reason: a reply turn coalesces the
 * outcomes that arrive while it is queued by finding the asker's queued turn under that prefix, so a
 * message queued under it would be taken for one, and outcomes filed onto it would be delivered as
 * whatever its author wrote.
 *
 * `clientTurnId` is the caller's own choice at every door onto a session, and `conversation_turn` has
 * UNIQUE (session_id, client_turn_id) — the same uniqueness that makes a redelivered wake collapse onto
 * the turn already queued instead of waking the observer twice. So a client that queues an ordinary
 * message under a key the worker is about to write takes that key: the wake can no longer be queued
 * under it, and its delivery becomes a `WAKE_KEY_TAKEN` dead letter (watch-delivery.service.ts). The
 * observer is never woken, and the message doing it need not be hostile — an agent repeating a key it
 * read out of a transcript is enough.
 *
 * Refused at the door, and refused rather than quietly rewritten: a caller whose idempotency key came
 * back changed could not retry under the key it chose, which is the one thing the key is for.
 *
 * Doors only. The worker reaches `SessionsService.createTurn` directly and must keep writing these keys,
 * so this cannot move down into the service — that would refuse the wakes themselves.
 */
export function assertClientTurnIdNotReserved(clientTurnId: string | undefined | null): void {
  const reserved = RESERVED_TURN_KEY_PREFIXES.find((prefix) => clientTurnId?.startsWith(prefix));
  if (reserved === WATCH_TURN_KEY_PREFIX) {
    throw new BadRequestException(
      `clientTurnId must not start with "${WATCH_TURN_KEY_PREFIX}" — that prefix is reserved for the Watch wakes the server queues itself (docs/watch-contract.md §6). Choose your own key, such as a UUID.`,
    );
  }
  if (reserved === SESSION_REPLY_TURN_KEY_PREFIX) {
    throw new BadRequestException(
      `clientTurnId must not start with "${SESSION_REPLY_TURN_KEY_PREFIX}" — that prefix is reserved for the replies to session requests the server hands back itself (docs/session-request-reply-contract.md §4.2). Choose your own key, such as a UUID.`,
    );
  }
  if (reserved === AUTO_RETRY_TURN_KEY_PREFIX) {
    throw new BadRequestException(
      `clientTurnId must not start with "${AUTO_RETRY_TURN_KEY_PREFIX}" — that prefix is reserved for the messages the server re-sends itself after a failed turn (docs/session-request-reply-contract.md §2.1). Choose your own key, such as a UUID.`,
    );
  }
  if (reserved === TASK_ACCEPTANCE_CLIENT_TURN_PREFIX) {
    throw new BadRequestException(
      `clientTurnId must not start with "${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}" — that prefix is reserved for the EXECUTABLE acceptance rounds the server queues itself (docs/task-completion-criteria.md). Choose your own key, such as a UUID.`,
    );
  }
  if (reserved) {
    throw new BadRequestException(
      `clientTurnId must not start with "${reserved}" — that prefix is reserved for the confirmation and evidence reviews the server delivers itself (docs/owner-confirmation-review-contract.md §10 G6, docs/task-completion-criteria.md). Choose your own key, such as a UUID.`,
    );
  }
}
