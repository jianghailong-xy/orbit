import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, planUsageBlockedUntil, type PlanUsage, type RunnerEngineHealth } from '@orbit/shared';
import { automaticAccount, runAccount, sanitizePlanUsageAccounts } from './plan-usage-accounts';
import type { AccountRunner } from './account';

// Cursor CLI's quota on the control plane (docs/cursor-runtime-contract.md §11; project P6a): the
// heartbeat's planUsage.cursor as it is stored, the account Automatic starts a session on, and the account
// a run is judged on. scripts/test-cursor-quota.mjs runs these by name.

const NOW = new Date('2026-10-18T12:00:00.000Z');
const TEAM = 'c41e0b7a';
const TEAM_HOME = '/root/.orbit/cursor-accounts/c41e0b7a';
const DEFAULT_RESET = '2026-10-24T16:32:26.082Z';
const TEAM_RESET = '2026-10-24T01:32:16.338Z';
const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'cursor',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
      { id: TEAM, name: 'Team', home: TEAM_HOME, auth: 'yes' },
    ],
  },
];

/** Default on the Free plan, which Cursor reports no share of; Team on a paid week at 34%. */
const usage = (spent: { default?: string; team?: string } = {}): PlanUsage => ({
  cursor: {
    provider: AgentProvider.CURSOR,
    account: 'default',
    planName: 'Free',
    includedUsage: {
      startsAt: '2026-09-24T16:32:26.082Z',
      resetsAt: DEFAULT_RESET,
      ...(spent.default ? { limitReachedAt: spent.default } : {}),
    },
    accounts: {
      [TEAM]: {
        provider: AgentProvider.CURSOR,
        account: TEAM,
        planName: 'Premium',
        includedUsage: {
          period: 'weekly',
          startsAt: '2026-10-17T01:32:16.338Z',
          resetsAt: TEAM_RESET,
          percentUsed: 34,
          ...(spent.team ? { limitReachedAt: spent.team } : {}),
        },
      },
    },
  },
});

test('P6a the heartbeat’s planUsage.cursor is stored with each account’s snapshot under its own id', () => {
  const reported = usage({ team: '2026-10-18T09:00:00.000Z' });
  const stored = sanitizePlanUsageAccounts({
    ...reported,
    cursor: {
      ...reported.cursor,
      accounts: {
        ...reported.cursor!.accounts,
        // Under a key no added account has, naming another account than its key, and one carrying
        // accounts of its own: dropped, or stripped of what is never an added account's.
        '../escape': { provider: AgentProvider.CURSOR, account: '../escape' },
        c0ffee42: { provider: AgentProvider.CURSOR, account: TEAM, planName: 'Pro' },
        'deadbeef': {
          provider: AgentProvider.CURSOR, account: 'deadbeef', planName: 'Pro',
          accounts: { [TEAM]: { provider: AgentProvider.CURSOR, account: TEAM } },
        } as never,
      },
    },
  });
  assert.deepEqual(stored.cursor, {
    ...reported.cursor,
    accounts: { [TEAM]: reported.cursor!.accounts![TEAM], deadbeef: { provider: AgentProvider.CURSOR, account: 'deadbeef', planName: 'Pro' } },
  });
  // Default's own snapshot, its account, plan and included usage, as the runner sent it.
  assert.equal(stored.cursor?.account, 'default');
  assert.equal(stored.cursor?.includedUsage?.resetsAt, DEFAULT_RESET);
  // Nothing to sanitize: the same object, and every other engine's left as it came.
  const plain: PlanUsage = { cursor: { provider: AgentProvider.CURSOR, account: 'default' }, claude: { provider: AgentProvider.CLAUDE, fiveHour: { utilization: 3 } } };
  assert.equal(sanitizePlanUsageAccounts(plain), plain);
});

/** A runner as the account helpers read it, reporting `engines` and `planUsage`, with no Default removed
 *  from Orbit. */
const reporting = (engines: unknown, planUsage: unknown = null): AccountRunner =>
  ({ engines, defaultRemoved: [], accountPauses: null, planUsage });

test('P6a Automatic starts a Cursor CLI session on an account with room, never on one a turn met the limit on', () => {
  const leaves = { env: {} };
  // Team has a reading and resets first: it takes the session ...
  assert.equal(automaticAccount('cursor', leaves, reporting(ENGINES, usage()), NOW), TEAM);
  // ... until a turn on it meets Cursor's usage limit: then Default, which has room by all anyone knows.
  assert.equal(automaticAccount('cursor', leaves, reporting(ENGINES, usage({ team: '2026-10-18T09:00:00.000Z' })), NOW), 'default');
  // Default spent (its Free requests, which Cursor still reports as 0%): Team.
  assert.equal(automaticAccount('cursor', leaves, reporting(ENGINES, usage({ default: '2026-10-16T17:52:00.000Z' })), NOW), TEAM);
  // Both spent: the one that frees up first, where the session then waits.
  assert.equal(
    automaticAccount('cursor', leaves, reporting(ENGINES, usage({ default: '2026-10-16T17:52:00.000Z', team: '2026-10-18T09:00:00.000Z' })), NOW),
    TEAM,
  );
  // A workspace whose key runs its sessions leaves nothing to Orbit: an account picked for them would
  // take the key's place (contract §16.3).
  assert.equal(automaticAccount('cursor', { env: { CURSOR_API_KEY: 'key_x' } }, reporting(ENGINES, usage()), NOW), null);
});

test('P6a a Cursor CLI run on an account picked for it is judged on that account, its workspace’s key notwithstanding', () => {
  const spent = usage({ team: '2026-10-18T09:00:00.000Z' });
  const keyed = { CURSOR_API_KEY: 'key_x' };
  // Picked: dispatch hands the runner the account's directory, and the runner its login in the key's place.
  const picked = runAccount('cursor', keyed, { cursorAccount: TEAM }, reporting(ENGINES));
  assert.equal(picked, TEAM);
  assert.deepEqual(planUsageBlockedUntil(spent, 'cursor', NOW, picked), new Date(TEAM_RESET));
  // Not picked: the key runs it, and no account's quota holds it back.
  const onKey = runAccount('cursor', keyed, null, reporting(ENGINES));
  assert.equal(onKey, null);
  assert.equal(planUsageBlockedUntil(spent, 'cursor', NOW, onKey), null);
  // Default, picked or not, is judged on Default's quota, never on Team's.
  assert.equal(runAccount('cursor', {}, { cursorAccount: 'default' }, reporting(ENGINES)), 'default');
  assert.equal(planUsageBlockedUntil(spent, 'cursor', NOW, 'default'), null);
});
