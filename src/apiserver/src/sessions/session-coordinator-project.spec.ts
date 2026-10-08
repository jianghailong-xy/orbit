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

/** The include's own shape: the coordinator's project, and its primary codebase — the read the
 *  detail derives the project's integration line from. `codebases` is always an array from a real
 *  query (a to-many relation under `select`), which is why the stub carries one too. */
function sessionRow(
  coordinatorForProject: { id: string; title: string; codebases: { integrationRef: string | null }[] } | null,
) {
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
    // Read by the detail for the background-job count it reports beside the row's own arrays.
    runningBgJobs: [],
    // The detail's newest merge-repair child, which this session has none of.
    children: [],
    coordinatorForProject,
  };
}

function serviceFor(row: ReturnType<typeof sessionRow>) {
  const calls: any[] = [];
  const prisma = {
    $queryRaw: async () => [{
      projectMembership: row.coordinatorForProject ? {
        projectId: row.coordinatorForProject.id,
        projectTitle: row.coordinatorForProject.title,
        projectStatus: 'OPEN',
        role: 'COORDINATOR',
      } : null,
    }],
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
    sessionRow({
      id: PROJECT_ID,
      title: '实施 Project 公平调度域改造',
      codebases: [{ integrationRef: `refs/heads/project/${PROJECT_ID}` }],
    }),
  );

  const detail: any = await service.get('owner-1', '11111111-1111-4111-8111-111111111111');

  assert.equal(detail.projectId, PROJECT_ID);
  assert.equal(detail.projectTitle, '实施 Project 公平调度域改造');
  // The coordinator's own project line, read out of the same include and spelled as a branch.
  assert.equal(detail.projectIntegrationRef, `project/${PROJECT_ID}`);
  assert.deepEqual(detail.projectMembership, {
    projectId: PROJECT_ID,
    projectTitle: '实施 Project 公平调度域改造',
    projectStatus: 'OPEN',
    role: 'COORDINATOR',
  });
  // Reached through the unique index behind Project.coordinatorSessionId, in the same read.
  assert.deepEqual(calls[0].include.coordinatorForProject, {
    select: {
      id: true,
      title: true,
      codebases: { where: { slot: 'primary' }, select: { integrationRef: true }, take: 1 },
    },
  });
  // The join itself is not part of the payload — only the two flattened fields are.
  assert.equal('coordinatorForProject' in detail, false);
});

test('an ordinary session says so with nulls rather than by omission', async () => {
  const { service } = serviceFor(sessionRow(null));

  const detail: any = await service.get('owner-1', '11111111-1111-4111-8111-111111111111');

  assert.equal(detail.projectId, null);
  assert.equal(detail.projectTitle, null);
  assert.equal(detail.projectIntegrationRef, null);
  assert.equal(detail.projectMembership, null);
});
