import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@prisma/client';
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
    claudeSessionId: null,
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
    runningSubagentCount: 0,
    agentId: null,
    agentName: null,
    agentModel: null,
    agent: null,
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
    },
    taskId: null,
    taskTitle: null,
  };
}

test('UI list and detail payloads include the same derived capabilities', async () => {
  const row = sessionRow();
  const prisma = {
    $queryRaw: async () => [row],
    session: { findFirst: async () => row },
  } as never;
  const service = new SessionsService(prisma, {} as never, {} as never);

  const [listed] = await service.list('owner-1', { view: 'active' });
  const detail = await service.get('owner-1', row.id);

  const expected = {
    canSend: true,
    canResume: true,
    resumeBlockedReason: null,
    canArchive: true,
    canRestore: false,
  };
  assert.deepEqual(listed.capabilities, expected);
  assert.deepEqual(detail.capabilities, expected);
});
