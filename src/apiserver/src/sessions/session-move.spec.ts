import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accountsAfterMove, mergeTargetOf } from './session-move';

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
