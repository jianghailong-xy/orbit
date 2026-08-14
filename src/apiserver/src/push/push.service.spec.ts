import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { RunStatus } from '@prisma/client';
import { PushService } from './push.service';

function enabledConfig(): ConfigService {
  const values: Record<string, string> = {
    APNS_KEY_ID: 'key-id',
    APNS_TEAM_ID: 'team-id',
    APNS_KEY: Buffer.from('test-key').toString('base64'),
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

test('needs-you includes only canonical Open, non-ending sessions', async () => {
  const calls: any[] = [];
  const prisma = {
    session: {
      findMany: async (args: any) => {
        calls.push(args);
        return [{ id: 's-open' }];
      },
    },
  };
  const service = new PushService(prisma as any, enabledConfig());

  assert.deepEqual(await service.needsYouSessions('owner-1'), ['s-open']);
  assert.deepEqual(calls[0].where, {
    ownerId: 'owner-1',
    status: RunStatus.RUNNING,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    cancelRequestedAt: null,
    approvals: { some: { status: 'PENDING' } },
  });
});

test('approval push is suppressed when completion wins the race', async () => {
  let tokenQueries = 0;
  let deliveries = 0;
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Session', ownerId: 'owner-1' }),
    },
    deviceToken: {
      findMany: async () => {
        tokenQueries += 1;
        return [{ token: 'device', environment: 'sandbox' }];
      },
    },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).needsYouSessions = async () => [];
  (service as any).deliver = async () => {
    deliveries += 1;
  };

  await service.notifyApprovalRequest('s-completed', 'Bash');

  assert.equal(tokenQueries, 0);
  assert.equal(deliveries, 0);
});

test('a second approval on an already-flagged session does not alert again', async () => {
  const bodies: string[] = [];
  const prisma = {
    session: {
      findFirst: async () => ({ title: 'Session', ownerId: 'owner-1' }),
    },
    deviceToken: {
      findMany: async () => [{ token: 'device', environment: 'sandbox' }],
    },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).needsYouSessions = async () => ['s-1'];
  // The fixture key isn't a real ES256 key, so signing a provider JWT would throw.
  (service as any).authToken = () => 'auth-token';
  (service as any).deliver = async (_t: unknown, body: string) => {
    bodies.push(body);
  };

  // Parallel tool calls in one turn: an approval apiece, all on the same session.
  await service.notifyApprovalRequest('s-1', 'Bash');
  await service.notifyApprovalRequest('s-1', 'Write');
  await service.notifyApprovalRequest('s-1', 'Edit');

  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Needs your reply · Bash/);

  // A different session needing you is its own interruption and still alerts.
  (service as any).needsYouSessions = async () => ['s-1', 's-2'];
  await service.notifyApprovalRequest('s-2', 'Bash');
  assert.equal(bodies.length, 2);
  assert.equal(JSON.parse(bodies[1]).aps.badge, 2);
});

function settledSession(over: Record<string, unknown> = {}) {
  return {
    title: 'Fix the login bug',
    ownerId: 'owner-1',
    status: RunStatus.SUCCEEDED,
    retryAt: null,
    completedAt: null,
    deletedAt: null,
    error: null,
    owner: { preferences: {} },
    ...over,
  };
}

function settleHarness(session: Record<string, unknown> | null) {
  const sent: { body: string; collapseId?: string }[] = [];
  const prisma = {
    session: { findUnique: async () => session },
    deviceToken: { findMany: async () => [{ token: 'device', environment: 'sandbox' }] },
  };
  const service = new PushService(prisma as any, enabledConfig());
  (service as any).authToken = () => 'auth-token';
  (service as any).deliver = async (
    _t: unknown,
    body: string,
    _p: unknown,
    _pr: unknown,
    _a: unknown,
    collapseId?: string,
  ) => {
    sent.push({ body, collapseId });
  };
  return { service, sent };
}

test('a settled session alerts its owner, collapsing on the session', async () => {
  const { service, sent } = settleHarness(settledSession());

  await service.notifySessionSettled('s-1');

  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0].body);
  assert.equal(payload.aps.alert.title, 'Fix the login bug');
  assert.equal(payload.aps.alert.body, 'Finished');
  assert.equal(payload.aps.category, 'ORBIT_SESSION');
  assert.equal(payload.sessionID, 's-1');
  assert.equal(payload.kind, 'finished');
  // A settled session is not one "needing your reply", so it must not move that count.
  assert.equal(payload.aps.badge, undefined);
  assert.equal(sent[0].collapseId, 'settled-s-1');
});

test('a failure carries its first error line', async () => {
  const { service, sent } = settleHarness(
    settledSession({ status: RunStatus.FAILED, error: 'API Error: 529 overloaded_error' }),
  );

  await service.notifySessionSettled('s-1');

  const payload = JSON.parse(sent[0].body);
  assert.equal(payload.kind, 'failed');
  assert.equal(payload.aps.alert.body, 'Failed · API Error: 529 overloaded_error');
});

test('an ending not worth an interruption sends nothing', async () => {
  const { service, sent } = settleHarness(settledSession({ status: RunStatus.CANCELLED }));
  await service.notifySessionSettled('s-1');
  assert.equal(sent.length, 0);
});

test('the owner can turn settle alerts off', async () => {
  const off = settleHarness(settledSession({ owner: { preferences: { notifySessionFinished: false } } }));
  await off.service.notifySessionSettled('s-1');
  assert.equal(off.sent.length, 0);

  // Absent (and explicit true) means on — the switch only has to be written to opt out.
  const on = settleHarness(settledSession({ owner: { preferences: { notifySessionFinished: true } } }));
  await on.service.notifySessionSettled('s-1');
  assert.equal(on.sent.length, 1);
});

test('a vanished session is not an error', async () => {
  const { service, sent } = settleHarness(null);
  await service.notifySessionSettled('s-gone');
  assert.equal(sent.length, 0);
});

test('approval push initially requires a canonical Open, non-ending RUNNING session', async () => {
  const calls: any[] = [];
  const prisma = {
    session: {
      findFirst: async (args: any) => {
        calls.push(args);
        return null;
      },
    },
  };
  const service = new PushService(prisma as any, enabledConfig());

  await service.notifyApprovalRequest('s-completed', 'Bash');

  assert.deepEqual(calls[0].where, {
    id: 's-completed',
    status: RunStatus.RUNNING,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    cancelRequestedAt: null,
  });
});
