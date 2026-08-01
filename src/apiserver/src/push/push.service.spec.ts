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
