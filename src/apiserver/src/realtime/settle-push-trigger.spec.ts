import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType } from '@orbit/shared';
import type { PushService } from '../push/push.service';
import { RealtimeService } from './realtime.service';

// Do NOT call onModuleInit — that would open a real pg LISTEN connection. publish() still fans the
// event out to the other replicas over NOTIFY, so that one statement is stubbed.
function svc(): { service: RealtimeService; settled: string[] } {
  const settled: string[] = [];
  const push = {
    scheduleBadgeSync: () => undefined,
    notifySessionSettled: async (id: string) => {
      settled.push(id);
    },
  } as unknown as PushService;
  const prisma = {
    $executeRawUnsafe: async () => 0,
    session: { findUnique: async () => null },
  };
  return { service: new RealtimeService(prisma as any, push), settled };
}

function status(payload: Record<string, unknown>) {
  return { seq: 1, type: RunEventType.STATUS, ts: '2026-08-14T00:00:00.000Z', payload };
}

test('a finalized run notifies its owner exactly once per publish', () => {
  const { service, settled } = svc();
  service.publish('s-1', status({ status: 'SUCCEEDED', final: true }));
  assert.deepEqual(settled, ['s-1']);
});

test('the status changes a live turn emits are not settlements', () => {
  const { service, settled } = svc();
  // Every intermediate STATUS the runner streams lands here too; only `final` marks the one
  // that a finalization actually applied.
  service.publish('s-1', status({ status: 'RUNNING' }));
  service.publish('s-1', status({ status: 'AWAITING_INPUT', final: false }));
  service.publish('s-1', {
    seq: 2,
    type: RunEventType.ASSISTANT,
    ts: '2026-08-14T00:00:00.000Z',
    payload: { final: true },
  });
  assert.deepEqual(settled, []);
});
