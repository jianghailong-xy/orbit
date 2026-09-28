import { queryOptions } from '@tanstack/react-query';
import { AgentProvider, type PlanUsageSnapshot } from '@orbit/shared';
import { api } from '../api';
import type { PoolMember, PoolMemberState, ProviderPool } from './providerPools';

/**
 * Shared pools as GET /providers/shared-pools serves them (SharedPoolsService, migration 0320):
 * organization/project OpenAI API keys several Orbit users run Codex on through the pool gateway.
 * Who is in a pool, where each key stands, what the others spent on it this month, which key a session
 * the viewer starts now runs on (`next`) and which one a session is generating on (`running`) are all
 * the server's answers. The key itself never reaches a page: `sk-…` and its last four characters are
 * all anyone is sent.
 */

export type SharedPoolRole = 'ADMIN' | 'MEMBER';

/** What OpenAI last said about a key: ACTIVE, INVALID (a 401 — wrong or revoked) or DISABLED (refused
 *  for its organization or project). The contributor's own switch is `enabled`, apart from this. */
export type PoolKeyState = 'ACTIVE' | 'INVALID' | 'DISABLED';

export interface PoolSpend {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SharedPoolPerson {
  userId: string;
  name: string;
  role: SharedPoolRole;
  /** Who made the pool: an admin whom nobody can remove or make a member. */
  creator: boolean;
  you: boolean;
  /** How many keys they put in. */
  keys: number;
  /** How many sessions they started on the pool this month. */
  sessions: number;
  usage: PoolSpend;
}

export interface SharedPoolKey {
  id: string;
  label: string;
  /** `sk-…AB12`. */
  fingerprint: string;
  state: PoolKeyState;
  enabled: boolean;
  /** Whole dollars a month everyone but its contributor may spend on it; null = no cap. */
  shareCap: number | null;
  contributor: { userId: string; name: string; you: boolean };
  /** This month's; `othersCostUsd` is the part its cap limits. */
  usage: PoolSpend & { othersCostUsd: number };
  /** A session on the pool is generating on it now. */
  running: boolean;
  /** The key a session the viewer starts now runs on — the claim's own choice, asked for them. */
  next: boolean;
}

export interface SharedPool {
  id: string;
  slug: string;
  label: string;
  engine: string;
  membersCanAdd: boolean;
  ownKeyFirst: boolean;
  viewerRole: SharedPoolRole;
  /** The calendar month (UTC) every cap and every figure here counts. */
  window: { start: string; end: string };
  people: SharedPoolPerson[];
  keys: SharedPoolKey[];
}

export const SHARED_POOLS_BASE = '/providers/shared-pools';

/** Under ['providers'], like the account pools: the server's PROVIDER_CHANGED reaches every person of a
 *  pool when anything in it changes, and invalidates the whole catalogue. */
export const SHARED_POOLS_KEY = ['providers', 'shared-pools'] as const;

export const sharedPoolsQuery = () =>
  queryOptions({
    queryKey: SHARED_POOLS_KEY,
    queryFn: () => api<SharedPool[]>(SHARED_POOLS_BASE),
  });

/** Whether the others have spent `key`'s cap this month — which stops everyone's sessions on it but its
 *  contributor's (pool-key-select.ts keyRoom). */
const atCap = (key: SharedPoolKey): boolean =>
  !key.contributor.you && key.shareCap !== null && key.usage.othersCostUsd >= key.shareCap;

/** Where a key stands for a session the viewer starts now. Refused by OpenAI outranks switched off:
 *  it is the one somebody has to act on. */
export function keyState(key: SharedPoolKey): PoolMemberState {
  if (key.state === 'INVALID') return 'INVALID';
  if (!key.enabled || key.state === 'DISABLED') return 'DISABLED';
  if (atCap(key)) return 'SPENT';
  return key.running ? 'RUNNING' : 'AVAILABLE';
}

/** A capped key's gauge, in the shape a quota bar reads (planUsageRows): the share of its cap the others
 *  spent this month, which resets with the month. A key with no cap has no gauge. */
function keyWindow(key: SharedPoolKey, pool: SharedPool): PlanUsageSnapshot | null {
  if (key.shareCap === null) return null;
  const spent = key.shareCap > 0 ? (key.usage.othersCostUsd / key.shareCap) * 100 : 100;
  return {
    provider: AgentProvider.CODEX,
    primary: { utilization: Math.min(100, spent), resetsAt: pool.window.end, windowDurationMins: 30 * 24 * 60 },
  };
}

/**
 * A shared pool in the shape an account pool is drawn in — its keys as members — so the Providers page
 * card, the session picker and the composer take it as they take one: each member carries its `key`,
 * and the pool itself the whole view (`shared`) for what only a shared pool has.
 */
export function sharedPoolAsProviderPool(pool: SharedPool): ProviderPool {
  const members: PoolMember[] = pool.keys.map((key) => {
    const state = keyState(key);
    return {
      id: key.id,
      slug: key.id,
      label: key.label,
      presetSlug: 'openai',
      enabled: key.enabled,
      planUsage: keyWindow(key, pool),
      state,
      resetsAt: state === 'SPENT' ? pool.window.end : null,
      next: key.next,
      key,
    };
  });
  const free = members.some((member) => member.state === 'AVAILABLE' || member.state === 'RUNNING');
  const runnable = pool.keys.some((key) => key.enabled && key.state === 'ACTIVE');
  return {
    id: pool.id,
    slug: pool.slug,
    label: pool.label,
    resetsAt: !free && members.some((member) => member.state === 'SPENT') ? pool.window.end : null,
    unavailable: runnable ? null : pool.keys.length === 0 ? 'No keys' : 'No key can run',
    members,
    shared: pool,
  };
}

/** A person's colour: one per place in the pool's own order (creator first, then by when they joined),
 *  so a person wears the same one on every key they put in and in the Members list. */
const PEOPLE_COLORS = ['#3370ff', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0d9488', '#ca8a04', '#475569'];

export function personColor(pool: SharedPool, userId: string): string {
  const at = pool.people.findIndex((person) => person.userId === userId);
  return PEOPLE_COLORS[(at < 0 ? pool.people.length : at) % PEOPLE_COLORS.length];
}

/** Each person's share of what the pool ran this month, 0..100 — none while nothing has run. */
export function personShare(pool: SharedPool, person: SharedPoolPerson): number {
  const total = pool.people.reduce((sum, row) => sum + row.usage.costUsd, 0);
  return total > 0 ? Math.round((person.usage.costUsd / total) * 100) : 0;
}

/** Whether the viewer may take `key` out of the pool: its contributor, or an admin. */
export const canRemoveKey = (pool: SharedPool, key: SharedPoolKey): boolean =>
  key.contributor.you || pool.viewerRole === 'ADMIN';

/** Whether the viewer may paste a new secret over `key`: the same two. */
export const canReplaceKey = canRemoveKey;

/** Whether the viewer may put a key in: an admin always, a member while the pool lets members add. */
export const canAddKey = (pool: SharedPool): boolean => pool.viewerRole === 'ADMIN' || pool.membersCanAdd;

/** When a cap starts again, as a date: it is always the first of a month, which a weekday would not say. */
export const formatCapReset = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** `sk-…9E4D`, from what is being typed: the same four characters the server will show. */
export const maskTyped = (key: string): string => `sk-…${key.trim().slice(-4)}`;
