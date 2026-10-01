import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
import { SESSION_MERGE_RECOVERY_V1 } from '@orbit/shared';
import { SessionsService } from './sessions.service';

const NOW = new Date();

function sessionRow() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    status: RunStatus.CANCELLED,
    title: 'Dormant session',
    createdAt: NOW,
    lastTurnAt: NOW,
    startedAt: NOW,
    numTurns: 1,
    costUsd: 0,
    error: null,
    endReason: 'ended',
    cancelRequestedAt: NOW,
    runtimeSessionId: 'runtime-1',
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    source: 'user',
    provider: 'claude',
    model: null,
    permissionMode: null,
    effort: null,
    lastAssistantText: null,
    lastToolUse: null,
    lastUserText: null,
    mergeStatus: null,
    pinnedAt: null,
    tags: [],
    tagLinks: [],
    runningBgCount: 0,
    // The raw shell ids, which the list reads (and never ships) to decide whether a card is still
    // being asked — `approval.background_job_id` versus this set, so the mapper needs the ids and
    // not the cardinality beside them.
    runningBgShells: [],
    // The two columns the list's `runningBgJobCount` is derived from: the live job set, and when each
    // of those jobs last produced output. The count is not one of the row's columns any more — which
    // jobs still count is a fact about `now` (background-job-activity.ts), so the mapper decides it.
    runningBgJobs: [],
    runningBgJobActivity: {},
    runningSubagentCount: 0,
    // The detail's newest merge-repair child, which this session has none of.
    children: [],
    workspaceId: null,
    workspaceName: null,
    workspaceModel: null,
    workspace: null,
    runnerId: '22222222-2222-4222-8222-222222222222',
    runnerName: 'runner',
    runnerStatus: 'ONLINE',
    runnerLastHeartbeatAt: NOW,
    assignedRunnerId: '22222222-2222-4222-8222-222222222222',
    assignedRunner: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'runner',
      status: 'ONLINE',
      lastHeartbeatAt: NOW,
      capabilities: [] as string[],
    },
    taskId: null,
    taskTitle: null,
    projectId: '33333333-3333-4333-8333-333333333333',
    projectTitle: 'Project Atlas',
  };
}

test('UI list and detail payloads include the same derived capabilities', async () => {
  const row = sessionRow();
  const prisma = {
    $queryRaw: async () => [row],
    session: {
      findFirst: async () => ({
        ...row,
        // The detail counts the ids it spreads beside the count the list computes in the mapper.
        runningBgJobs: [],
        runningBgJobActivity: {},
        coordinatorForProject: { id: row.projectId, title: row.projectTitle },
        titleManagedByProject: true,
        titleBeforeProjectManagement: 'Dormant session',
      }),
    },
    // The list's `pendingApprovals` is blocked tool calls plus the owner decisions each row is the
    // surface for (`projects/owner-decision-signal.ts`). This row coordinates nothing and no
    // OWNER_CONFIRMED run is waiting on it, so the second half is empty and the capabilities below
    // are unaffected either way.
    project: { findMany: async () => [] },
    taskOwnerConfirmationRequest: { findMany: async () => [] },
    // …and the four owner items a project can be waiting on its owner for (§7.6 V13),
    // which these fixtures have none of either.
    projectOpenItem: { findMany: async () => [] },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const [listed] = await service.list('owner-1', { view: 'active' });
  const detail = await service.get('owner-1', row.id);

  const expected = {
    canSend: true,
    canResume: true,
    resumeBlockedReason: null,
    canComplete: true,
    canArchive: true,
    canRestore: false,
  };
  assert.deepEqual(listed.capabilities, expected);
  assert.deepEqual(detail.capabilities, expected);
  assert.equal(detail.mergeRecoverySupported, false);
  assert.deepEqual(
    [listed.projectId, listed.projectTitle, detail.projectId, detail.projectTitle],
    [row.projectId, row.projectTitle, row.projectId, row.projectTitle],
  );
  assert.equal('titleManagedByProject' in detail, false);
  assert.equal('titleBeforeProjectManagement' in detail, false);
});

test('merge recovery is offered only by a capable assigned runner', async () => {
  for (const capabilities of [[], [SESSION_MERGE_RECOVERY_V1]]) {
    const row = sessionRow();
    row.assignedRunner.capabilities = capabilities;
    const service = new SessionsService({
      session: { findFirst: async () => row },
    } as never, {} as never, {} as never);
    const detail = await service.get('owner-1', row.id);
    assert.equal(detail.mergeRecoverySupported, capabilities.length > 0);
  }
  const row = sessionRow();
  const service = new SessionsService({
    session: { findFirst: async () => ({ ...row, assignedRunner: null }) },
  } as never, {} as never, {} as never);
  assert.equal((await service.get('owner-1', row.id)).mergeRecoverySupported, false);
});
