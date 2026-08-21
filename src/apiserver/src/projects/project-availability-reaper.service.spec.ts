import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROJECT_RUNNER_OFFLINE_AFTER_MS,
  ProjectAvailabilityReaperService,
} from './project-availability-reaper.service';

test('availability reaper materializes only runners whose heartbeat is stale', async () => {
  const calls: unknown[] = [];
  const service = new ProjectAvailabilityReaperService({
    runner: {
      updateMany: async (args: unknown) => {
        calls.push(args);
        return { count: 2 };
      },
    },
  } as never);
  const now = new Date('2026-08-20T12:00:00.000Z');

  assert.equal(await service.reapOnce(now), 2);
  assert.deepEqual(calls, [
    {
      where: {
        status: { not: 'OFFLINE' },
        OR: [
          { lastHeartbeatAt: null },
          {
            lastHeartbeatAt: {
              lt: new Date(now.getTime() - PROJECT_RUNNER_OFFLINE_AFTER_MS),
            },
          },
        ],
      },
      data: { status: 'OFFLINE' },
    },
  ]);
});
