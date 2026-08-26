/** A user turn the API accepted but whose durable `user` event has not reached this tab yet. */
export interface AcceptedUserTurn {
  key: string;
  sessionId: string;
  /** Present for send/resume. A new session's lazily seeded opening turn has no id yet. */
  turnId?: string;
  text: string;
  acceptedAt: string;
  attachments: { id: string; mime?: string; name?: string }[];
}

export interface UserTurnEvent {
  seq: number;
  type: string;
  payload: unknown;
  turnId?: string | null;
  ts?: string;
}

interface QueuedTurnLike {
  turnId: string;
  /** A steer is already entering the running turn and cannot be withdrawn. */
  steer?: boolean;
}

/** Whether the server-backed event that replaces this optimistic turn has arrived. */
export function acceptedUserTurnLanded(
  turn: AcceptedUserTurn,
  eventSessionId: string | null,
  events: readonly UserTurnEvent[],
): boolean {
  if (eventSessionId !== turn.sessionId) return false;
  return events.some(
    (event) =>
      event.type === 'user' && (turn.turnId === undefined || event.turnId === turn.turnId),
  );
}

/** Build the transient event Transcript renders until acceptedUserTurnLanded becomes true. */
export function acceptedUserTurnEvent(
  turn: AcceptedUserTurn,
  seq: number,
): UserTurnEvent {
  return {
    seq,
    type: 'user',
    turnId: turn.turnId ?? turn.key,
    ts: turn.acceptedAt,
    payload: {
      text: turn.text,
      ...(turn.attachments.length ? { attachments: turn.attachments } : {}),
    },
  };
}

/** Do not paint a pending-queue copy of a turn already represented by Transcript. This makes the
 *  POST acknowledgement, queued-turn REST refresh, and durable SSE safe in every arrival order. */
export function queuedTurnsOutsideTranscript<T extends QueuedTurnLike>(
  queued: readonly T[],
  events: readonly UserTurnEvent[],
): T[] {
  const renderedTurnIds = new Set(
    events.flatMap((event) =>
      event.type === 'user' && typeof event.turnId === 'string' ? [event.turnId] : [],
    ),
  );
  return queued.filter((turn) => !renderedTurnIds.has(turn.turnId));
}

/** Reconcile a REST queue snapshot without letting an older in-flight fetch erase turns that were
 *  accepted locally after that fetch began. `representedTurnIds` includes accepted head rows that
 *  deliberately do not belong in the queued tail but still supersede a local queued copy. */
export function reconcileQueuedTurnSnapshot<T extends QueuedTurnLike>(
  snapshot: readonly T[],
  current: readonly T[],
  knownBefore: ReadonlySet<string>,
  representedTurnIds: ReadonlySet<string> = new Set(snapshot.map((turn) => turn.turnId)),
): T[] {
  const next = [...snapshot];
  const included = new Set(snapshot.map((turn) => turn.turnId));
  for (const turn of current) {
    // A steer can leave the active-turn endpoint when turnComplete wins just before the buffered
    // durable `user` event is flushed. REST absence cannot mean cancellation (steers are not
    // cancellable), so keep its local bubble until that matching event removes it. A server row
    // still supersedes it through representedTurnIds, e.g. if a refresh updates its metadata.
    if (turn.steer && !representedTurnIds.has(turn.turnId)) {
      if (!included.has(turn.turnId)) next.push(turn);
      included.add(turn.turnId);
      continue;
    }
    if (
      knownBefore.has(turn.turnId) ||
      representedTurnIds.has(turn.turnId) ||
      included.has(turn.turnId)
    )
      continue;
    next.push(turn);
    included.add(turn.turnId);
  }
  return next;
}
