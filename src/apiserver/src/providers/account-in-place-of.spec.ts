import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, type PlanUsage, type RunnerEngineHealth } from '@orbit/shared';
import { accountInPlaceOf, type AccountRunner } from './account';
import { accountSwitchNotice } from './plan-usage-accounts';

/**
 * Where a session goes when the account it is on is being removed from its runner (accountInPlaceOf):
 * another of that runner's accounts of the same engine, signed in, as Automatic ranks them — never the
 * account being removed, and never a Default its owner removed from Orbit.
 */

const NOW = new Date('2026-11-17T08:00:00Z');
const LEAVING = '1fda3f43';
const WORK = '3fa91c2e';
const TEAM = '7b02d9e1';

function codex(accounts: Array<[string, 'yes' | 'no']>): RunnerEngineHealth {
  return {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: accounts.map(([id, auth]) => ({ id, home: `/root/.orbit/codex-accounts/${id}`, codexHome: `/root/.orbit/codex-accounts/${id}`, auth })),
  };
}

function runner(engine: RunnerEngineHealth, options: { removed?: string[]; planUsage?: PlanUsage } = {}): AccountRunner & { accountNames: unknown } {
  return { engines: [engine], defaultRemoved: options.removed ?? [], accountPauses: null, planUsage: options.planUsage ?? null, accountNames: null };
}

test('the one other signed-in account takes the sessions of the account being removed', () => {
  const on = runner(codex([['default', 'yes'], [LEAVING, 'yes']]));
  assert.equal(accountInPlaceOf('codex', on, LEAVING, NOW), 'default');
});

test('a signed-out account, and a Default removed from Orbit, take none', () => {
  assert.equal(accountInPlaceOf('codex', runner(codex([['default', 'yes'], [LEAVING, 'yes'], [WORK, 'no']])), LEAVING, NOW), 'default');
  assert.equal(
    accountInPlaceOf('codex', runner(codex([['default', 'yes'], [LEAVING, 'yes'], [WORK, 'yes']]), { removed: ['codex'] }), LEAVING, NOW),
    WORK,
  );
  assert.equal(accountInPlaceOf('codex', runner(codex([['default', 'no'], [LEAVING, 'yes']])), LEAVING, NOW), null, 'nowhere to go');
  assert.equal(accountInPlaceOf('codex', runner(codex([[LEAVING, 'yes']]), { removed: ['codex'] }), LEAVING, NOW), null);
});

test('among several, Automatic’s ranking decides: not one whose window is spent', () => {
  const spent = { utilization: 100, resetsAt: '2099-01-01T09:00:00.000Z', windowDurationMins: 300 };
  const room = { utilization: 10, resetsAt: '2099-01-01T12:00:00.000Z', windowDurationMins: 300 };
  const planUsage = {
    codex: {
      provider: AgentProvider.CODEX,
      primary: spent,
      accounts: { [WORK]: { provider: AgentProvider.CODEX, primary: spent }, [TEAM]: { provider: AgentProvider.CODEX, primary: room } },
    },
  } as PlanUsage;
  const on = runner(codex([['default', 'yes'], [LEAVING, 'yes'], [WORK, 'yes'], [TEAM, 'yes']]), { planUsage });
  assert.equal(accountInPlaceOf('codex', on, LEAVING, NOW), TEAM);
});

test('the session is told why it moved', () => {
  const on = runner(codex([['default', 'yes'], [LEAVING, 'yes']]));
  assert.equal(
    accountSwitchNotice('codex', { from: LEAVING, to: 'default', removed: true }, on),
    `Switched to Default — Account ${LEAVING} is being removed`,
  );
});
