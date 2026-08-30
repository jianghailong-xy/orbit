import {
  NormalizedRunEvent,
  RunEventType,
  TOOL_OUTPUT_SNAPSHOT_MAX_BYTES,
} from '@orbit/shared';

// Bound and restrict every live-event string outside `content` to JSON-safe ASCII. Normal runner
// values (UUIDs, `shell-${uuid}`, and its fixed ISO timestamp) pass unchanged; malformed input
// cannot spend the NOTIFY envelope on escapes before content gets there.
const TOOL_OUTPUT_ID_MAX_CHARS = 64;
const TOOL_OUTPUT_TURN_ID_MAX_CHARS = 64;
const TOOL_OUTPUT_TS_MAX_CHARS = 32;
const SAFE_WIRE_TOKEN = /[^A-Za-z0-9._:+-]/g;

function boundedWireToken(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(SAFE_WIRE_TOKEN, '').slice(0, maxChars);
}

/** Return the UTF-8 tail of text without splitting a multi-byte code point. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  // UTF-8 continuation bytes start 10xxxxxx. Advancing to the next leading byte keeps the
  // returned string valid and can only make it smaller than the requested limit.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

/**
 * Enforce the narrow, size-bounded wire contract of a live foreground-tool snapshot.
 *
 * The runner already caps its payload, but ingress is the trust boundary. Rebuilding both the
 * event and its payload from their fixed fields prevents an upgraded/malformed runner from adding
 * enough JSON to push this broadcast-only event over the realtime bridge's inline limit. Its
 * broadcast seq is forced to the live-only sentinel 0: older clients do not understand
 * tool_output, so exposing the runner's monotonic seq would let them advance their durable resume
 * cursor past events that were never stored. The original runner seq moves into payload as
 * snapshotSeq, where clients can reject cross-replica/out-of-order snapshots without treating it
 * as an SSE resume cursor. The runner's event counter is untouched, and the durable tool_result
 * remains the authoritative full output.
 */
export function normalizeToolOutputEvent(event: NormalizedRunEvent): NormalizedRunEvent {
  if (event.type !== RunEventType.TOOL_OUTPUT) return event;
  const payload = event.payload ?? {};
  const toolUseId = boundedWireToken(payload.toolUseId, TOOL_OUTPUT_ID_MAX_CHARS);
  const content = typeof payload.content === 'string' ? payload.content : '';
  const turnId = boundedWireToken(event.turnId, TOOL_OUTPUT_TURN_ID_MAX_CHARS);
  const snapshotSeq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : 0;
  return {
    seq: 0,
    type: RunEventType.TOOL_OUTPUT,
    ts: boundedWireToken(event.ts, TOOL_OUTPUT_TS_MAX_CHARS),
    ...(turnId ? { turnId } : {}),
    payload: {
      toolUseId,
      content: utf8Tail(content, TOOL_OUTPUT_SNAPSHOT_MAX_BYTES),
      snapshotSeq,
    },
  };
}
