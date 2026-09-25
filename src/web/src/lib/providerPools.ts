import { queryOptions } from '@tanstack/react-query';
import { AgentProvider, type PlanUsageSnapshot } from '@orbit/shared';
import { api } from '../api';
import { routeId } from './idCodec';
import { planUsageRows, type PlanUsageDisplayRow } from './planUsage';
import type { ProviderRow } from './providerAdmin';
import type { ConfiguredProvider } from './workspaceDefaults';

/**
 * Account pools as GET /providers/pools serves them (ProvidersService.poolViews): several of the
 * user's own Claude subscriptions under one slug, each member with its own quota and where it
 * stands. Which member a session starting now runs on (`next`) and when a spent pool frees up
 * (`resetsAt`) are the server's answers — the claim's own selector, asked the way the claim asks
 * it — so nothing here re-derives them.
 */

/** Where one member stands, in the order the claim reads a member. */
export type PoolMemberState = 'REFUSED' | 'DISABLED' | 'SPENT' | 'RUNNING' | 'AVAILABLE' | 'NO_QUOTA';

export interface PoolMember {
  id: string;
  slug: string;
  label: string;
  presetSlug: string | null;
  enabled: boolean;
  /** This account's own quota, read with its own credential. Null when it reports none. */
  planUsage: PlanUsageSnapshot | null;
  state: PoolMemberState;
  /** SPENT only: when this account can take work again — the latest of its spent windows. Null
   *  when a spent window named no reset. */
  resetsAt: string | null;
  /** The member a session starting now would run on. */
  next: boolean;
}

export interface ProviderPool {
  id: string;
  slug: string;
  label: string;
  /** Set only while every member that can run is spent: the EARLIEST of their resets, since one
   *  account freeing up is enough for work to continue. */
  resetsAt: string | null;
  /** Set only when no member can run at all, and no reset will change that — none in it, or each one
   *  disabled, refused by the endpoint, or one the pool would not admit today: why, in a few words.
   *  The server refuses to start or switch a session onto such a pool, or to pin a task to it. */
  unavailable?: string | null;
  members: PoolMember[];
}

/** Under ['providers'], so every provider change — a key, a pool, a quota the server re-read —
 *  refreshes it along with the rest of the catalogue. */
export const PROVIDER_POOLS_KEY = ['providers', 'pools'] as const;

export const providerPoolsQuery = () =>
  queryOptions({
    queryKey: PROVIDER_POOLS_KEY,
    queryFn: () => api<ProviderPool[]>('/providers/pools'),
  });

/** A member that can take work now — what "N of M accounts available" counts. One that reports no
 *  quota counts: the claim still picks it, just last. */
export const canTakeWork = (member: PoolMember): boolean =>
  member.state === 'AVAILABLE' || member.state === 'RUNNING' || member.state === 'NO_QUOTA';

/** How many of the user's keys the server would let into a pool. `poolRefusal` is its verdict,
 *  row by row; a row that carries none (an older server) is not counted. */
export const poolEligibleCount = (rows: readonly ProviderRow[]): number =>
  rows.filter((row) => row.poolRefusal === null).length;

/**
 * The pools as providers a session picker can offer and a composer can run: a pool runs on its
 * members' Claude subscriptions, whose models are the Claude CLI's own — the same model space an
 * Anthropic key has — and it carries no quota of its own (each member has one).
 */
export const poolsAsProviders = (pools: readonly ProviderPool[]): ConfiguredProvider[] =>
  pools.map((pool) => ({
    slug: pool.slug,
    label: pool.label,
    runtime: AgentProvider.CLAUDE,
    models: [],
    defaultModel: null,
    presetSlug: 'anthropic',
    modelsFromRuntime: true,
    planUsage: null,
  }));

/**
 * The account a session on `pool` is on: the member its last claim chose (`current`), or — before
 * its first claim, as for a draft — the member the next claim picks. Null when the recorded member
 * has since left the pool (the next claim chooses again) or no member can run.
 */
export function sessionPoolAccount(
  pool: ProviderPool,
  memberId: string | null | undefined,
): { member: PoolMember; current: boolean } | null {
  if (memberId) {
    const id = routeId(memberId);
    const member = pool.members.find((m) => routeId(m.id) === id);
    return member ? { member, current: true } : null;
  }
  const next = pool.members.find((m) => m.next);
  return next ? { member: next, current: false } : null;
}

/** The gauge a member row shows: the window that stopped a spent member, else the 5-hour window
 *  the pool ranks its members by. */
export function memberQuota(member: PoolMember): PlanUsageDisplayRow | null {
  if (!member.planUsage) return null;
  const rows = planUsageRows(member.planUsage);
  const binding = member.state === 'SPENT' ? rows.find((row) => row.window.utilization >= 100) : undefined;
  return binding ?? rows.find((row) => row.key === 'fiveHour') ?? rows[0] ?? null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** When a window resets, as the page says it: `14:05` within a day, `Mon 14:05` beyond that — a
 *  weekly limit can be days out, and a bare time would read as today. */
export function formatResetTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.getTime() - now < 24 * 60 * 60 * 1000) return time;
  return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

/** A member's status tag: its words and its colour. */
export function memberStatus(member: PoolMember, now?: number): { label: string; color: string } {
  switch (member.state) {
    case 'RUNNING':
      return { label: 'Running now', color: 'processing' };
    case 'AVAILABLE':
      return { label: 'Available', color: 'green' };
    case 'SPENT':
      return {
        label: member.resetsAt ? `Spent · resets ${formatResetTime(member.resetsAt, now)}` : 'Spent',
        color: 'orange',
      };
    case 'REFUSED':
      return { label: 'Unavailable · key refused', color: 'red' };
    case 'DISABLED':
      return { label: 'Disabled', color: 'default' };
    default:
      // Last in line, which is not the same as idle: nothing says how much of it is left.
      return { label: 'No quota reported', color: 'default' };
  }
}

/**
 * What a pool's head says beside "N of M accounts available": the gauge of the member the next
 * session runs on — never an average, which would read 50% for one spent account beside one
 * untouched — or, with none to run on, when the first one frees up.
 */
export type PoolHeadline =
  | { kind: 'next'; member: PoolMember; quota: PlanUsageDisplayRow | null }
  | { kind: 'spent'; resetsAt: string | null }
  | { kind: 'none' };

export function poolHeadline(pool: ProviderPool): PoolHeadline {
  const next = pool.members.find((m) => m.next);
  if (next) return { kind: 'next', member: next, quota: memberQuota(next) };
  if (pool.members.some((m) => m.state === 'SPENT')) return { kind: 'spent', resetsAt: pool.resetsAt };
  return { kind: 'none' };
}
