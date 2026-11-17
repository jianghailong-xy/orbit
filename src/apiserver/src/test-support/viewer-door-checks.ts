/**
 * docs/session-viewer-stream-design.md §4 as negative assertions: what a viewer stream (the guest door's
 * `/guest-sessions/:id/stream`, a public link's `/shared/:token/stream` and `/shared/:token/sessions/:id/stream`) may
 * carry, held against the paged read of the same door. One check, so both doors — paged read and stream — are held
 * to the same set: session-guests/session-guests-projection.pg.spec.ts (a guest, a session link with tool output and
 * a task link without, over the production apiserver) and shared/public-surface.pg.spec.ts (the public door's
 * harness) both call it.
 *
 * A stream never carries a field or an event type its read does not:
 *   - a durable frame is an event the read returns, at the same seq, with the same type and payload, and no key the
 *     read's event lacks;
 *   - a live-only frame is one of the allow-list — deltas, resync and ping always; tool_output and background_output
 *     only where the read shows tool output — with no key beyond an event's;
 *   - a `head` frame holds exactly the fields of the read's `events?after=` header;
 *   - approvals, queued_turns_changed, translation, task_progress, tombstone, status, session_updated: never;
 *   - and the red line (share-red-line.ts): no planted value in any frame's text, no red-line field in any envelope.
 */
import { isDeepStrictEqual } from 'node:util';
import { RED_LINE_FIELDS, keysOf } from './share-red-line';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** Event types no viewer stream ever carries, whatever the audience. */
export const NEVER_ON_A_VIEWER_STREAM: readonly string[] = [
  'approval_request', 'approval_resolved', 'queued_turns_changed', 'translation', 'task_progress', 'tombstone',
  'status', 'session_updated',
];

const LIVE_ALWAYS = new Set(['text_delta', 'thinking_delta', 'resync', 'ping']);
const LIVE_TOOL_OUTPUT = new Set(['tool_output', 'background_output']);
/** The keys a stream frame may have: a paged read's event's (`truncated` only when trimmed; `turnPublicId` the twin
 *  PublicIdInterceptor adds to both). */
const EVENT_KEYS = new Set(['seq', 'type', 'payload', 'turnId', 'turnPublicId', 'ts', 'truncated']);

export interface ViewerDoor {
  /** Every event the door's paged reads return for the session (`events?after=0`, `events`, …), by seq. */
  readEvents: Json[];
  /** The door's `events?after=` answer without `events` and `after`: what a head frame must say. */
  readHeader: Json;
  /** Whether the read shows tool output (a guest, or a link with Tool output on). */
  toolOutput: boolean;
  /** The stream's frames, parsed, and their text as sent. */
  frames: Json[];
  texts: string[];
  /** Values that must reach neither the read nor the stream. */
  neverShown: readonly string[];
}

/** Every way the stream crosses its read: empty when it holds. */
export function viewerStreamCrossings(door: ViewerDoor): string[] {
  const problems: string[] = [];
  const bySeq = new Map(door.readEvents.map((e) => [e.seq as number, e]));
  const headerKeys = Object.keys(door.readHeader).sort();
  door.frames.forEach((frame, i) => {
    const at = `frame ${i} (${frame.type}, seq ${frame.seq})`;
    const keys = Object.keys(frame);
    if (NEVER_ON_A_VIEWER_STREAM.includes(frame.type)) problems.push(`${at}: a type no viewer stream carries`);
    if (frame.type === 'head') {
      const extra = keys.filter((k) => !['seq', 'type', 'payload'].includes(k));
      if (extra.length) problems.push(`${at}: envelope keys ${extra.join(', ')}`);
      const got = Object.keys(frame.payload ?? {}).sort();
      if (!isDeepStrictEqual(got, headerKeys)) problems.push(`${at}: head fields ${got.join(',')} ≠ the read's header ${headerKeys.join(',')}`);
      const red = RED_LINE_FIELDS.filter((f) => keysOf(frame.payload).has(f));
      if (red.length) problems.push(`${at}: red-line fields ${red.join(', ')}`);
      return;
    }
    const extra = keys.filter((k) => !EVENT_KEYS.has(k));
    if (extra.length) problems.push(`${at}: keys ${extra.join(', ')} no read event has`);
    if (LIVE_ALWAYS.has(frame.type)) return;
    if (LIVE_TOOL_OUTPUT.has(frame.type)) {
      if (!door.toolOutput) problems.push(`${at}: tool output on a door without it`);
      return;
    }
    const read = bySeq.get(frame.seq);
    if (!read) {
      problems.push(`${at}: no event of the read at this seq`);
      return;
    }
    if (read.type !== frame.type) problems.push(`${at}: the read has ${read.type} there`);
    const missing = keys.filter((k) => !(k in read));
    if (missing.length) problems.push(`${at}: keys ${missing.join(', ')} the read's event lacks`);
    if (!isDeepStrictEqual(frame.payload, read.payload)) {
      problems.push(`${at}: payload ${JSON.stringify(frame.payload).slice(0, 200)} ≠ the read's ${JSON.stringify(read.payload).slice(0, 200)}`);
    }
  });
  door.texts.forEach((text, i) => {
    const found = door.neverShown.filter((value) => text.includes(value));
    if (found.length) problems.push(`frame ${i}: carries ${found.join(', ')}`);
  });
  return problems;
}
