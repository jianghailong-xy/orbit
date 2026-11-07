/**
 * The long connection's frame, `pbbp2.Frame`, as @larksuiteoapi/node-sdk 1.76.0 encodes it (its lib/index.js):
 *
 *   1 SeqID uint64 · 2 LogID uint64 · 3 service int32 · 4 method int32 (0 control, 1 data)
 *   5 headers repeated Header { 1 key string · 2 value string } · 6 payloadEncoding string · 7 payloadType string
 *   8 payload bytes · 9 LogIDNew string
 *
 * Fields 1–4 are proto2 `required`: the SDK refuses a frame without them, so `encodeFrame` always writes them. Written by
 * hand for the fake open platform rather than through protobufjs, which the apiserver does not depend on itself.
 */

export interface FrameHeader {
  key: string;
  value: string;
}

export interface Frame {
  SeqID: number;
  LogID: number;
  service: number;
  method: number;
  headers: FrameHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
}

export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;

function varint(value: number): number[] {
  const out: number[] = [];
  let v = BigInt.asUintN(64, BigInt(value));
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return out;
}

function field(no: number, wire: number): number[] {
  return varint((no << 3) | wire);
}

function bytesField(no: number, bytes: Uint8Array): number[] {
  return [...field(no, 2), ...varint(bytes.length), ...bytes];
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export function encodeFrame(frame: Frame): Buffer {
  const out: number[] = [
    ...field(1, 0), ...varint(frame.SeqID),
    ...field(2, 0), ...varint(frame.LogID),
    ...field(3, 0), ...varint(frame.service),
    ...field(4, 0), ...varint(frame.method),
  ];
  for (const h of frame.headers) {
    out.push(...bytesField(5, Uint8Array.from([...bytesField(1, utf8(h.key)), ...bytesField(2, utf8(h.value))])));
  }
  if (frame.payloadEncoding !== undefined) out.push(...bytesField(6, utf8(frame.payloadEncoding)));
  if (frame.payloadType !== undefined) out.push(...bytesField(7, utf8(frame.payloadType)));
  if (frame.payload !== undefined) out.push(...bytesField(8, frame.payload));
  if (frame.LogIDNew !== undefined) out.push(...bytesField(9, utf8(frame.LogIDNew)));
  return Buffer.from(out);
}

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array, private readonly end = buf.length) {}
  done(): boolean {
    return this.pos >= this.end;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.buf[this.pos++];
      if (byte === undefined) throw new Error('truncated varint');
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }
  bytes(): Uint8Array {
    const len = Number(this.varint());
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 2) this.bytes();
    else if (wire === 1) this.pos += 8;
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

function decodeHeader(buf: Uint8Array): FrameHeader {
  const r = new Reader(buf);
  const header: FrameHeader = { key: '', value: '' };
  while (!r.done()) {
    const tag = Number(r.varint());
    if (tag >> 3 === 1) header.key = text(r.bytes());
    else if (tag >> 3 === 2) header.value = text(r.bytes());
    else r.skip(tag & 7);
  }
  return header;
}

export function decodeFrame(buf: Uint8Array): Frame {
  const r = new Reader(buf);
  const frame: Frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [] };
  while (!r.done()) {
    const tag = Number(r.varint());
    switch (tag >> 3) {
      case 1: frame.SeqID = Number(r.varint()); break;
      case 2: frame.LogID = Number(r.varint()); break;
      case 3: frame.service = Number(BigInt.asIntN(32, r.varint())); break;
      case 4: frame.method = Number(BigInt.asIntN(32, r.varint())); break;
      case 5: frame.headers.push(decodeHeader(r.bytes())); break;
      case 6: frame.payloadEncoding = text(r.bytes()); break;
      case 7: frame.payloadType = text(r.bytes()); break;
      case 8: frame.payload = Uint8Array.from(r.bytes()); break;
      case 9: frame.LogIDNew = text(r.bytes()); break;
      default: r.skip(tag & 7);
    }
  }
  return frame;
}

export function headerOf(frame: Frame, key: string): string | undefined {
  return frame.headers.find((h) => h.key === key)?.value;
}
