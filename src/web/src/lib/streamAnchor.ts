import { supersedesLiveDrafts } from './steerDelivery';

/**
 * Where the half-written reply belongs in the transcript.
 *
 * `text_delta` / `thinking_delta` are broadcast but never persisted, so they have no seq of their
 * own to be ordered by. They render straight after the last event at or before an anchor — the
 * seq the stream was at — because the two things that arrive DURING a stretch of generation
 * belong on opposite sides of it:
 *
 * - a message typed mid-turn is echoed back by the runner as a `user` event with a HIGHER seq
 *   than anything on screen. It must land BELOW the growing bubble, or a pane pinned to the tail
 *   pushes it out of sight the moment it is sent. So the anchor does not follow it.
 * - a tool call the model makes between one thought and the next reply is also a later seq, but
 *   it is part of the same reply and belongs ABOVE the text that follows it. So the anchor does
 *   follow it — otherwise the answer explaining what a command found renders above the command.
 *
 * Session switches and a finalized session reset the anchor in the component that owns it; this
 * decides only what a live event does to it.
 */
export interface StreamAnchorEvent {
  type: string;
  seq: number;
  payload?: { subtype?: string; steer?: unknown } | null;
}

const ENGINE_OUTPUT = ['thinking', 'tool_use', 'tool_result'];

/**
 * The anchor after `ev`. `cursor` is the highest seq seen on this stream, which is where a
 * stretch of generation starts from when nothing has anchored it yet.
 */
export function streamAnchorAfter(
  anchor: number | null,
  ev: StreamAnchorEvent,
  cursor: number,
): number | null {
  // The first chunk of a stretch fixes where its bubble sits: at the cursor as it stands now.
  if (ev.type === 'text_delta' || ev.type === 'thinking_delta') return anchor ?? cursor;
  // Whatever superseded the drafts also ended the stretch they were anchored to: the next chunk
  // starts a new one and re-anchors at the cursor it finds. A `resumed` system event is the same
  // boundary for a turn that crashed and respawned without a turn_end.
  if (supersedesLiveDrafts(ev)) return null;
  if (ev.type === 'system') return ev.payload?.subtype === 'resumed' ? null : anchor;
  // Output of the same reply, durable now: a closed thinking block, and the tool calls the model
  // makes between one thought and the next. Anything still being generated follows them. An
  // anchor is only ever moved, never created — with nothing streaming the drafts render last, and
  // an anchor invented here would split an idle transcript through a run of folded tool calls.
  if (ENGINE_OUTPUT.includes(ev.type)) return anchor === null ? null : Math.max(anchor, ev.seq);
  return anchor;
}
