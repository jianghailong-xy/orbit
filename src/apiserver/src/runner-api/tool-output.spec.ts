import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RunEventType,
  TOOL_OUTPUT_SNAPSHOT_MAX_BYTES,
  type NormalizedRunEvent,
} from '@orbit/shared';
import { normalizeToolOutputEvent, utf8Tail } from './tool-output';

test('utf8Tail caps bytes without splitting a code point', () => {
  const text = `prefix-${'你'.repeat(500)}`;
  const tail = utf8Tail(text, TOOL_OUTPUT_SNAPSHOT_MAX_BYTES);
  assert.ok(Buffer.byteLength(tail, 'utf8') <= TOOL_OUTPUT_SNAPSHOT_MAX_BYTES);
  assert.ok(!tail.startsWith('\ufffd'));
  assert.ok(text.endsWith(tail));
});

test('tool_output ingress keeps only its bounded live-snapshot contract', () => {
  const event = {
    seq: 7,
    type: RunEventType.TOOL_OUTPUT,
    ts: '2026-08-30T00:00:00.000Z',
    turnId: 'turn-1',
    payload: {
      toolUseId: `shell-${'x'.repeat(200)}`,
      content: `old-${'z'.repeat(TOOL_OUTPUT_SNAPSHOT_MAX_BYTES)}-current`,
      unexpected: 'x'.repeat(20_000),
    },
    unexpectedTopLevel: 'x'.repeat(20_000),
  } as NormalizedRunEvent & { unexpectedTopLevel: string };
  const normalized = normalizeToolOutputEvent(event);
  assert.deepEqual(Object.keys(normalized).sort(), ['payload', 'seq', 'ts', 'turnId', 'type']);
  assert.deepEqual(Object.keys(normalized.payload).sort(), ['content', 'snapshotSeq', 'toolUseId']);
  assert.ok(String(normalized.payload.toolUseId).length <= 64);
  assert.ok(Buffer.byteLength(String(normalized.payload.content), 'utf8') <= TOOL_OUTPUT_SNAPSHOT_MAX_BYTES);
  assert.ok(String(normalized.payload.content).endsWith('-current'));
  assert.equal(normalized.seq, 0, 'broadcast-only output must not advance a durable SSE cursor');
  assert.equal(normalized.payload.snapshotSeq, 7, 'runner seq remains available for snapshot ordering');
  assert.equal(event.seq, 7, 'normalization must not mutate the runner event or its internal seq');
  assert.equal(normalized.ts, event.ts);
  assert.equal(normalized.turnId, event.turnId);
});

test('a hostile tool_output still fits the inline cross-replica envelope', () => {
  const control = String.fromCharCode(1);
  const event = {
    seq: Number.MAX_SAFE_INTEGER,
    type: RunEventType.TOOL_OUTPUT,
    ts: `${control.repeat(200)}${'T'.repeat(200)}`,
    turnId: `${control.repeat(200)}${'u'.repeat(200)}`,
    payload: {
      toolUseId: `${control.repeat(200)}${'i'.repeat(200)}`,
      content: control.repeat(TOOL_OUTPUT_SNAPSHOT_MAX_BYTES * 2),
      unexpected: control.repeat(20_000),
    },
    unexpectedTopLevel: control.repeat(20_000),
  } as NormalizedRunEvent & { unexpectedTopLevel: string };
  const normalized = normalizeToolOutputEvent(event);
  assert.deepEqual(Object.keys(normalized).sort(), ['payload', 'seq', 'ts', 'turnId', 'type']);
  assert.equal(normalized.ts.length, 32);
  assert.equal(normalized.turnId?.length, 64);
  assert.equal(String(normalized.payload.toolUseId).length, 64);
  assert.equal(normalized.seq, 0);
  assert.equal(normalized.payload.snapshotSeq, Number.MAX_SAFE_INTEGER);
  const notify = JSON.stringify({
    i: '00000000-0000-4000-8000-000000000001',
    r: '00000000-0000-4000-8000-000000000002',
    e: normalized,
  });
  assert.ok(Buffer.byteLength(notify, 'utf8') <= 7000);
});

test('an invalid runner seq cannot become an unbounded snapshot version', () => {
  for (const seq of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
    const normalized = normalizeToolOutputEvent({
      seq,
      type: RunEventType.TOOL_OUTPUT,
      ts: '2026-08-30T00:00:00.000Z',
      payload: { toolUseId: 'shell-turn-1', content: 'live' },
    });
    assert.equal(normalized.payload.snapshotSeq, 0);
  }
});

test('non-tool-output events pass through unchanged', () => {
  const event: NormalizedRunEvent = {
    seq: 8,
    type: RunEventType.TOOL_RESULT,
    ts: '2026-08-30T00:00:01.000Z',
    payload: { toolUseId: 'shell-turn-1', content: 'authoritative' },
  };
  assert.equal(normalizeToolOutputEvent(event), event);
});
