/**
 * browser-stream-frames.ts writes and reads the stream frames by hand; this holds it to the code generated from
 * contracts/runner-link/v1/runner_link.proto (@orbit/shared's runner_link_pb, with @bufbuild/protobuf), both ways, so
 * that a field the proto renumbers turns this red rather than a viewer's stream silent.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import {
  STREAM_CLOSE,
  decodeStreamFrame,
  decodeStreamOpenAnswer,
  encodeStreamClose,
  encodeStreamCredit,
  encodeStreamData,
  streamOpenMessage,
} from './browser-stream-frames';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
// build/managed-runners → src/shared/dist: the generated code, which the apiserver itself does not carry.
const pb = require(path.resolve(__dirname, '../../../shared/dist/runner-link/v1/runner_link_pb.js')) as any;
const protobuf = require('@bufbuild/protobuf') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const ID = '0190a0b0-0000-7000-8000-0000000000e1';

function generated(body: { case: string; value: object }): Uint8Array {
  return protobuf.toBinary(pb.FrameSchema, protobuf.create(pb.FrameSchema, { body }));
}

test('what this side writes, the generated code reads as the same frame', () => {
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  const data = protobuf.fromBinary(pb.FrameSchema, encodeStreamData(ID, bytes));
  assert.equal(data.body.case, 'streamData');
  assert.equal(data.body.value.streamId, ID);
  assert.deepEqual(Buffer.from(data.body.value.data), Buffer.from(bytes));

  const credit = protobuf.fromBinary(pb.FrameSchema, encodeStreamCredit(ID, 262_144));
  assert.equal(credit.body.case, 'streamCredit');
  assert.equal(credit.body.value.streamId, ID);
  assert.equal(credit.body.value.bytes, 262_144);

  const close = protobuf.fromBinary(pb.FrameSchema, encodeStreamClose(ID, STREAM_CLOSE.NORMAL, 'The viewer closed the stream'));
  assert.equal(close.body.case, 'streamClose');
  assert.equal(close.body.value.streamId, ID);
  assert.equal(close.body.value.code, pb.StreamCloseCode.NORMAL);
  assert.equal(close.body.value.message, 'The viewer closed the stream');

  const open = protobuf.fromJson(pb.FrameSchema, JSON.parse(streamOpenMessage(ID)));
  assert.equal(open.body.case, 'streamOpen');
  assert.equal(open.body.value.streamId, ID);
  assert.equal(open.body.value.kind, pb.StreamKind.VNC);
});

test('what the generated code writes, this side reads', () => {
  const bytes = Uint8Array.from([0x52, 0x46, 0x42, 0x20, 0x30, 0x30, 0x33, 0x2e, 0x30, 0x30, 0x38, 0x0a]);
  assert.deepEqual(decodeStreamFrame(generated({ case: 'streamData', value: { streamId: ID, data: bytes } })), {
    kind: 'data',
    streamId: ID,
    data: bytes,
  });
  assert.deepEqual(decodeStreamFrame(generated({ case: 'streamCredit', value: { streamId: ID, bytes: 131_072 } })), {
    kind: 'credit',
    streamId: ID,
    bytes: 131_072,
  });
  assert.deepEqual(
    decodeStreamFrame(generated({ case: 'streamClose', value: { streamId: ID, code: pb.StreamCloseCode.FLOW_VIOLATION, message: 'past the window' } })),
    { kind: 'close', streamId: ID, code: STREAM_CLOSE.FLOW_VIOLATION, message: 'past the window' },
  );
  // Every close code means the same on both sides.
  for (const [name, code] of Object.entries(STREAM_CLOSE)) assert.equal(pb.StreamCloseCode[name], code, name);

  // The open's answers, in the canonical JSON the gateway writes (streams.go, answerStream).
  const json = (body: { case: string; value: object }) =>
    new Uint8Array(Buffer.from(JSON.stringify(protobuf.toJson(pb.FrameSchema, protobuf.create(pb.FrameSchema, { body }))), 'utf8'));
  assert.deepEqual(decodeStreamOpenAnswer(json({ case: 'streamOpened', value: { streamId: ID } }), ID), { opened: true });
  assert.deepEqual(
    decodeStreamOpenAnswer(json({ case: 'streamClose', value: { streamId: ID, code: pb.StreamCloseCode.TOO_MANY_STREAMS, message: 'two open' } }), ID),
    { opened: false, code: STREAM_CLOSE.TOO_MANY_STREAMS, message: 'two open' },
  );
  // Another stream's answer, or something else, is no answer.
  assert.equal(decodeStreamOpenAnswer(json({ case: 'streamOpened', value: { streamId: '0190a0b0-0000-7000-8000-0000000000e2' } }), ID), null);
  assert.equal(decodeStreamOpenAnswer(new Uint8Array(Buffer.from('not json')), ID), null);
  assert.equal(decodeStreamFrame(Uint8Array.from([0xff, 0xff])), null);
});
