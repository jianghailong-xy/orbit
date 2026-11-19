/**
 * The link frames a browser viewer's byte stream travels in between this apiserver and the link gateway
 * (docs/runner-browser-design.md §4; contracts/runner-link/v1/runner_link.proto, StreamOpen; src/link-gateway/streams.go):
 *
 *   - the open: a NATS request on rnr.<runnerId> carrying a Frame with only stream_open set, in protobuf's canonical
 *     JSON, answered by a Frame with stream_opened or stream_close set, in the same JSON;
 *   - the bytes: on vnc.<streamId>.down (to the runner) and vnc.<streamId>.up (from it), each NATS message one
 *     binary-encoded Frame with only stream_data, stream_credit or stream_close set.
 *
 * The apiserver does not carry the generated protobuf code, so the five messages it needs are written and read here by
 * hand, field by field as the proto numbers them. browser-stream-frames.spec.ts holds both directions to the code
 * generated from the proto (@orbit/shared's runner_link_pb.ts).
 */

/** Frame's fields of the stream bodies (runner_link.proto, Frame). */
const FRAME_STREAM_DATA = 22;
const FRAME_STREAM_CREDIT = 23;
const FRAME_STREAM_CLOSE = 24;

/** Why a stream closed (runner_link.proto, StreamCloseCode). */
export const STREAM_CLOSE = {
  UNSPECIFIED: 0,
  NORMAL: 1,
  REFUSED: 2,
  UNAVAILABLE: 3,
  TOO_MANY_STREAMS: 4,
  FLOW_VIOLATION: 5,
  CONNECTION_LOST: 6,
  TIMEOUT: 7,
} as const;

const CLOSE_CODE_NAMES: Record<string, number> = Object.fromEntries(
  Object.entries(STREAM_CLOSE).map(([name, code]) => [`STREAM_CLOSE_CODE_${name}`, code]),
);

/** One frame of a stream, as read from vnc.<streamId>.up. */
export type StreamFrame =
  | { kind: 'data'; streamId: string; data: Uint8Array }
  | { kind: 'credit'; streamId: string; bytes: number }
  | { kind: 'close'; streamId: string; code: number; message: string };

/** The open request: a Frame with only stream_open set (kind VNC), in protobuf's canonical JSON. */
export function streamOpenMessage(streamId: string): string {
  return JSON.stringify({ streamOpen: { streamId, kind: 'STREAM_KIND_VNC' } });
}

/** The open request's answer: opened, closed with a code and message, or null when it is neither. */
export function decodeStreamOpenAnswer(
  data: Uint8Array,
  streamId: string,
): { opened: true } | { opened: false; code: number; message: string } | null {
  let frame: { streamOpened?: { streamId?: unknown }; streamClose?: { streamId?: unknown; code?: unknown; message?: unknown } };
  try {
    frame = JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return null;
  }
  if (frame?.streamOpened?.streamId === streamId) return { opened: true };
  const close = frame?.streamClose;
  if (close && close.streamId === streamId) {
    const code = typeof close.code === 'number' ? close.code : (CLOSE_CODE_NAMES[String(close.code)] ?? STREAM_CLOSE.UNSPECIFIED);
    return { opened: false, code, message: typeof close.message === 'string' ? close.message : '' };
  }
  return null;
}

export function encodeStreamData(streamId: string, data: Uint8Array): Uint8Array {
  return frame(FRAME_STREAM_DATA, concat([stringField(1, streamId), bytesField(2, data)]));
}

export function encodeStreamCredit(streamId: string, bytes: number): Uint8Array {
  return frame(FRAME_STREAM_CREDIT, concat([stringField(1, streamId), varintField(2, bytes)]));
}

export function encodeStreamClose(streamId: string, code: number, message = ''): Uint8Array {
  return frame(
    FRAME_STREAM_CLOSE,
    concat([stringField(1, streamId), code ? varintField(2, code) : new Uint8Array(0), message ? stringField(3, message) : new Uint8Array(0)]),
  );
}

/** Reads one binary Frame from vnc.<streamId>.up; null when it is not a stream frame this side reads. */
export function decodeStreamFrame(buf: Uint8Array): StreamFrame | null {
  try {
    let found: StreamFrame | null = null;
    for (const field of fields(buf)) {
      if (field.wire !== 2) continue;
      const body = field.value as Uint8Array;
      if (field.number === FRAME_STREAM_DATA) {
        let streamId = '';
        let data: Uint8Array = new Uint8Array(0);
        for (const f of fields(body)) {
          if (f.number === 1 && f.wire === 2) streamId = utf8(f.value as Uint8Array);
          if (f.number === 2 && f.wire === 2) data = f.value as Uint8Array;
        }
        found = { kind: 'data', streamId, data };
      } else if (field.number === FRAME_STREAM_CREDIT) {
        let streamId = '';
        let bytes = 0;
        for (const f of fields(body)) {
          if (f.number === 1 && f.wire === 2) streamId = utf8(f.value as Uint8Array);
          if (f.number === 2 && f.wire === 0) bytes = Number(f.value);
        }
        found = { kind: 'credit', streamId, bytes };
      } else if (field.number === FRAME_STREAM_CLOSE) {
        let streamId = '';
        let code = 0;
        let message = '';
        for (const f of fields(body)) {
          if (f.number === 1 && f.wire === 2) streamId = utf8(f.value as Uint8Array);
          if (f.number === 2 && f.wire === 0) code = Number(f.value);
          if (f.number === 3 && f.wire === 2) message = utf8(f.value as Uint8Array);
        }
        found = { kind: 'close', streamId, code, message };
      }
    }
    return found;
  } catch {
    return null;
  }
}

// --- protobuf wire format, the little of it these messages use ---

function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function tag(number: number, wire: number): number[] {
  return varint((number << 3) | wire);
}

function varintField(number: number, value: number): Uint8Array {
  return Uint8Array.from([...tag(number, 0), ...varint(value)]);
}

function bytesField(number: number, value: Uint8Array): Uint8Array {
  return concat([Uint8Array.from([...tag(number, 2), ...varint(value.length)]), value]);
}

function stringField(number: number, value: string): Uint8Array {
  return bytesField(number, new Uint8Array(Buffer.from(value, 'utf8')));
}

function frame(number: number, body: Uint8Array): Uint8Array {
  return bytesField(number, body);
}

function concat(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

function utf8(b: Uint8Array): string {
  return Buffer.from(b).toString('utf8');
}

interface WireField {
  number: number;
  wire: number;
  value: Uint8Array | bigint;
}

function* fields(buf: Uint8Array): Generator<WireField> {
  let at = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= buf.length) throw new Error('truncated varint');
      const byte = buf[at++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('varint too long');
    }
  };
  while (at < buf.length) {
    const key = Number(readVarint());
    const number = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      yield { number, wire, value: readVarint() };
    } else if (wire === 2) {
      const length = Number(readVarint());
      if (at + length > buf.length) throw new Error('truncated field');
      yield { number, wire, value: buf.subarray(at, at + length) };
      at += length;
    } else if (wire === 1) {
      at += 8;
    } else if (wire === 5) {
      at += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
}
