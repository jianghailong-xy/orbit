/**
 * Broadcast-only output snapshots for foreground user shells.
 *
 * Unlike a text delta, every `tool_output` carries the whole output currently retained by the
 * runner. Replacing the value (rather than appending it) avoids duplicate prefixes and lets an
 * empty/reset snapshot clear text that was previously visible. These snapshots deliberately stay
 * outside the persisted transcript event list; the durable `tool_result` is authoritative.
 */
export type LiveToolOutput = {
  content: unknown;
  /** Runner-originated monotonic version. Absent on snapshots from older runners. */
  snapshotSeq?: number;
};

export type LiveToolOutputs = ReadonlyMap<string, LiveToolOutput>;

export type SessionLiveToolOutputs = {
  sessionId: string | null;
  outputs: LiveToolOutputs;
};

export const EMPTY_LIVE_TOOL_OUTPUTS: LiveToolOutputs = new Map();

type ToolOutputEvent = {
  type: string;
  payload?: Record<string, unknown> | null;
};

function toolUseId(payload: Record<string, unknown>): string | undefined {
  const value = payload.toolUseId ?? payload.tool_use_id;
  return typeof value === 'string' && value.startsWith('shell-') ? value : undefined;
}

function snapshotSeq(payload: Record<string, unknown>): number | undefined {
  const value = payload.snapshotSeq;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Apply one SSE event to the current live-output snapshot map. */
export function reduceLiveToolOutputs(
  current: LiveToolOutputs,
  event: ToolOutputEvent,
): LiveToolOutputs {
  const payload = event.payload ?? {};
  const id = toolUseId(payload);

  if (event.type === 'tool_output') {
    // Missing content is a malformed event; an explicitly empty snapshot is meaningful and must
    // replace the previous text.
    if (!id || !Object.prototype.hasOwnProperty.call(payload, 'content')) return current;
    const content = payload.content;
    const version = snapshotSeq(payload);
    const previous = current.get(id);
    // Cross-replica delivery can reorder transient NOTIFY messages. Versioned snapshots are
    // monotonic per tool, so an equal/older one must never roll the console backwards. Once a
    // versioned snapshot has landed, an unversioned one is unorderable and cannot replace it.
    // A runner whose whole stream predates snapshotSeq still gets arrival-order behavior.
    if (
      previous?.snapshotSeq !== undefined &&
      (version === undefined || version <= previous.snapshotSeq)
    ) {
      return current;
    }
    if (previous && previous.content === content && previous.snapshotSeq === version) {
      return current;
    }
    const next = new Map(current);
    next.set(id, {
      content,
      ...(version === undefined ? {} : { snapshotSeq: version }),
    });
    return next;
  }

  if (event.type === 'tool_result' && id && current.has(id)) {
    const next = new Map(current);
    next.delete(id);
    return next.size > 0 ? next : EMPTY_LIVE_TOOL_OUTPUTS;
  }

  // No transient shell output should survive the boundary of the turn/run that produced it. A
  // resumed runtime is a new generation whose runner-local snapshot sequence may start over.
  if (
    (
      event.type === 'turn_end' ||
      payload.final === true ||
      (event.type === 'system' && payload.subtype === 'resumed')
    ) &&
    current.size > 0
  ) {
    return EMPTY_LIVE_TOOL_OUTPUTS;
  }

  return current;
}

/** Clear missed-SSE animation when polling says this session is idle or terminal. */
export function clearLiveToolOutputsForSession(
  current: SessionLiveToolOutputs,
  sessionId: string | null,
): SessionLiveToolOutputs {
  if (current.sessionId !== sessionId || current.outputs.size === 0) return current;
  return { sessionId, outputs: EMPTY_LIVE_TOOL_OUTPUTS };
}
