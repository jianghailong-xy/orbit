import { queryOptions } from '@tanstack/react-query';
import { AgentProvider, type PlanUsageSnapshot } from '@orbit/shared';
import { api } from '../api';
import { loginName, loginSpentUntil, loginState, type CodexLogin } from './codexLogin';
import { encodeId } from './idCodec';
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
  /** Out of budget until then — OpenAI answered `insufficient_quota` for it, and the page says
   *  `Out of budget · resets …` (`pool-key-select.ts` spent). Null when it is not, which the server
   *  sends as null too once the mark is behind us. */
  spentUntil: string | null;
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
  /** Made on the shared pools page (migration 0321): API keys alone, never a ChatGPT account. False on a
   *  Codex pool of somebody's own (0323), which takes people and keys beside its owner's accounts (0358). */
  shared: boolean;
  /**
   * The ChatGPT accounts a pool of somebody's own holds (migrations 0323/0324), as its owner's page reads
   * them (CodexLoginService) — and, since 2026-10-03, as everyone in the pool reads them: the accounts run
   * their sessions too (pool-credential-select.ts). Which of them the viewer's next session runs on is
   * `next`. A shared pool holds none.
   */
  logins: SharedPoolLogin[];
  membersCanAdd: boolean;
  ownKeyFirst: boolean;
  viewerRole: SharedPoolRole;
  /** The calendar month (UTC) every cap and every figure here counts. */
  window: { start: string; end: string };
  people: SharedPoolPerson[];
  keys: SharedPoolKey[];
}

/** One of a pool's ChatGPT accounts as everybody in it reads it: an account of the owner's, whose
 *  sign-in only they may change, and one their sessions and everyone else's run on. */
export interface SharedPoolLogin extends CodexLogin {
  /** The account a session the viewer starts now runs on — the claim's own choice, asked for them. */
  next: boolean;
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

/** A Codex pool of the user's own as its people and keys are read (migration 0358): its owner is one of
 *  its people, but the list above names only the pools of somebody else's. */
export const poolAccessQuery = (poolId: string) =>
  queryOptions({
    queryKey: [...SHARED_POOLS_KEY, poolId] as const,
    queryFn: () => api<SharedPool>(`${SHARED_POOLS_BASE}/${encodeId(poolId)}`),
  });

/** Whose the pool is: the person who made it, whose ChatGPT accounts are in it and who says who else can
 *  use it. */
export const poolOwner = (pool: SharedPool): SharedPoolPerson | undefined =>
  pool.people.find((person) => person.creator);

/** Whether the viewer is the pool's owner — the page drawn for them — rather than one of the people they added. */
export const ownsPool = (pool: SharedPool): boolean => pool.people.some((person) => person.you && person.creator);

/** "Me and people I add" rather than "Just me": anybody is in it besides its owner. */
export const hasPeople = (pool: SharedPool): boolean => pool.people.length > 1;

/** Whether the others have spent `key`'s cap this month — which stops everyone's sessions on it but its
 *  contributor's (pool-key-select.ts keyRoom). */
const atCap = (key: SharedPoolKey): boolean =>
  !key.contributor.you && key.shareCap !== null && key.usage.othersCostUsd >= key.shareCap;

/** Whether OpenAI itself has `key` out of budget: the one gate a share cap does not put up, since it
 *  stops its contributor's sessions too. A payload that leaves the field out is a key with no mark —
 *  which is how the server sends one whose mark is behind us. */
export const outOfBudget = (key: SharedPoolKey): boolean => key.spentUntil != null;

/** Where a key stands for a session the viewer starts now. Refused by OpenAI outranks switched off:
 *  it is the one somebody has to act on. Out of budget outranks the cap: it is OpenAI's own answer,
 *  and it holds for the key's contributor where the cap only holds for the others. */
export function keyState(key: SharedPoolKey): PoolMemberState {
  if (key.state === 'INVALID') return 'INVALID';
  if (!key.enabled || key.state === 'DISABLED') return 'DISABLED';
  if (outOfBudget(key) || atCap(key)) return 'SPENT';
  return key.running ? 'RUNNING' : 'AVAILABLE';
}

/** Whether every key of `pool` that cannot run is out of budget rather than at its cap — which of the
 *  two the Keys header names when none of them can run (AccountPools' PoolGauge). */
export function allOutOfBudget(pool: SharedPool): boolean {
  const stopped = pool.keys.filter((key) => keyState(key) === 'SPENT');
  return stopped.length > 0 && stopped.every(outOfBudget);
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
 * A pool read as its people and keys as an account pool is drawn — its ChatGPT accounts first, then its
 * keys — so the Providers page card, the session picker and the composer take it as they take one: each
 * member carries its `login` or its `key`, and the pool itself the whole view (`shared`) for what only a
 * shared pool has. The order is every session's: the accounts while any can run, its keys after
 * (pool-credential-select.ts).
 */
export function sharedPoolAsProviderPool(pool: SharedPool): ProviderPool {
  // A payload that leaves `logins` out is a pool whose accounts nothing is known of (an older server):
  // it is drawn as it was — its keys — rather than as a crash.
  return keysPool(pool, [...(pool.logins ?? []).map((login) => loginMember(pool, login)), ...keyMembers(pool)]);
}

/** One of the pool's ChatGPT accounts as a member of it: named by its email, where it stands
 *  (loginState), and — the account the viewer's next session runs on, which the server chose for them —
 *  the one wearing NEXT. Its email, plan, `…AB12` and quota are the pool's own view of it. */
function loginMember(pool: SharedPool, login: SharedPoolLogin): PoolMember {
  const state = loginState(login);
  return {
    id: `login:${login.fingerprint}`,
    slug: pool.slug,
    label: loginName(login),
    enabled: true,
    presetSlug: 'openai',
    planUsage: login.usage,
    state,
    resetsAt: state === 'SPENT' ? (loginSpentUntil(login) ?? null) : null,
    next: login.next,
    login,
  };
}

/**
 * A Codex pool of the user's own, read twice — its ChatGPT accounts with the providers (`own`, as withLogin
 * draws them), its people and keys from `access` — drawn as one: its accounts first, then its keys, in the
 * order its owner's sessions take them (pool-credential-select.ts). A key is the next session's only while
 * none of the accounts can take one.
 */
export function ownPoolWithAccess(own: ProviderPool, access: SharedPool): ProviderPool {
  const accounts = own.members;
  const nextAccount =
    accounts.find((member) => member.next) ?? accounts.find((member) => member.state === 'AVAILABLE');
  const members = [
    ...accounts.map((member) => ({ ...member, next: member === nextAccount })),
    ...keyMembers(access).map((member) => (nextAccount ? { ...member, next: false } : member)),
  ];
  const working = members.some((member) => member.state === 'AVAILABLE' || member.state === 'RUNNING');
  const stops = members.flatMap((member) => (member.state === 'SPENT' && member.resetsAt ? [member.resetsAt] : []));
  // Whether waiting brings anything back: not when every account is signed out and every key refused or
  // switched off.
  const revives =
    accounts.some((member) => member.state !== 'SIGNED_OUT') ||
    access.keys.some((key) => key.enabled && key.state === 'ACTIVE');
  return {
    ...own,
    members,
    resetsAt: !working && stops.length > 0 ? earliest(stops) : null,
    unavailable: revives
      ? null
      : accounts.length > 0
        ? 'Signed out'
        : access.keys.length > 0
          ? 'No key can run'
          : 'Not signed in',
    shared: access,
  };
}

const earliest = (stops: string[]): string => stops.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));

function keyMembers(pool: SharedPool): PoolMember[] {
  // The viewer's own keys first while the pool starts a person's sessions on theirs (`ownKeyFirst`): the
  // order a session of theirs takes them in.
  const keys = pool.ownKeyFirst
    ? [...pool.keys].sort((a, b) => Number(b.contributor.you) - Number(a.contributor.you))
    : pool.keys;
  return keys.map((key) => {
    const state = keyState(key);
    return {
      id: key.id,
      slug: key.id,
      label: key.label,
      presetSlug: 'openai',
      enabled: key.enabled,
      planUsage: keyWindow(key, pool),
      state,
      // A capped key comes back with the month; one out of budget, at OpenAI's own mark.
      resetsAt: state === 'SPENT' ? (key.spentUntil ?? pool.window.end) : null,
      next: key.next,
      key,
    };
  });
}

function keysPool(pool: SharedPool, members: PoolMember[]): ProviderPool {
  const free = members.some((member) => member.state === 'AVAILABLE' || member.state === 'RUNNING');
  const accounts = members.flatMap((member) => (member.login ? [member.login] : []));
  // Whether waiting brings anything back: an account that is not signed out — a spent one comes back by
  // the hour — or a key OpenAI still takes that is switched on. A signed-out account, an off key and a
  // refused one come back only by their owner's or contributor's hand.
  const revives =
    accounts.some((login) => loginState(login) !== 'SIGNED_OUT') ||
    pool.keys.some((key) => key.enabled && key.state === 'ACTIVE');
  const stops = members.flatMap((member) => (member.state === 'SPENT' && member.resetsAt ? [member.resetsAt] : []));
  return {
    id: pool.id,
    slug: pool.slug,
    label: pool.label,
    // The EARLIEST of the stops, as an account pool's own `resetsAt` is: one credential free of its
    // reason is enough for work to continue, whether that is the month turning, OpenAI's mark running
    // out, or an account's window resetting.
    resetsAt: !free && stops.length > 0 ? earliest(stops) : null,
    // Why nothing can run, in the words the owner's own pool page uses (codexLogin.withLogin,
    // ownPoolWithAccess): 'Signed out' while the pool holds accounts and OpenAI refused every one of
    // them — which waiting does not mend — else the keys' own answer. A shared pool holds no account:
    // its keys are the whole answer, as before.
    unavailable: revives
      ? null
      : accounts.length > 0
        ? 'Signed out'
        : pool.keys.length === 0
          ? pool.shared
            ? 'No keys'
            : 'Not signed in'
          : 'No key can run',
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
