import { BadRequestException } from '@nestjs/common';

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

/** Every prefix a caller's own `clientTurnId` may not start with. */
const RESERVED_TURN_KEY_PREFIXES = [WATCH_TURN_KEY_PREFIX, SESSION_REPLY_TURN_KEY_PREFIX] as const;

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
}
