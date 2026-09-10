import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

test('workspace counts separate queued activity from Session-list spinner work', async () => {
  const groupByCalls: any[] = [];
  const findManyCalls: any[] = [];
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
      findMany: async (args: any) => {
        findManyCalls.push(args);
        // Two different questions reach this method. The first is the blocked-on-a-tool-call
        // population; the second resolves the conversations an owner DECISION is waiting on
        // (`projects/owner-decision-signal.ts`) to the workspaces they run in. They are told apart
        // by what they ask for, not by call order, so adding a query elsewhere cannot silently
        // rewire this fixture.
        if (args?.where?.approvals) {
          return [
            { id: 's-running', workspaceId: 'w-running' },
            { id: 's-needs-you', workspaceId: 'w-needs-you' },
          ];
        }
        return [{ id: 's-coordinator', workspaceId: 'w-decision' }];
      },
    },
    // One project, coordinated from `s-coordinator`, with one filed weakening proposal that
    // nothing has answered or displaced. No Approval row exists for it anywhere — that is the
    // whole point of the second source.
    project: {
      findMany: async () => [{ id: 'p-1', coordinatorSessionId: 's-coordinator' }],
    },
    projectRatifiedActionIntent: {
      findMany: async () => [{ id: 'intent-1', projectId: 'p-1', action: {} }],
    },
    projectRatifiedActionCommit: { findMany: async () => [] },
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
  // The second source: a conversation with an unanswered owner decision on it and no approval row
  // anywhere. It is neither running nor queued, so `needsYou` is the only thing this workspace has
  // — which is exactly the state the tally used to report as nothing at all.
  assert.deepEqual(byWorkspace.get('w-decision'), {
    workspaceId: 'w-decision',
    active: 0,
    running: 0,
    needsYou: 1,
  });
  // And it is scoped to the Open list the same way the blocked query is, so a decision waiting on
  // a conversation the owner filed away does not light a workspace they are not looking at.
  const decisionQuery = findManyCalls.find((call) => !call?.where?.approvals);
  assert.equal(decisionQuery.where.completedAt, null);
  assert.equal(decisionQuery.where.deletedAt, null);

  assert.deepEqual(groupByCalls[0].where.status.in, [RunStatus.RUNNING, RunStatus.PENDING]);
  assert.deepEqual(groupByCalls[1].where.OR, [
    { status: RunStatus.RUNNING },
    {
      status: RunStatus.AWAITING_INPUT,
      OR: [{ engineTurnActive: true }, { runningSubagents: { isEmpty: false } }],
    },
  ]);
});
