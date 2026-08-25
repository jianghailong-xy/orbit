import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SessionsService } from './sessions.service';

/**
 * A session detail names the project it coordinates.
 *
 * The link exists in one direction only — `Project.coordinatorSessionId`, with no project column
 * on Session — so a client that opened the coordinator from a project page cannot find its way
 * back without the server saying which project that was.
 */

const NOW = new Date();
const PROJECT_ID = '018f3f3e-1a2b-7c3d-8e4f-5a6b7c8d9e0f';

function sessionRow(coordinatorForProject: { id: string; title: string } | null) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: RunStatus.AWAITING_INPUT,
    title: '实施 Project 公平调度域改造',
    createdAt: NOW,
    lastTurnAt: NOW,
    startedAt: NOW,
    numTurns: 3,
    costUsd: 0,
    error: null,
    endReason: null,
    cancelRequestedAt: null,
    runtimeSessionId: 'runtime-1',
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    provider: 'claude',
    workspaceId: null,
    workspace: null,
    assignedRunnerId: null,
    assignedRunner: null,
    taskId: null,
    tagLinks: [],
    coordinatorForProject,
  };
}

function serviceFor(row: ReturnType<typeof sessionRow>) {
  const calls: any[] = [];
  const prisma = {
    session: {
      findFirst: async (args: any) => {
        calls.push(args);
        return row;
      },
    },
  } as never;
  return { service: new SessionsService(prisma, {} as never, {} as never), calls };
}

test('the detail names the project a coordinator session coordinates', async () => {
  const { service, calls } = serviceFor(
    sessionRow({ id: PROJECT_ID, title: '实施 Project 公平调度域改造' }),
  );

  const detail: any = await service.get('owner-1', '11111111-1111-4111-8111-111111111111');

  assert.equal(detail.projectId, PROJECT_ID);
  assert.equal(detail.projectTitle, '实施 Project 公平调度域改造');
  // Reached through the unique index behind Project.coordinatorSessionId, in the same read.
  assert.deepEqual(calls[0].include.coordinatorForProject, { select: { id: true, title: true } });
  // The join itself is not part of the payload — only the two flattened fields are.
  assert.equal('coordinatorForProject' in detail, false);
});

test('an ordinary session says so with nulls rather than by omission', async () => {
  const { service } = serviceFor(sessionRow(null));

  const detail: any = await service.get('owner-1', '11111111-1111-4111-8111-111111111111');

  assert.equal(detail.projectId, null);
  assert.equal(detail.projectTitle, null);
});
