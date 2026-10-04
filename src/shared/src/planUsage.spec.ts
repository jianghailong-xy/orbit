import { describe, expect, it } from 'vitest';
import type { PlanUsage, RunnerEngineAccount } from './dto';
import {
  accountOfEnv,
  codexAccountOfEnv,
  codexAccountSnapshot,
  planUsageBlockedUntil,
  planUsageReported,
  codexAccountToMoveTo,
  codexAccountToStartOn,
  accountToStartOn,
  quotaExpiresAt,
  quotaNearLimit,
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
    // An engine that keeps one login for the machine has no accounts: its question is answered as before.
    expect(planUsageReported({ provider: 'kimi', primary: { utilization: 1 } }, 'kimi', null)).toBe(true);
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

describe('a runner with more than one Claude account', () => {
  /** Default's windows as the Claude snapshot's own, Work's under its id — the shape the runner
   *  reports (src/runner-go/claude_account_usage.go), nested beside a Codex snapshot. */
  const claudeAccounts = (defaultUsed: number, workUsed: number): PlanUsage => ({
    claude: {
      fiveHour: { utilization: defaultUsed, resetsAt: EARLIER },
      accounts: { [WORK]: { fiveHour: { utilization: workUsed, resetsAt: LATER } } },
    },
    codex: { primary: { utilization: 3, resetsAt: LATER } },
  });

  it("judges the account a run spends, and Default's windows only for Default", () => {
    const defaultSpent = claudeAccounts(100, 8);
    expect(planUsageBlockedUntil(defaultSpent, 'claude', NOW, 'default')).toEqual(new Date(EARLIER));
    expect(planUsageBlockedUntil(defaultSpent, 'claude', NOW)).toEqual(new Date(EARLIER));
    expect(planUsageBlockedUntil(defaultSpent, 'claude', NOW, WORK)).toBeNull();

    const workSpent = claudeAccounts(62, 100);
    expect(planUsageBlockedUntil(workSpent, 'claude', NOW, WORK)).toEqual(new Date(LATER));
    expect(planUsageBlockedUntil(workSpent, 'claude', NOW, 'default')).toBeNull();
  });

  it("starts a session on the account whose week ends first, until that one's 5-hour window passes 80%", () => {
    const accounts: RunnerEngineAccount[] = [
      { id: 'default', home: '/root/.claude', auth: 'yes' },
      { id: WORK, home: `/root/.orbit/claude-accounts/${WORK}`, auth: 'yes' },
    ];
    /** 2026-10-02 on wikova, in miniature: Work's week ends days before Default's, and every new
     *  session went to Work while Default sat at 1% of its 5 hours. */
    const usage = (workFiveHour: number): PlanUsage => ({
      claude: {
        fiveHour: { utilization: 1, resetsAt: EARLIER },
        sevenDay: { utilization: 0, resetsAt: '2026-08-09T03:59:59Z' },
        accounts: {
          [WORK]: {
            fiveHour: { utilization: workFiveHour, resetsAt: EARLIER },
            sevenDay: { utilization: 59, resetsAt: '2026-08-06T21:59:59Z' },
          },
        },
      },
    });
    expect(accountToStartOn('claude', accounts, usage(79), NOW)).toBe(WORK);
    expect(accountToStartOn('claude', accounts, usage(85), NOW)).toBe('default');
  });

  it('knows nothing about an account that has not been read, nor about a run on a key of its own', () => {
    const usage = claudeAccounts(100, 100);
    for (const account of ['0badf00d', null]) {
      expect(planUsageBlockedUntil(usage, 'claude', NOW, account)).toBeNull();
      expect(planUsageReported(usage, 'claude', account)).toBe(false);
    }
    expect(planUsageReported(usage, 'claude', WORK)).toBe(true);
  });
});

describe('accountOfEnv', () => {
  // The same rule for every engine whose CLI keeps one login per directory.
  const claudeAccounts: RunnerEngineAccount[] = [
    { id: 'default', home: '/root/.claude', auth: 'yes' },
    { id: WORK, name: 'Work', home: '/root/.orbit/claude-accounts/3fa91c2e', auth: 'yes' },
  ];

  it('names the Claude account a session\'s CLAUDE_CONFIG_DIR selects', () => {
    expect(accountOfEnv('claude', null, claudeAccounts)).toBe('default');
    expect(accountOfEnv('claude', { HOME: '/root' }, claudeAccounts)).toBe('default');
    expect(accountOfEnv('claude', { CLAUDE_CONFIG_DIR: '/root/.orbit/claude-accounts/3fa91c2e' }, claudeAccounts)).toBe(WORK);
    // One engine's variable says nothing about another's account.
    expect(accountOfEnv('claude', { CODEX_HOME: '/root/.orbit/claude-accounts/3fa91c2e' }, claudeAccounts)).toBe('default');
    expect(accountOfEnv('codex', { CLAUDE_CONFIG_DIR: '/root/.orbit/claude-accounts/3fa91c2e' }, claudeAccounts)).toBe('default');
  });

  it('is no account for a login of the session\'s own, or an engine that keeps none', () => {
    expect(accountOfEnv('claude', { ANTHROPIC_AUTH_TOKEN: 'tok' }, claudeAccounts)).toBeNull();
    expect(accountOfEnv('claude', { ANTHROPIC_BASE_URL: 'https://x.invalid' }, claudeAccounts)).toBeNull();
    expect(accountOfEnv('claude', { CLAUDE_CONFIG_DIR: '/srv/claude' }, claudeAccounts)).toBeNull();
    // Kimi keeps one login for the whole machine: nothing to name.
    expect(accountOfEnv('kimi', { KIMI_CODE_HOME: '/root/.kimi-code' }, claudeAccounts)).toBeNull();
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

describe('quotaExpiresAt — when what an account has left goes to waste', () => {
  const IN_TWO_HOURS = '2026-08-03T15:00:00Z';
  const IN_THREE_DAYS = '2026-08-06T13:00:00Z';

  it("is the reset of the account's longest window: its week, not its 5 hours", () => {
    const claude = {
      provider: 'claude' as const,
      fiveHour: { utilization: 40, resetsAt: IN_TWO_HOURS },
      sevenDay: { utilization: 10, resetsAt: IN_THREE_DAYS },
    };
    expect(quotaExpiresAt(claude, NOW)).toBe(Date.parse(IN_THREE_DAYS));
    const codex = {
      provider: 'codex' as const,
      primary: { utilization: 40, windowDurationMins: 300, resetsAt: IN_TWO_HOURS },
      secondary: { utilization: 10, windowDurationMins: 10080, resetsAt: IN_THREE_DAYS },
    };
    expect(quotaExpiresAt(codex, NOW)).toBe(Date.parse(IN_THREE_DAYS));
    // A Pro login reporting a weekly window alone.
    expect(quotaExpiresAt({ provider: 'codex', primary: codex.secondary }, NOW)).toBe(Date.parse(IN_THREE_DAYS));
  });

  it('is never, for nothing known to expire: no reading, no reset, or a reset already behind us', () => {
    expect(quotaExpiresAt(null, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(quotaExpiresAt({ provider: 'claude', fiveHour: { utilization: 40 } }, NOW)).toBe(Number.POSITIVE_INFINITY);
    const lapsedWeek = {
      provider: 'claude' as const,
      fiveHour: { utilization: 40, resetsAt: IN_TWO_HOURS },
      sevenDay: { utilization: 10, resetsAt: '2026-08-03T12:00:00Z' },
    };
    // The week it describes is over, so the 5 hours are what is left to go by.
    expect(quotaExpiresAt(lapsedWeek, NOW)).toBe(Date.parse(IN_TWO_HOURS));
  });

  it('calls a 5-hour window nearly spent at 80%, a longer one at 90%, until its reset has passed', () => {
    const claude = (fiveHour: number, sevenDay: number) => ({
      provider: 'claude' as const,
      fiveHour: { utilization: fiveHour, resetsAt: IN_TWO_HOURS },
      sevenDay: { utilization: sevenDay, resetsAt: IN_THREE_DAYS },
    });
    expect(quotaNearLimit(claude(79, 89), NOW)).toBe(false);
    expect(quotaNearLimit(claude(80, 0), NOW)).toBe(true);
    expect(quotaNearLimit(claude(0, 90), NOW)).toBe(true);
    // By the window's length, never its slot: Codex reports a Plus login's 5-hour window and a Pro
    // login's weekly one alike, as its `primary`.
    const codex = (utilization: number, windowDurationMins?: number) => ({
      provider: 'codex' as const,
      primary: { utilization, resetsAt: IN_TWO_HOURS, ...(windowDurationMins ? { windowDurationMins } : {}) },
    });
    expect(quotaNearLimit(codex(80, 300), NOW)).toBe(true);
    expect(quotaNearLimit(codex(89, 10080), NOW)).toBe(false);
    expect(quotaNearLimit(codex(90, 10080), NOW)).toBe(true);
    // One that does not say how long it is is held to the longer windows' mark.
    expect(quotaNearLimit(codex(89), NOW)).toBe(false);
    const lapsed = { provider: 'claude' as const, fiveHour: { utilization: 100, resetsAt: '2026-08-03T12:00:00Z' } };
    expect(quotaNearLimit(lapsed, NOW)).toBe(false);
    expect(quotaNearLimit(null, NOW)).toBe(false);
  });
});

describe('codexAccountToStartOn — where a session with no account picked starts', () => {
  const PRO = '1fda3f43';
  const account = (id: string, auth: 'yes' | 'no' | 'unknown' = 'yes'): RunnerEngineAccount => ({
    id,
    home: id === 'default' ? '/root/.codex' : `/root/.orbit/codex-accounts/${id}`,
    auth,
  });
  const both = [account('default'), account(PRO)];
  const win = (utilization: number, mins: number, resetsAt: string | undefined = LATER) => ({
    utilization,
    windowDurationMins: mins,
    ...(resetsAt ? { resetsAt } : {}),
  });
  /** Default a Plus login (a 5-hour and a weekly window), Pro reporting only a weekly one. */
  const usage = (fiveHour: number, weekly: number, pro: number | null, proReset?: string): PlanUsage => ({
    codex: {
      provider: 'codex',
      primary: win(fiveHour, 300, EARLIER),
      secondary: win(weekly, 10080),
      ...(pro === null ? {} : { accounts: { [PRO]: { provider: 'codex', primary: win(pro, 10080, proReset) } } }),
    },
  });

  it('spends the quota that resets soonest first, so none of it goes unused', () => {
    // Pro's week ends in two days, Default's in six: Pro, though it has used more of it. Default's
    // 5-hour window resets sooner still, and loses nothing its week does not cap anyway.
    expect(codexAccountToStartOn(both, usage(5, 18, 40, '2026-08-05T13:00:00Z'), NOW)).toBe(PRO);
    expect(codexAccountToStartOn(both, usage(5, 18, 40, '2026-08-10T00:00:00Z'), NOW)).toBe('default');
  });

  it('takes an account with a window nearly spent last, however soon it resets', () => {
    expect(codexAccountToStartOn(both, usage(5, 18, 92, '2026-08-05T13:00:00Z'), NOW)).toBe('default');
    expect(codexAccountToStartOn(both, usage(95, 18, 40), NOW)).toBe(PRO);
    // Last is still a place: it takes the run over a spent account.
    expect(codexAccountToStartOn(both, usage(100, 18, 92), NOW)).toBe(PRO);
  });

  it("leaves the last fifth of a Plus login's 5 hours to the sessions already on it, and a Pro login's week its last tenth", () => {
    // Default's week ends first, so it takes the run — until its 5-hour window passes 80%.
    expect(codexAccountToStartOn(both, usage(79, 18, 40, '2026-08-10T00:00:00Z'), NOW)).toBe('default');
    expect(codexAccountToStartOn(both, usage(80, 18, 40, '2026-08-10T00:00:00Z'), NOW)).toBe(PRO);
    // Pro reports its week in the slot Plus reports its 5 hours in: at 85% it is not nearly spent, and
    // its week ending first still takes the run.
    expect(codexAccountToStartOn(both, usage(5, 18, 85, '2026-08-05T13:00:00Z'), NOW)).toBe(PRO);
  });

  it("passes over a spent account, and on equal expiry ranks the rest by each one's tightest window", () => {
    // Default's 5-hour window spent: Pro, whatever its weekly use.
    expect(codexAccountToStartOn(both, usage(100, 18, 70), NOW)).toBe(PRO);
    // Default's tightest window is its weekly 18%, Pro's its weekly 0%.
    expect(codexAccountToStartOn(both, usage(5, 18, 0), NOW)).toBe(PRO);
    // Pro has used more of its only window than Default of either of its own.
    expect(codexAccountToStartOn(both, usage(5, 18, 40), NOW)).toBe('default');
    // A tie goes to Default.
    expect(codexAccountToStartOn(both, usage(18, 18, 18), NOW)).toBe('default');
  });

  it('ranks an account nothing was read for after every one with room, but still takes it over a spent one', () => {
    expect(codexAccountToStartOn(both, usage(79, 18, null), NOW)).toBe('default');
    // Ahead of one nearly spent, though: nothing says the unread one is.
    expect(codexAccountToStartOn(both, usage(80, 18, null), NOW)).toBe(PRO);
    expect(codexAccountToStartOn(both, usage(100, 18, null), NOW)).toBe(PRO);
  });

  it('never picks an account the CLI says is signed out', () => {
    expect(codexAccountToStartOn([account('default'), account(PRO, 'no')], usage(90, 18, 0), NOW)).toBe('default');
    expect(codexAccountToStartOn([account('default', 'no'), account(PRO, 'no')], usage(0, 0, 0), NOW)).toBeNull();
  });

  it('with every account spent, starts where the first window frees up', () => {
    // Default's 5-hour window resets EARLIER, Pro's weekly LATER.
    expect(codexAccountToStartOn(both, usage(100, 18, 100), NOW)).toBe('default');
    expect(codexAccountToStartOn(both, usage(100, 18, 100, '2026-08-03T14:00:00Z'), NOW)).toBe(PRO);
  });

  it('counts a spent window with no reset time as spent, and one past its reset as not', () => {
    const noReset: PlanUsage = {
      codex: { provider: 'codex', primary: win(100, 300, undefined), accounts: { [PRO]: { provider: 'codex', primary: win(60, 10080) } } },
    };
    expect(codexAccountToStartOn(both, noReset, NOW)).toBe(PRO);
    // Past its reset, a full window is no longer spent: Default, read, beats Pro, unread.
    const lapsed: PlanUsage = { codex: { provider: 'codex', primary: win(100, 300, '2026-08-03T12:00:00Z') } };
    expect(codexAccountToStartOn(both, lapsed, NOW)).toBe('default');
  });

  it('has nothing to choose with fewer than two accounts', () => {
    expect(codexAccountToStartOn([account('default')], usage(100, 18, null), NOW)).toBeNull();
    expect(codexAccountToStartOn([], usage(100, 18, null), NOW)).toBeNull();
    expect(codexAccountToStartOn(undefined, null, NOW)).toBeNull();
  });
});

describe('codexAccountToMoveTo — where a session whose account hit its limit goes, between turns', () => {
  const PRO = '1fda3f43';
  const WORK = '3fa91c2e';
  const account = (id: string, auth: 'yes' | 'no' | 'unknown' = 'yes'): RunnerEngineAccount => ({
    id,
    home: id === 'default' ? '/root/.codex' : `/root/.orbit/codex-accounts/${id}`,
    auth,
  });
  const three = [account('default'), account(PRO), account(WORK)];
  const win = (utilization: number, resetsAt = LATER) => ({ utilization, windowDurationMins: 300, resetsAt });
  const usage = (def: number, pro: number, work: number): PlanUsage => ({
    codex: {
      provider: 'codex',
      primary: win(def),
      accounts: {
        [PRO]: { provider: 'codex', primary: win(pro) },
        [WORK]: { provider: 'codex', primary: win(work) },
      },
    },
  });

  it('moves to the other account a new session would start on, never back onto the one it leaves', () => {
    expect(codexAccountToMoveTo(three, usage(100, 40, 10), NOW, 'default')).toBe(WORK);
    // The one whose quota resets soonest, as a new session's start: Pro's window ends first.
    const proEndsSooner: PlanUsage = {
      codex: {
        provider: 'codex',
        primary: win(100),
        accounts: { [PRO]: { provider: 'codex', primary: win(40, EARLIER) }, [WORK]: { provider: 'codex', primary: win(10) } },
      },
    };
    expect(codexAccountToMoveTo(three, proEndsSooner, NOW, 'default')).toBe(PRO);
    // The account being left ranks first on paper (its snapshot has not caught up with the limit yet),
    // and is still passed over: the run just said it is spent.
    expect(codexAccountToMoveTo(three, usage(5, 40, 10), NOW, 'default')).toBe(WORK);
    expect(codexAccountToMoveTo(three, usage(100, 40, 10), NOW, WORK)).toBe(PRO);
  });

  it('never moves onto a spent or signed-out account: then the session waits for its own reset', () => {
    expect(codexAccountToMoveTo(three, usage(100, 100, 100), NOW, 'default')).toBeNull();
    expect(codexAccountToMoveTo([account('default'), account(PRO, 'no')], usage(100, 0, 0), NOW, 'default')).toBeNull();
  });

  it('takes an account nothing was read for, over none at all', () => {
    const unread: PlanUsage = { codex: { provider: 'codex', primary: win(100) } };
    expect(codexAccountToMoveTo([account('default'), account(PRO)], unread, NOW, 'default')).toBe(PRO);
  });

  it('has nowhere to go without a second account', () => {
    expect(codexAccountToMoveTo([account('default')], usage(100, 0, 0), NOW, 'default')).toBeNull();
    expect(codexAccountToMoveTo(undefined, null, NOW, 'default')).toBeNull();
  });
});
