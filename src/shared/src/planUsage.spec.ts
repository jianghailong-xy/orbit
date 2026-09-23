import { describe, expect, it } from 'vitest';
import type { PlanUsage, RunnerEngineAccount } from './dto';
import {
  codexAccountOfEnv,
  codexAccountSnapshot,
  planUsageBlockedUntil,
  planUsageReported,
} from './planUsage';

const NOW = new Date('2026-08-03T13:00:00Z');
const LATER = '2026-08-09T05:26:43Z';
const EARLIER = '2026-08-04T01:00:00Z';

/** Shape of the snapshot a Codex runner actually reports with its weekly limit spent. */
const codexExhausted: PlanUsage = {
  provider: 'codex',
  limitId: 'codex',
  planType: 'pro',
  rateLimitReachedType: 'rate_limit_reached',
  primary: { label: 'Weekly limit', utilization: 100, resetsAt: LATER, windowDurationMins: 10080 },
  rateLimits: [
    { limitId: 'codex', primary: { label: 'Weekly limit', utilization: 100, resetsAt: LATER } },
  ],
  fetchedAt: '2026-08-03T12:22:23Z',
};

describe('planUsageBlockedUntil', () => {
  it('reports the reset time of an exhausted window', () => {
    expect(planUsageBlockedUntil(codexExhausted, 'codex', NOW)).toEqual(new Date(LATER));
  });

  it('is null while the window still has room', () => {
    const usage: PlanUsage = { provider: 'codex', primary: { utilization: 99.9, resetsAt: LATER } };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toBeNull();
  });

  it('waits for the last of several exhausted windows to clear', () => {
    const usage: PlanUsage = {
      provider: 'claude',
      fiveHour: { utilization: 100, resetsAt: EARLIER },
      sevenDay: { utilization: 100, resetsAt: LATER },
    };
    expect(planUsageBlockedUntil(usage, 'claude', NOW)).toEqual(new Date(LATER));
  });

  it('ignores an exhausted window whose reset has already passed', () => {
    const usage: PlanUsage = {
      provider: 'codex',
      primary: { utilization: 100, resetsAt: '2026-08-03T12:00:00Z' },
    };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toBeNull();
  });

  it('does not block when the provider reported no reset time', () => {
    // Nothing defensible to wait for — the caller's failure backoff handles this instead.
    const usage: PlanUsage = { provider: 'codex', primary: { utilization: 100 } };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toBeNull();
  });

  it('reads the per-provider snapshot a multi-runtime runner nests', () => {
    const usage: PlanUsage = {
      claude: { fiveHour: { utilization: 12, resetsAt: LATER } },
      codex: { primary: { utilization: 100, resetsAt: LATER } },
    };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toEqual(new Date(LATER));
    expect(planUsageBlockedUntil(usage, 'claude', NOW)).toBeNull();
  });

  it('never charges one provider with another provider quota', () => {
    // A BYOK slug borrows a built-in runtime but bills its own key, so a spent codex
    // subscription must not hold it back.
    expect(planUsageBlockedUntil(codexExhausted, 'claude', NOW)).toBeNull();
    expect(planUsageBlockedUntil(codexExhausted, 'deepseek', NOW)).toBeNull();
  });

  it('handles a runner that reports no usage at all', () => {
    expect(planUsageBlockedUntil(null, 'codex', NOW)).toBeNull();
    expect(planUsageBlockedUntil({}, 'codex', NOW)).toBeNull();
  });
});

/** Work's slot id, as the runner names a slot it added. */
const WORK = '3fa91c2e';

/** A runner with two Codex accounts: Default's windows as the snapshot's own, Work's under its id. */
const twoAccounts = (defaultUsed: number, workUsed: number): PlanUsage => ({
  provider: 'codex',
  primary: { utilization: defaultUsed, resetsAt: EARLIER, windowDurationMins: 300 },
  accounts: {
    [WORK]: { provider: 'codex', primary: { utilization: workUsed, resetsAt: LATER, windowDurationMins: 300 } },
  },
});

describe('a runner with more than one Codex account', () => {
  it("judges the account a run spends, and Default's windows only for Default", () => {
    const defaultSpent = twoAccounts(100, 8);
    expect(planUsageBlockedUntil(defaultSpent, 'codex', NOW, 'default')).toEqual(new Date(EARLIER));
    // Before accounts every Codex run was Default's, so a caller naming none still asks about Default.
    expect(planUsageBlockedUntil(defaultSpent, 'codex', NOW)).toEqual(new Date(EARLIER));
    expect(planUsageBlockedUntil(defaultSpent, 'codex', NOW, WORK)).toBeNull();

    const workSpent = twoAccounts(62, 100);
    expect(planUsageBlockedUntil(workSpent, 'codex', NOW, WORK)).toEqual(new Date(LATER));
    expect(planUsageBlockedUntil(workSpent, 'codex', NOW, 'default')).toBeNull();
  });

  it('reads the accounts of a multi-runtime runner the same way', () => {
    const { provider: _codex, ...codex } = twoAccounts(100, 8);
    const usage: PlanUsage = { claude: { fiveHour: { utilization: 12, resetsAt: LATER } }, codex };
    expect(planUsageBlockedUntil(usage, 'codex', NOW, 'default')).toEqual(new Date(EARLIER));
    expect(planUsageBlockedUntil(usage, 'codex', NOW, WORK)).toBeNull();
    expect(planUsageReported(usage, 'codex', WORK)).toBe(true);
  });

  it('knows nothing about an account that has not been read, nor about a run on no account', () => {
    const usage = twoAccounts(100, 100);
    for (const account of ['0badf00d', null]) {
      expect(planUsageBlockedUntil(usage, 'codex', NOW, account)).toBeNull();
      expect(planUsageReported(usage, 'codex', account)).toBe(false);
    }
    expect(planUsageReported(usage, 'codex', 'default')).toBe(true);
    // Accounts are Codex's: another runtime's question is answered as before.
    expect(planUsageReported({ provider: 'claude', fiveHour: { utilization: 1 } }, 'claude', null)).toBe(true);
  });

  it("does not call Default reported when the snapshot holds only other accounts", () => {
    const { primary: _default, ...onlyWork } = twoAccounts(0, 100);
    expect(codexAccountSnapshot(onlyWork, 'default')).toBeUndefined();
    expect(planUsageReported(onlyWork, 'codex', 'default')).toBe(false);
    expect(planUsageReported(onlyWork, 'codex')).toBe(false);
    expect(planUsageBlockedUntil(onlyWork, 'codex', NOW, WORK)).toEqual(new Date(LATER));
  });

  it("gives each account its own part, and no account another's", () => {
    const usage = twoAccounts(62, 8);
    expect(codexAccountSnapshot(usage, 'default')).toEqual({
      provider: 'codex',
      primary: { utilization: 62, resetsAt: EARLIER, windowDurationMins: 300 },
    });
    expect(codexAccountSnapshot(usage, WORK)?.primary?.utilization).toBe(8);
    expect(codexAccountSnapshot(usage, 'constructor')).toBeUndefined();
    // A snapshot from before accounts is Default's whole.
    expect(codexAccountSnapshot(codexExhausted, 'default')).toBe(codexExhausted);
  });
});

describe('codexAccountOfEnv', () => {
  const accounts: RunnerEngineAccount[] = [
    { id: 'default', codexHome: '/root/.codex', auth: 'yes' },
    { id: WORK, name: 'Work', codexHome: '/root/.orbit/codex-accounts/3fa91c2e', auth: 'yes' },
  ];

  it('is Default for a session that names no CODEX_HOME, or names Default\'s', () => {
    expect(codexAccountOfEnv(null, accounts)).toBe('default');
    expect(codexAccountOfEnv({ ORBIT_TEST: '1', CODEX_API_KEY: ' ', OPENAI_API_KEY: '' }, accounts)).toBe('default');
    expect(codexAccountOfEnv({ CODEX_HOME: '/root/.codex' }, accounts)).toBe('default');
    expect(codexAccountOfEnv({ HOME: '/root' }, accounts)).toBe('default');
    // An older runner lists no accounts; a session naming none was, and is, Default's.
    expect(codexAccountOfEnv({}, undefined)).toBe('default');
  });

  it('is the account whose CODEX_HOME the session runs in', () => {
    expect(codexAccountOfEnv({ CODEX_HOME: '/root/.orbit/codex-accounts/3fa91c2e' }, accounts)).toBe(WORK);
    expect(codexAccountOfEnv({ CODEX_HOME: '/root/.orbit/./codex-accounts//3fa91c2e/' }, accounts)).toBe(WORK);
  });

  it('is no account for a CODEX_HOME none lives in, or a key of the session\'s own', () => {
    expect(codexAccountOfEnv({ CODEX_HOME: '/srv/codex' }, accounts)).toBeNull();
    expect(codexAccountOfEnv({ HOME: '/home/ada' }, accounts)).toBeNull();
    // Relative to wherever the session runs, which is not known here.
    expect(codexAccountOfEnv({ CODEX_HOME: '.codex' }, accounts)).toBeNull();
    expect(codexAccountOfEnv({ CODEX_HOME: '/root/.codex' }, undefined)).toBeNull();
    expect(codexAccountOfEnv({ CODEX_API_KEY: 'sk-test' }, accounts)).toBeNull();
    expect(codexAccountOfEnv({ CODEX_HOME: '/root/.orbit/codex-accounts/3fa91c2e', OPENAI_BASE_URL: 'https://x.invalid/v1' }, accounts)).toBeNull();
  });
});
