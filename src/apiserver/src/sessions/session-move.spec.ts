import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentProvider } from '@orbit/shared';

import {
  MOVE_REFUSAL,
  type SessionMoveFacts,
  accountsAfterMove,
  mergeTargetOf,
  moveNeedsRunnerOnline,
  sessionMoveVerdict,
} from './session-move';

const session = (over: Partial<{ mergeTarget: string | null; mergeTargets: string[] }> = {}) => ({
  mergeTarget: null,
  mergeTargets: ['main', 'master'],
  ...over,
});

test('project code tasks default their merge target to the integration branch', () => {
  assert.equal(mergeTargetOf(session(), 'workspace-default', 'refs/heads/project/alpha'), 'project/alpha');
});

test('an explicit session merge target still overrides the project line', () => {
  assert.equal(
    mergeTargetOf(session({ mergeTarget: 'release' }), 'workspace-default', 'refs/heads/project/alpha'),
    'release',
  );
});

test('sessions without a project line retain workspace and runner fallbacks', () => {
  assert.equal(mergeTargetOf(session(), 'workspace-default'), 'workspace-default');
  assert.equal(mergeTargetOf(session({ mergeTargets: ['master'] }), null), 'master');
});

test('P6b a workspace move keeps a Cursor CLI session on the account it runs on, and clears it on another runner', () => {
  const WORK = 'c41e0b7a';
  const engines = [{
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
      { id: WORK, name: 'Work', home: `/root/.orbit/cursor-accounts/${WORK}`, auth: 'yes' },
    ],
  }];
  const none = { claudeAccount: null, codexAccount: null, kimiAccount: null, cursorAccount: null };
  // One that follows its workspace's pick has it written onto the session: the next workspace's pick does
  // not carry its conversation to another account (D5).
  assert.deepEqual(
    accountsAfterMove({
      sameRunner: true,
      session: { provider: 'cursor', ...none },
      from: { env: null, ...none, cursorAccount: WORK },
      runnerEngines: engines,
    }),
    { cursorAccount: WORK },
  );
  // Its own pick stays its own.
  assert.deepEqual(
    accountsAfterMove({
      sameRunner: true,
      session: { provider: 'cursor', ...none, cursorAccount: 'default' },
      from: { env: null, ...none, cursorAccount: WORK },
      runnerEngines: engines,
    }),
    { cursorAccount: 'default' },
  );
  // On a Cursor key it spends no account of the runner's.
  assert.deepEqual(
    accountsAfterMove({ sameRunner: true, session: { provider: 'cursor-team', ...none }, from: { env: null, ...none }, runnerEngines: engines }),
    {},
  );
  // On another runner an account id names nothing: cleared, every engine's.
  assert.deepEqual(
    accountsAfterMove({ sameRunner: false, session: { provider: 'cursor', ...none, cursorAccount: WORK }, from: null, runnerEngines: engines }),
    {
      claudeAccount: null, claudeAccountPinned: false, codexAccount: null, codexAccountPinned: false,
      antigravityAccount: null, antigravityAccountPinned: false, kimiAccount: null, kimiAccountPinned: false,
      cursorAccount: null, cursorAccountPinned: false,
    },
  );
});

/** An idle session of a person's, still held by its runner, as the move panel judges it. */
function idleFacts(over: Partial<SessionMoveFacts> = {}): SessionMoveFacts {
  return {
    turnState: null, finishedAt: null, deletedAt: null, completedAt: null, importSourceCwd: null, taskId: null,
    dispatchOrigin: 'USER', cancelRequestedAt: null, engineTurnActive: false, runningBgShells: [], liveApprovals: 0,
    queuedTurns: 0, mergeStatus: null, commitStatus: null, mergeRecoveryOpen: false, retryAt: null,
    runtime: AgentProvider.CLAUDE, ...over,
  };
}

test('the move releases a held session itself: idle, or already being let go, it moves after its release', () => {
  // Idle and held: movable, released by the move first.
  assert.deepEqual(sessionMoveVerdict(idleFacts()), { reason: null, needsEnd: true });
  // Released: moves at once.
  assert.deepEqual(sessionMoveVerdict(idleFacts({ finishedAt: new Date() })), { reason: null, needsEnd: false });
  // Its end already asked for — even mid-turn, with a job still running — is a release under way, which the move
  // waits for rather than refusing with a word about ending.
  for (const over of [{}, { turnState: 'IN_FLIGHT' as const }, { runningBgShells: ['toolu_bg'] }]) {
    assert.deepEqual(sessionMoveVerdict(idleFacts({ cancelRequestedAt: new Date(), ...over })), { reason: null, needsEnd: true });
  }
  // Not asked to end, a running one still has to be stopped by the person first.
  assert.equal(sessionMoveVerdict(idleFacts({ turnState: 'IN_FLIGHT' })).reason, MOVE_REFUSAL.STOP);
  // No refusal of the move speaks of ending the session.
  for (const sentence of Object.values(MOVE_REFUSAL)) assert.doesNotMatch(sentence, /\bend(ed|ing)?\b/i);
  assert.equal(moveNeedsRunnerOnline({ name: 'ws04', displayName: 'Mac mini' }), 'Mac mini has to be online to move this session.');
  assert.equal(moveNeedsRunnerOnline(null), 'Its runner has to be online to move this session.');
});
