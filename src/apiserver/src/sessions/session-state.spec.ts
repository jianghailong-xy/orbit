import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RunStatus,
  SessionFilingState,
  SessionLifecycleState,
  SessionRunState,
  SessionState,
} from '@orbit/shared';
import {
  deriveSessionCapabilities,
  withSessionCapabilities,
  withSessionState,
} from './session-state';

const NOW = new Date('2026-08-01T12:00:00.000Z');

function resumable(overrides: Record<string, unknown> = {}) {
  return {
    status: RunStatus.CANCELLED,
    endReason: 'ended',
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    cancelRequestedAt: NOW,
    startedAt: new Date('2026-08-01T10:00:00.000Z'),
    numTurns: 1,
    runtimeSessionId: 'runtime-1',
    assignedRunnerId: 'runner-1',
    assignedRunner: {
      id: 'runner-1',
      status: 'ONLINE',
      lastHeartbeatAt: NOW,
    },
    ...overrides,
  };
}

test('withSessionState preserves the legacy raw status and adds both explicit fields', () => {
  const row = withSessionState({
    id: 'session-1',
    status: RunStatus.CANCELLED,
    endReason: 'completed',
    archivedAt: new Date('2026-08-01T00:00:00Z'),
    deletedAt: null,
  });

  assert.equal(row.status, RunStatus.CANCELLED);
  assert.equal(row.runStatus, RunStatus.CANCELLED);
  assert.equal(row.sessionState, SessionState.COMPLETED);
  // The legacy sessionState above still splits by reason; runState no longer does.
  assert.equal(row.runState, SessionRunState.ENDED);
  assert.equal(row.lifecycleState, SessionLifecycleState.COMPLETED);
  assert.equal(row.filingState, SessionFilingState.ARCHIVED);
  assert.equal(row.id, 'session-1');
});

test('withSessionState keeps a failed archived run visibly failed', () => {
  const row = withSessionState({ status: RunStatus.FAILED, archivedAt: new Date() });
  assert.equal(row.runStatus, RunStatus.FAILED);
  assert.equal(row.sessionState, SessionState.FAILED);
  assert.equal(row.runState, SessionRunState.FAILED);
  assert.equal(row.lifecycleState, SessionLifecycleState.COMPLETED);
  assert.equal(row.filingState, SessionFilingState.ARCHIVED);
});

test('withSessionState preserves SUCCEEDED after archiving', () => {
  const row = withSessionState({ status: RunStatus.SUCCEEDED, archivedAt: new Date() });
  assert.equal(row.sessionState, SessionState.COMPLETED);
  assert.equal(row.runState, SessionRunState.SUCCEEDED);
  assert.equal(row.lifecycleState, SessionLifecycleState.COMPLETED);
  assert.equal(row.filingState, SessionFilingState.ARCHIVED);
});

test('withSessionState derives a mismatched legacy timestamp from canonical completedAt', () => {
  const completedAt = new Date('2026-08-01T00:00:00.000Z');
  const row = withSessionState({
    status: RunStatus.SUCCEEDED,
    completedAt,
    archivedAt: new Date('2025-01-01T00:00:00.000Z'),
  });

  assert.equal(row.completedAt, completedAt);
  assert.equal(row.archivedAt, completedAt);
  assert.equal(row.lifecycleState, SessionLifecycleState.COMPLETED);
});

test('terminal cancelRequestedAt is historical, not an ENDING resume blocker', () => {
  const capabilities = deriveSessionCapabilities(resumable(), NOW.getTime());
  assert.deepEqual(capabilities, {
    canSend: true,
    canResume: true,
    resumeBlockedReason: null,
    canComplete: true,
    canArchive: true,
    canRestore: false,
  });
});

test('capability blockers follow the mutation guard ordering', () => {
  const cases = [
    [{ deletedAt: NOW }, 'TRASHED'],
    [{ status: RunStatus.RUNNING, cancelRequestedAt: NOW }, 'ENDING'],
    [{ status: RunStatus.RUNNING, cancelRequestedAt: null }, 'NOT_TERMINAL'],
    [{ startedAt: null }, 'NOT_STARTED'],
    [{ runtimeSessionId: null, numTurns: 1 }, 'MISSING_CONTEXT'],
    [{ assignedRunnerId: null, assignedRunner: null }, 'NO_RUNNER'],
    [
      {
        assignedRunner: {
          id: 'runner-1',
          status: 'ONLINE',
          lastHeartbeatAt: new Date(NOW.getTime() - 90_001),
        },
      },
      'RUNNER_OFFLINE',
    ],
  ] as const;
  for (const [overrides, reason] of cases) {
    const capabilities = deriveSessionCapabilities(resumable(overrides), NOW.getTime());
    assert.equal(capabilities.canResume, false);
    assert.equal(capabilities.resumeBlockedReason, reason);
  }
});

test('lifecycle capabilities are orthogonal to execution state', () => {
  const completed = withSessionCapabilities(
    resumable({ completedAt: NOW, cancelRequestedAt: null }),
    NOW.getTime(),
  );
  assert.equal(completed.capabilities.canSend, true);
  assert.equal(completed.capabilities.canComplete, false);
  assert.equal(completed.capabilities.canArchive, false);
  assert.equal(completed.capabilities.canRestore, true);

  const trashed = deriveSessionCapabilities(
    resumable({ deletedAt: NOW, cancelRequestedAt: null }),
    NOW.getTime(),
  );
  assert.equal(trashed.canSend, false);
  assert.equal(trashed.canRestore, true);
});
