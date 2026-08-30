import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RunEventType,
  TOOL_OUTPUT_SNAPSHOT_MAX_BYTES,
} from '@orbit/shared';
import type { PushService } from '../push/push.service';
import { normalizeToolOutputEvent } from '../runner-api/tool-output';
import { RealtimeService } from './realtime.service';

test('a worst-case capped tool_output crosses replicas inline instead of by durable seq lookup', () => {
  const notifications: string[] = [];
  const prisma = {
    $executeRawUnsafe: async (_sql: string, _channel: string, payload: string) => {
      notifications.push(payload);
      return 0;
    },
    session: { findUnique: async () => null },
  };
  const push = { scheduleBadgeSync: () => undefined } as unknown as PushService;
  const realtime = new RealtimeService(prisma as never, push);

  // U+0001 is one UTF-8 byte but six JSON bytes (`\\u0001`), the expansion worst case that
  // determines the runner/API cap. If this fits, ordinary text and multibyte Unicode fit too.
  const control = String.fromCharCode(1);
  const event = normalizeToolOutputEvent({
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
  } as Parameters<typeof normalizeToolOutputEvent>[0] & { unexpectedTopLevel: string });
  // API ingress replaces the runner's internal monotonic seq with live-only 0 and removes all
  // unbounded fields before RealtimeService calculates the NOTIFY payload.
  realtime.publish('00000000-0000-4000-8000-000000000001', event);

  assert.equal(notifications.length, 1);
  assert.ok(Buffer.byteLength(notifications[0], 'utf8') <= 7000);
  const bridge = JSON.parse(notifications[0]) as {
    e?: { type: string; seq: number; payload: { snapshotSeq?: number } };
    s?: number;
  };
  assert.equal(bridge.e?.type, RunEventType.TOOL_OUTPUT);
  assert.equal(bridge.e?.seq, 0);
  assert.equal(bridge.e?.payload.snapshotSeq, Number.MAX_SAFE_INTEGER);
  assert.equal(bridge.s, undefined, 'a transient event has no durable row another replica can fetch');
});
