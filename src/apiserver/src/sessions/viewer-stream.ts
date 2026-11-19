import { RunEventType } from '@orbit/shared';
import { isReplayableEvent } from '../common/system-noise';
import { withoutToolOutput } from '../share-links/share-link';
import type { StreamedEvent } from './session-stream';

/**
 * The viewer projection (docs/session-viewer-stream-design.md §4): what a session's stream shows someone who is not
 * its owner. Two audiences — a guest (the guest door, `/guest-sessions/:id/stream`), who reads what a public link
 * with Tool calls and output on reads, and a public link's visitor (`/shared/:token/…/stream`), who reads what the
 * link's `include.toolOutput` allows. Neither is ever shown more than the matching paged read gives.
 */
export type ViewerAudience = { kind: 'GUEST' } | { kind: 'PUBLIC'; toolOutput: boolean };

/** Whether this audience reads tool output: a guest always, a visitor when the link includes it. */
export const showsToolOutput = (audience: ViewerAudience): boolean =>
  audience.kind === 'GUEST' || audience.toolOutput;

/**
 * Live-only events a viewer is shown: an ALLOW-list, so a live type added later stays out of every viewer stream
 * until somebody adds it here on purpose (and to viewer-stream.pg.spec.ts). `ping` is the keepalive's frame.
 */
export const VIEWER_LIVE_ALWAYS: ReadonlySet<string> = new Set<string>([
  RunEventType.TEXT_DELTA,
  RunEventType.THINKING_DELTA,
  RunEventType.RESYNC,
  'ping',
]);

/** Live-only events shown only to an audience that reads tool output (showsToolOutput). */
export const VIEWER_LIVE_WITH_TOOL_OUTPUT: ReadonlySet<string> = new Set<string>([
  RunEventType.TOOL_OUTPUT,
  RunEventType.BACKGROUND_OUTPUT,
]);

/**
 * Live events that change what the head says (§4 `head`): a status change and an approval card opening or closing.
 * None of them is ever shown as itself; each makes the stream re-read its head. A rename reaches the stream as
 * `session_updated`, on its own feed (RealtimeService.sessionUpdatesForRun).
 */
export const HEAD_TRIGGERS: ReadonlySet<string> = new Set<string>([
  RunEventType.STATUS,
  RunEventType.APPROVAL_REQUEST,
  RunEventType.APPROVAL_RESOLVED,
]);

/** The one frame type only viewer streams carry: the session's head as the `events?after=` answer states it. */
export const HEAD_FRAME = 'head';

/**
 * A stored event's seq: positive and below the settlement sentinel (a settlement's STATUS rides
 * Number.MAX_SAFE_INTEGER, every other live-only event seq 0). Only such an event can be one a paged read returns.
 */
const storedSeq = (seq: number): boolean => Number.isSafeInteger(seq) && seq > 0 && seq < Number.MAX_SAFE_INTEGER;

/**
 * One event as this audience sees it, or null when it sees nothing of it.
 *
 *   - Live-only events only from the allow-lists above: deltas, resync and ping always; tool_output and
 *     background_output only with tool output. Approvals, queued_turns_changed, translation, task_progress,
 *     tombstone — and any live type nobody listed — never.
 *   - `status` never as itself (it becomes a head frame).
 *   - A durable event only when it is stored (storedSeq) and passes the predicate the paged reads filter with
 *     (`isReplayableEvent`, the JS spelling of `replayableEventSql`); for a link without tool output, through
 *     `withoutToolOutput`, as SharedController's `shown` does for the reads.
 *
 * Takes the event after truncation (truncate-payload), as the reads apply `withoutToolOutput` after theirs.
 */
export function viewerFrame<E extends StreamedEvent & { truncated?: true }>(audience: ViewerAudience, event: E): E | null {
  if (VIEWER_LIVE_ALWAYS.has(event.type)) return event;
  if (VIEWER_LIVE_WITH_TOOL_OUTPUT.has(event.type)) return showsToolOutput(audience) ? event : null;
  if (event.type === RunEventType.STATUS) return null;
  if (!storedSeq(event.seq) || !isReplayableEvent(event)) return null;
  return showsToolOutput(audience) ? event : withoutToolOutput(event);
}
