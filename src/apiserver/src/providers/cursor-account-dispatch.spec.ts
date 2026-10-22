import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, type RunnerEngineHealth } from '@orbit/shared';
import { resolveProviderExec } from './custom-provider';
import {
  automaticAccount,
  runAccount,
  sessionAccountPausedUntil,
  workspaceLeavesAccountToOrbit,
} from './plan-usage-accounts';
import type { AccountRunner } from './account';

// Which Cursor CLI account a session is dispatched on (docs/cursor-runtime-contract.md §16.2; project
// P4a): the account picked for it, else its workspace's, resolved against the accounts its runner
// reports into ORBIT_CURSOR_ACCOUNT_DIR — and Default, with nothing handed over, for any account the
// runner does not report. scripts/test-cursor-accounts-server.mjs runs these by name.

const NOW = new Date('2026-10-17T08:00:00Z');
const WORK = 'c41e0b7a';
const WORK_HOME = '/root/.orbit/cursor-accounts/c41e0b7a';
const DIR_VAR = 'ORBIT_CURSOR_ACCOUNT_DIR';
const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
      { id: WORK, name: 'Work', home: WORK_HOME, auth: 'yes' },
    ],
  },
];

/** A runner as the account helpers read it, reporting `engines`, with no Default removed from Orbit. */
const reporting = (engines: unknown, accountPauses: unknown = null): AccountRunner =>
  ({ engines, defaultRemoved: [], accountPauses, planUsage: null });

/** The environment a built-in Cursor CLI session is handed, on `args`' accounts and runner report. */
function cursorEnv(args: Partial<Parameters<typeof resolveProviderExec>[0]>) {
  return resolveProviderExec({
    engine: AgentProvider.CURSOR,
    declaredProvider: AgentProvider.CURSOR,
    declaredProviderBuiltin: true,
    customRow: null,
    sessionModel: 'default[]',
    runner: reporting(ENGINES),
    ...args,
  }).env;
}

test('P4a dispatch hands a Cursor CLI session its account’s directory as ORBIT_CURSOR_ACCOUNT_DIR', () => {
  // The account's directory as its runner reported it, in place of one typed into the workspace's env.
  assert.deepEqual(cursorEnv({ cursorAccount: WORK, workspaceEnv: { FOO: 'bar', [DIR_VAR]: '/srv/typed-by-hand' } }), {
    FOO: 'bar',
    [DIR_VAR]: WORK_HOME,
  });
  assert.deepEqual(cursorEnv({ cursorAccount: WORK }), { [DIR_VAR]: WORK_HOME });
  // Another engine's account is not Cursor CLI's, and a Cursor CLI account reaches no other engine.
  assert.equal(cursorEnv({ kimiAccount: WORK, codexAccount: WORK, workspaceEnv: {} })?.[DIR_VAR], undefined);
  const claude = resolveProviderExec({
    engine: AgentProvider.CLAUDE,
    declaredProvider: AgentProvider.CLAUDE,
    declaredProviderBuiltin: true,
    customRow: null,
    sessionModel: null,
    workspaceEnv: { FOO: 'bar' },
    cursorAccount: WORK,
    runner: reporting(ENGINES),
  });
  assert.deepEqual(claude.env, { FOO: 'bar' });
});

test('P4a an account the runner does not report runs a Cursor CLI session on Default', () => {
  // Default, an id this runner does not report (removed, or one on another machine), no pick at all,
  // and any pick on a runner that lists no Cursor CLI accounts: the runner's own Default, so nothing
  // is handed over and the workspace's env goes as it is.
  for (const cursorAccount of ['default', 'c0ffee42', null, undefined]) {
    assert.deepEqual(cursorEnv({ cursorAccount, workspaceEnv: { FOO: 'bar' } }), { FOO: 'bar' }, String(cursorAccount));
  }
  assert.deepEqual(
    cursorEnv({ cursorAccount: WORK, workspaceEnv: { FOO: 'bar' }, runner: reporting([{ engine: 'cursor', installed: true, auth: 'yes' }]) }),
    { FOO: 'bar' },
  );
  assert.equal(cursorEnv({ cursorAccount: WORK, runner: null }), undefined);
});

test('P4a a Cursor CLI run is judged on the account dispatch gives it, and Automatic starts it on Default', () => {
  // The account a run spends is the one dispatch hands over, and Default for one it does not.
  assert.equal(runAccount('cursor', {}, { cursorAccount: WORK }, reporting(ENGINES)), WORK);
  assert.equal(runAccount('cursor', {}, { cursorAccount: 'c0ffee42' }, reporting(ENGINES)), 'default');
  assert.equal(runAccount('cursor', null, null, reporting(ENGINES)), 'default');
  // A key or token of the workspace's own spends no account — unless the run is on an account picked for
  // it, whose login the runner hands the CLI in the key's place (contract §16.3; P6a).
  assert.equal(runAccount('cursor', { CURSOR_API_KEY: 'key_x' }, null, reporting(ENGINES)), null);
  assert.equal(runAccount('cursor', { CURSOR_API_KEY: 'key_x' }, { cursorAccount: WORK }, reporting(ENGINES)), WORK);
  // Automatic is a workspace that picked none; it starts a session on Default while nothing reports
  // Cursor CLI's quota. A workspace that picked one decides, and Orbit does not choose.
  assert.equal(workspaceLeavesAccountToOrbit('cursor', { env: {} }, reporting(ENGINES)), true);
  assert.equal(workspaceLeavesAccountToOrbit('cursor', { cursorAccount: WORK }, reporting(ENGINES)), false);
  assert.equal(automaticAccount('cursor', { env: {} }, reporting(ENGINES), NOW), 'default');
  assert.equal(automaticAccount('cursor', { cursorAccount: 'default' }, reporting(ENGINES), NOW), null);
  // A paused account holds a session on it, and only on it.
  const pauses = { cursor: { [WORK]: '2026-10-17T09:00:00.000Z' } };
  const on = (cursorAccount: string) => ({ provider: AgentProvider.CURSOR, providerBuiltin: true, cursorAccount });
  assert.deepEqual(sessionAccountPausedUntil(on(WORK), null, reporting(ENGINES, pauses), NOW), new Date('2026-10-17T09:00:00.000Z'));
  assert.equal(sessionAccountPausedUntil(on('default'), null, reporting(ENGINES, pauses), NOW), null);
});
