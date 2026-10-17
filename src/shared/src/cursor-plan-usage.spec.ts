import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlanUsage, RunnerEngineAccount } from './dto';
import {
  accountOfEnv,
  accountToStartOn,
  planUsageBlockedUntil,
  planUsageReported,
  quotaExpiresAt,
  quotaNearLimit,
  spentPlanUsage,
  usageLimitResetsAt,
} from './planUsage';

// Cursor CLI's quota, read per account from Cursor's dashboard (docs/cursor-runtime-contract.md §11;
// project P6a). The acceptance script (scripts/test-cursor-quota.mjs) runs every case below by name.

/**
 * `cursor-plan-usage.fixture.json` is Cursor CLI quota from end to end: src/runner-go turns each case's
 * dashboard answers and usage limits met into its `planUsage` heartbeat (cursor_usage_test.go), and from
 * that heartbeat the control plane has to start sessions on, hold runs back from and retry on the
 * accounts the case says.
 */
describe('cursor-plan-usage.fixture.json', () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, 'cursor-plan-usage.fixture.json'), 'utf8')) as {
    now: string;
    accounts: RunnerEngineAccount[];
    cases: Array<{
      name: string;
      planUsage: PlanUsage;
      startOn: string;
      blockedUntil: Record<string, string | null>;
      reported: Record<string, boolean>;
      resetsAt: Record<string, string | null>;
    }>;
  };
  const now = new Date(fixture.now);
  const at = (iso: string | null) => (iso === null ? null : Date.parse(iso));

  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(accountToStartOn('cursor', fixture.accounts, c.planUsage, now)).toBe(c.startOn);
      for (const [account, until] of Object.entries(c.blockedUntil)) {
        expect(planUsageBlockedUntil(c.planUsage, 'cursor', now, account)?.getTime() ?? null, account).toBe(at(until));
      }
      for (const [account, reported] of Object.entries(c.reported)) {
        expect(planUsageReported(c.planUsage, 'cursor', account), account).toBe(reported);
      }
      for (const [account, resets] of Object.entries(c.resetsAt)) {
        expect(usageLimitResetsAt(c.planUsage, 'cursor', now, account)?.getTime() ?? null, account).toBe(at(resets));
      }
    });
  }
});

const NOW = new Date('2026-10-18T12:00:00.000Z');
const WEEK_END = '2026-10-24T01:32:16.338Z';
const DEFAULT_DIR = '/root/.orbit/cursor/default';
const TEAM = 'c41e0b7a';
const TEAM_DIR = `/root/.orbit/cursor-accounts/${TEAM}`;
const accounts: RunnerEngineAccount[] = [
  { id: 'default', home: DEFAULT_DIR, auth: 'yes' },
  { id: TEAM, name: 'Team', home: TEAM_DIR, auth: 'yes' },
];

describe('Cursor CLI quota', () => {
  it('P6a what Cursor does not report is unavailable, never 0', () => {
    // A Free account as Cursor answers it: a plan and a period, no share used (0% is no reading, so the
    // runner sends none), and nothing met yet.
    const usage: PlanUsage = {
      cursor: {
        provider: 'cursor',
        account: 'default',
        planName: 'Free',
        includedUsage: { startsAt: '2026-09-24T16:32:26.082Z', resetsAt: '2026-10-24T16:32:26.082Z' },
      },
    };
    const own = spentPlanUsage(usage, 'cursor', 'default');
    expect(own?.includedUsage?.percentUsed).toBeUndefined();
    // Nothing to weigh it by: no reading is not room, and not near any limit.
    expect(quotaExpiresAt(own, NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(quotaNearLimit(own, NOW)).toBe(false);
    expect(planUsageBlockedUntil(usage, 'cursor', NOW, 'default')).toBeNull();
    // Reported, for it says when its usage resets ...
    expect(planUsageReported(usage, 'cursor', 'default')).toBe(true);
    // ... which an account Cursor never answered for does not, nor one whose answer named no reset.
    expect(planUsageReported(usage, 'cursor', TEAM)).toBe(false);
    expect(planUsageReported({ cursor: { provider: 'cursor', account: 'default', planName: 'Free' } }, 'cursor', 'default')).toBe(false);
    expect(planUsageReported(null, 'cursor', 'default')).toBe(false);
    // A 0 that reaches here anyway — a runner that sent one — is no reading either.
    const zero: PlanUsage = {
      cursor: { provider: 'cursor', account: 'default', includedUsage: { period: 'weekly', resetsAt: WEEK_END, percentUsed: 0 } },
    };
    expect(quotaExpiresAt(spentPlanUsage(zero, 'cursor', 'default'), NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(accountToStartOn('cursor', accounts, {
      cursor: { ...zero.cursor, accounts: { [TEAM]: { provider: 'cursor', account: TEAM, includedUsage: { period: 'monthly', resetsAt: '2026-11-02T08:00:00.000Z', percentUsed: 12 } } } },
    }, NOW)).toBe(TEAM);
  });

  it('P6a a run that just met its usage limit is retried when its account’s included usage resets', () => {
    // The turn is reported before the snapshot that counts it: by the snapshot the account is not spent
    // yet, and the retry still goes at its reset — never at another account's.
    const usage: PlanUsage = {
      cursor: {
        provider: 'cursor',
        account: 'default',
        includedUsage: { period: 'weekly', resetsAt: WEEK_END },
        accounts: { [TEAM]: { provider: 'cursor', account: TEAM, includedUsage: { resetsAt: '2026-11-02T08:00:00.000Z' } } },
      },
    };
    expect(planUsageBlockedUntil(usage, 'cursor', NOW, 'default')).toBeNull();
    expect(usageLimitResetsAt(usage, 'cursor', NOW, 'default')).toEqual(new Date(WEEK_END));
    expect(usageLimitResetsAt(usage, 'cursor', NOW, TEAM)).toEqual(new Date('2026-11-02T08:00:00.000Z'));
    // A limit met before the account's period began says nothing of this one: it holds nothing back.
    const old: PlanUsage = {
      cursor: {
        provider: 'cursor',
        account: 'default',
        includedUsage: { startsAt: '2026-10-17T01:32:16.338Z', resetsAt: WEEK_END, limitReachedAt: '2026-10-16T17:52:00.000Z' },
      },
    };
    expect(planUsageBlockedUntil(old, 'cursor', NOW, 'default')).toBeNull();
    expect(accountToStartOn('cursor', accounts, { cursor: { ...old.cursor, accounts: { [TEAM]: { provider: 'cursor', account: TEAM, includedUsage: { resetsAt: '2026-11-02T08:00:00.000Z', limitReachedAt: '2026-10-18T09:00:00.000Z' } } } } }, NOW)).toBe('default');
    // A reset already behind us names no moment, nor does a run on no account of the runner's.
    expect(usageLimitResetsAt(usage, 'cursor', new Date('2026-10-24T02:00:00.000Z'), 'default')).toBeNull();
    expect(usageLimitResetsAt(usage, 'cursor', NOW, null)).toBeNull();
    // Every other engine is retried as before: at the reset of its spent windows.
    const claude: PlanUsage = { claude: { provider: 'claude', fiveHour: { utilization: 40, resetsAt: '2026-10-18T15:00:00.000Z' } } };
    expect(usageLimitResetsAt(claude, 'claude', NOW)).toBeNull();
    const spent: PlanUsage = { claude: { provider: 'claude', fiveHour: { utilization: 100, resetsAt: '2026-10-18T15:00:00.000Z' } } };
    expect(usageLimitResetsAt(spent, 'claude', NOW)).toEqual(new Date('2026-10-18T15:00:00.000Z'));
  });

  it('P6a a Cursor CLI run on an account it names spends that account, whatever key its workspace sets; one naming none spends no account on that key', () => {
    // The runner hands the CLI a named account's login in place of a workspace's CURSOR_API_KEY or
    // CURSOR_AUTH_TOKEN (contract §16.3), so its quota, Automatic and the usage limit are that account's.
    for (const env of [{ CURSOR_API_KEY: 'key_x' }, { CURSOR_AUTH_TOKEN: 'token_x' }]) {
      expect(accountOfEnv('cursor', { ...env, ORBIT_CURSOR_ACCOUNT_DIR: TEAM_DIR }, accounts)).toBe(TEAM);
      // Naming none — or Default, which the runner reads only with no credential in the environment — the
      // key runs it, and no account is spent.
      expect(accountOfEnv('cursor', env, accounts)).toBeNull();
      expect(accountOfEnv('cursor', { ...env, ORBIT_CURSOR_ACCOUNT_DIR: DEFAULT_DIR }, accounts)).toBeNull();
      // A directory that is none of the runner's accounts runs nothing: the runner refuses it.
      expect(accountOfEnv('cursor', { ...env, ORBIT_CURSOR_ACCOUNT_DIR: '/srv/typed-by-hand' }, accounts)).toBeNull();
    }
    expect(accountOfEnv('cursor', { ORBIT_CURSOR_ACCOUNT_DIR: TEAM_DIR }, accounts)).toBe(TEAM);
    expect(accountOfEnv('cursor', {}, accounts)).toBe('default');
    // Its spent quota holds back the account it names, and only that one.
    const usage: PlanUsage = {
      cursor: {
        provider: 'cursor',
        account: 'default',
        includedUsage: { resetsAt: '2026-10-24T16:32:26.082Z' },
        accounts: { [TEAM]: { provider: 'cursor', account: TEAM, includedUsage: { period: 'weekly', resetsAt: WEEK_END, limitReachedAt: '2026-10-18T09:00:00.000Z' } } },
      },
    };
    const spends = accountOfEnv('cursor', { CURSOR_API_KEY: 'key_x', ORBIT_CURSOR_ACCOUNT_DIR: TEAM_DIR }, accounts);
    expect(planUsageBlockedUntil(usage, 'cursor', NOW, spends)).toEqual(new Date(WEEK_END));
    expect(planUsageBlockedUntil(usage, 'cursor', NOW, accountOfEnv('cursor', { CURSOR_API_KEY: 'key_x' }, accounts))).toBeNull();
    // Other engines keep their rule: a credential in the environment spends no account, named or not.
    expect(accountOfEnv('codex', { CODEX_HOME: '/root/.orbit/codex-accounts/c41e0b7a', OPENAI_API_KEY: 'k' }, [
      { id: 'default', home: '/root/.codex', auth: 'yes' },
      { id: TEAM, home: '/root/.orbit/codex-accounts/c41e0b7a', auth: 'yes' },
    ])).toBeNull();
  });
});
