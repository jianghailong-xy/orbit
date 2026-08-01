import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus, SessionState } from '@orbit/shared';
import { withSessionState } from './session-state';

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
  assert.equal(row.id, 'session-1');
});

test('withSessionState keeps a failed archived run visibly failed', () => {
  const row = withSessionState({ status: RunStatus.FAILED, archivedAt: new Date() });
  assert.equal(row.runStatus, RunStatus.FAILED);
  assert.equal(row.sessionState, SessionState.FAILED);
});
