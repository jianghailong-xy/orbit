/** A user turn the API accepted but whose durable `user` event has not reached this tab yet. */
export interface AcceptedUserTurn {
  key: string;
  sessionId: string;
  /** Local POST acknowledgements outlive stale REST reads; recovered rows follow active snapshots. */
  source: 'local' | 'activeSnapshot';
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
  // Only the durable user event replaces the optimistic user bubble. The runner can attach the
  // turn id before it publishes that opening event, so a system/context event with the same id is
  // not sufficient proof and must not make a newly accepted local message flicker away.
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

/**
 * Reconcile one successful `view=active` snapshot into the optimistic accepted-turn list.
 *
 * The snapshot owns only rows recovered from an earlier active snapshot, and may remove such a row
 * only when it already existed when this request began. Local POST acknowledgements remain until
 * their matching durable user event or terminal boundary arrives: the API can observe that event
 * before this tab's SSE does, and an empty response must not cause a visible gap. Opening prompts
 * are also preserved because the endpoint deliberately omits the synthetic initial turn.
 */
export function reconcileAcceptedUserTurnSnapshot(
  snapshot: readonly AcceptedUserTurn[],
  current: readonly AcceptedUserTurn[],
  sessionId: string,
  knownBefore: ReadonlySet<string>,
): AcceptedUserTurn[] {
  const next = current.filter((turn) => turn.sessionId !== sessionId);
  const included = new Set<string>();
  const localByKey = new Map(
    current
      .filter((turn) => turn.sessionId === sessionId && turn.source === 'local')
      .map((turn) => [turn.key, turn]),
  );

  for (const turn of snapshot) {
    if (included.has(turn.key)) continue;
    // A server copy must not downgrade a local acknowledgement into a snapshot-owned entry. The
    // API can observe the durable user event before this tab receives its SSE; if the following
    // snapshot then omits the row, the local bubble still has to bridge that last network gap.
    next.push(localByKey.get(turn.key) ?? turn);
    included.add(turn.key);
  }

  for (const turn of current) {
    if (turn.sessionId !== sessionId || included.has(turn.key)) continue;
    // The initial create turn is outside the active snapshot's contract, so REST absence says
    // nothing about it. An id-backed entry that was known before the request is absent from an
    // authoritative response and is therefore no longer active.
    if (
      turn.turnId !== undefined &&
      turn.source === 'activeSnapshot' &&
      knownBefore.has(turn.key)
    )
      continue;
    next.push(turn);
    included.add(turn.key);
  }

  return next.slice(-32);
}

/** Remove the optimistic bubble for the turn whose durable terminal boundary just arrived. */
export function clearAcceptedUserTurnsForTurn(
  current: AcceptedUserTurn[],
  sessionId: string,
  turnId?: string | null,
): AcceptedUserTurn[] {
  if (!turnId) return current;
  const next = current.filter(
    (turn) => turn.sessionId !== sessionId || turn.turnId !== turnId,
  );
  return next.length === current.length ? current : next;
}

/** A final session signal means no accepted turn in that session can still be in flight. */
export function clearAcceptedUserTurnsForSession(
  current: AcceptedUserTurn[],
  sessionId: string,
): AcceptedUserTurn[] {
  const next = current.filter((turn) => turn.sessionId !== sessionId);
  return next.length === current.length ? current : next;
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
