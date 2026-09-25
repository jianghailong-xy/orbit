import { describe, expect, it } from 'vitest';
import { encodeId } from './idCodec';
import {
  formatResetTime,
  memberQuota,
  memberStatus,
  poolEligibleCount,
  poolHeadline,
  poolsAsProviders,
  sessionPoolAccount,
  type PoolMember,
  type ProviderPool,
} from './providerPools';
import type { ProviderRow } from './providerAdmin';
import { defaultModelForProvider, modelOptionsForProvider, runtimeForProvider } from './workspaceDefaults';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T09:00:00.000Z');
const at = (offset: number) => new Date(NOW + offset).toISOString();
const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);

const member = (n: number, over: Partial<PoolMember> = {}): PoolMember => ({
  id: id(n),
  slug: `anthropic-${n}`,
  label: `Account ${n}`,
  presetSlug: 'anthropic',
  enabled: true,
  planUsage: null,
  state: 'NO_QUOTA',
  resetsAt: null,
  next: false,
  ...over,
});
const fiveHour = (utilization: number, resetsAt = at(2 * HOUR)) => ({
  provider: 'claude' as never,
  fiveHour: { utilization, resetsAt },
});
const pool = (members: PoolMember[], resetsAt: string | null = null): ProviderPool => ({
  id: id(900),
  slug: 'claude-accounts',
  label: 'Claude accounts',
  resetsAt,
  members,
});

describe("a pool's head line", () => {
  it("shows the gauge of the account the next session runs on — never the members' average", () => {
    const spent = member(1, { state: 'SPENT', planUsage: fiveHour(100), resetsAt: at(HOUR) });
    const fresh = member(2, { state: 'AVAILABLE', planUsage: fiveHour(0), next: true });
    const head = poolHeadline(pool([spent, fresh]));
    expect(head.kind).toBe('next');
    if (head.kind !== 'next') return;
    expect(head.member.label).toBe('Account 2');
    // One spent account and one untouched average to 50%, which no account is at.
    expect(head.quota?.percent).toBe(0);
    expect(head.quota?.percent).not.toBe(50);
  });

  it('names the account even when it has no quota to draw', () => {
    const head = poolHeadline(pool([member(1, { next: true })]));
    expect(head).toMatchObject({ kind: 'next', quota: null });
  });

  it("says when a fully spent pool frees up by the pool's own reset — the earliest account's", () => {
    const early = member(1, { state: 'SPENT', planUsage: fiveHour(100), resetsAt: at(HOUR) });
    const late = member(2, { state: 'SPENT', planUsage: fiveHour(100), resetsAt: at(4 * HOUR) });
    expect(poolHeadline(pool([late, early], at(HOUR)))).toEqual({ kind: 'spent', resetsAt: at(HOUR) });
  });

  it('has no account to name when every account is refused or off', () => {
    expect(poolHeadline(pool([member(1, { state: 'REFUSED' }), member(2, { state: 'DISABLED' })]))).toEqual({
      kind: 'none',
    });
    expect(poolHeadline(pool([]))).toEqual({ kind: 'none' });
  });
});

describe("a member's status", () => {
  it('reads each state in words', () => {
    expect(memberStatus(member(1, { state: 'RUNNING' })).label).toBe('Running now');
    expect(memberStatus(member(1, { state: 'AVAILABLE' })).label).toBe('Available');
    expect(memberStatus(member(1, { state: 'REFUSED' })).label).toBe('Unavailable · key refused');
    expect(memberStatus(member(1, { state: 'NO_QUOTA' })).label).toBe('No quota reported');
    expect(memberStatus(member(1, { state: 'SPENT', resetsAt: null })).label).toBe('Spent');
    const resets = at(90 * 60 * 1000);
    expect(memberStatus(member(1, { state: 'SPENT', resetsAt: resets }), NOW).label).toBe(
      `Spent · resets ${formatResetTime(resets, NOW)}`,
    );
  });

  it('says a reset time as HH:MM, with the day once it is more than a day out', () => {
    const soon = new Date(NOW + 90 * 60 * 1000);
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(formatResetTime(soon.toISOString(), NOW)).toBe(hhmm(soon));
    const later = new Date(NOW + 3 * 24 * HOUR);
    expect(formatResetTime(later.toISOString(), NOW)).toBe(
      `${later.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(later)}`,
    );
  });

  it("draws a spent account's binding window, and anyone else's 5-hour window", () => {
    const weeklySpent = member(1, {
      state: 'SPENT',
      planUsage: { ...fiveHour(40), sevenDay: { utilization: 100, resetsAt: at(48 * HOUR) } },
    });
    expect(memberQuota(weeklySpent)?.key).toBe('sevenDay');
    const busy = member(2, {
      state: 'AVAILABLE',
      planUsage: { ...fiveHour(40), sevenDay: { utilization: 95 } },
    });
    expect(memberQuota(busy)).toMatchObject({ key: 'fiveHour', percent: 40, nearLimit: false });
    expect(memberQuota(member(3))).toBeNull();
  });
});

describe('the account a session on a pool is on', () => {
  const work = member(1, { label: 'Work', state: 'RUNNING', planUsage: fiveHour(70) });
  const home = member(2, { label: 'Home', state: 'AVAILABLE', planUsage: fiveHour(20), next: true });
  const claude = pool([work, home]);

  it('is the member its last claim recorded — not the pool, and not the pool\'s next pick', () => {
    const account = sessionPoolAccount(claude, work.id);
    expect(account).toEqual({ member: work, current: true });
    expect(account?.member.label).not.toBe(claude.label);
  });

  it('matches the recorded member whichever id spelling it arrives in', () => {
    expect(sessionPoolAccount(claude, '0195c0de-0000-7000-8000-000000000001')?.member).toBe(work);
  });

  it('is the one the claim will pick before there has been a claim', () => {
    expect(sessionPoolAccount(claude, null)).toEqual({ member: home, current: false });
  });

  it('is nobody once the recorded member has left the pool', () => {
    expect(sessionPoolAccount(claude, id(77))).toBeNull();
  });
});

describe('a pool as a provider the composer can run', () => {
  const providers = poolsAsProviders([pool([member(1)])]);
  const catalog = { claude: [{ value: 'claude-opus-5', label: 'Opus 5' }] } as never;

  it("runs on Claude, with the Claude CLI's own models", () => {
    expect(runtimeForProvider('claude-accounts', providers)).toBe('claude');
    expect(modelOptionsForProvider('claude-accounts', catalog, providers)).toEqual([
      { value: 'claude-opus-5', label: 'Opus 5' },
    ]);
    expect(defaultModelForProvider('claude-accounts', catalog, providers)).toBe('claude-opus-5');
  });

  it('carries no quota of its own', () => {
    expect(providers[0].planUsage).toBeNull();
  });
});

describe('which keys could join a pool', () => {
  const row = (poolRefusal: ProviderRow['poolRefusal']) => ({ poolRefusal }) as ProviderRow;
  it("counts the server's verdict, and nothing it didn't give", () => {
    expect(
      poolEligibleCount([
        row(null),
        row(null),
        row({ reason: 'NOT_SUBSCRIPTION_TOKEN', message: 'Metered API key — no 5-hour window' }),
        row(undefined),
      ]),
    ).toBe(2);
  });
});
