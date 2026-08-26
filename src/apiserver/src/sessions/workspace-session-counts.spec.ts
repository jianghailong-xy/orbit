import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

test('workspace counts separate queued activity from Session-list spinner work', async () => {
  const groupByCalls: any[] = [];
  const prisma = {
    session: {
      groupBy: async (args: any) => {
        groupByCalls.push(args);
        // First query is admitted work: w-queued is intentionally present here only. The second
        // query is the exact spinner population: a normal RUNNING row, a self-driven engine turn,
        // or a parked parent whose sub-agent is still working.
        return groupByCalls.length === 1
          ? [
              { workspaceId: 'w-queued', _count: { _all: 1 } },
              { workspaceId: 'w-running', _count: { _all: 2 } },
            ]
          : [
              { workspaceId: 'w-running', _count: { _all: 1 } },
              { workspaceId: 'w-engine-turn', _count: { _all: 1 } },
              { workspaceId: 'w-subagent', _count: { _all: 1 } },
            ];
      },
      findMany: async () => [
        { workspaceId: 'w-running' },
        { workspaceId: 'w-needs-you' },
      ],
    },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const result = await service.workspaceSessionCounts('owner-1');
  const byWorkspace = new Map(result.map((row) => [row.workspaceId, row]));

  assert.deepEqual(byWorkspace.get('w-queued'), {
    workspaceId: 'w-queued',
    active: 1,
    running: 0,
    needsYou: 0,
  });
  assert.deepEqual(byWorkspace.get('w-running'), {
    workspaceId: 'w-running',
    active: 2,
    running: 1,
    needsYou: 1,
  });
  assert.equal(byWorkspace.get('w-engine-turn')?.running, 1);
  assert.equal(byWorkspace.get('w-subagent')?.running, 1);
  assert.deepEqual(byWorkspace.get('w-needs-you'), {
    workspaceId: 'w-needs-you',
    active: 0,
    running: 0,
    needsYou: 1,
  });

  assert.deepEqual(groupByCalls[0].where.status.in, [RunStatus.RUNNING, RunStatus.PENDING]);
  assert.deepEqual(groupByCalls[1].where.OR, [
    { status: RunStatus.RUNNING },
    {
      status: RunStatus.AWAITING_INPUT,
      OR: [{ engineTurnActive: true }, { runningSubagents: { isEmpty: false } }],
    },
  ]);
});
