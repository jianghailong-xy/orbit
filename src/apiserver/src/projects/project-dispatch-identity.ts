import { createHash } from 'node:crypto';

/**
 * The ids a dispatch REQUEST intends to write, derived from the request's own permanent identity
 * instead of minted fresh per execution.
 *
 * WHAT THIS BUYS, precisely — because the neighbouring mechanism already covers more than it looks
 * like it does. §8.3's ledger makes the dispatch exactly-once and its replay answer
 * (`ALREADY_APPLIED` carrying `result_session_id`) is read off a durable column, so a request whose
 * response was lost already gets its own Session back, whatever status that Session has reached by
 * then. None of that needed a derived id and none of it changes here.
 *
 * What a random id could not do is make the Session **nameable without the answer**:
 *
 *  - the id is now a pure function of the request, so a recovery that never received either
 *    response — an operator, a later pass, a different process — can compute the row to look for
 *    instead of searching for it. "The newest Session on this task" and "the one that is live" are
 *    the two searches that were available before, and both are properties that move WHILE the
 *    lookup is being made: the first hands a request somebody else's run, and the second reports a
 *    winner that has already finished as ABSENT;
 *  - the whole INSERT becomes a function of the request, so a re-execution that collides collides
 *    with a row identical to the one it was about to write, rather than with a different one.
 *
 * The cost is a collision this code did not have before — the PRIMARY KEY is now reachable — and
 * paying it honestly is what `claimConflictedDispatch` is for: §8.5 C1 forbids ANY of these
 * conflicts from arriving as an exception, so the insert stops inferring an index and the answer
 * is decided by reading.
 *
 * The key is §8.2's action idempotency key, which IS the request: permanent, advancing only when
 * the work is genuinely a new attempt (DA1/DA2), never going backwards. An `actionId` would be a
 * fresh value per claim and defeat the whole point.
 *
 * Shaped as a name-based UUID rather than left as raw digest bytes: `session.id` is `uuid` in
 * PostgreSQL, and a reader who looks at the version nibble can tell this id was DERIVED from a name
 * rather than drawn at random. That is the difference between "two ids happen to match" and "these
 * are the same request". The digest is SHA-256 truncated to 16 bytes, not RFC 9562's SHA-1, so this
 * is v5's SHAPE and not a v5 anybody can recompute from the spec alone — deliberate, because the
 * name being hashed is an internal key and the only recomputation that matters is this function's.
 */
export function dispatchDesiredSessionId(idempotencyKey: string): string {
  return derivedUuid(`pc:v1:dispatch:session:${idempotencyKey}`);
}

/**
 * The runtime (engine-side) id for the same Session, derived from the same key so the WHOLE insert
 * is a function of the request: a second execution that lands the row lands the same bytes, and one
 * that collides collides with a row identical to the one it was about to write.
 *
 * A separate namespace from the id above, so the two can never coincide.
 */
export function dispatchRuntimeSessionId(idempotencyKey: string): string {
  return derivedUuid(`pc:v1:dispatch:runtime-session:${idempotencyKey}`);
}

/**
 * A name folded into a UUID. Exported because the legacy task-run entrances derive their Session
 * id the same way (see `tasks/task-run-identity.ts`): one derivation, two namespaces, so a reader
 * comparing an id from either door is comparing the same shape.
 */
export function derivedUuid(name: string): string {
  const bytes = createHash('sha256').update(name).digest().subarray(0, 16);
  // RFC 9562 §4.2's version/variant fields: 5 (name-based) and 10x. See the note above on why the
  // digest is SHA-256 rather than the SHA-1 a literal v5 would use.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
