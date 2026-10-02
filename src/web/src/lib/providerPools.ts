import { queryOptions } from '@tanstack/react-query';
import { AgentProvider, type PlanUsageSnapshot } from '@orbit/shared';
import { api } from '../api';
import { withLogin, type CodexLogin } from './codexLogin';
import { routeId } from './idCodec';
import { planUsageRows, type PlanUsageDisplayRow } from './planUsage';
import type { ProviderRow } from './providerAdmin';
import { formatCapReset, type SharedPool, type SharedPoolKey } from './sharedPools';
import type { ConfiguredProvider } from './workspaceDefaults';

/**
 * Account pools as GET /providers/pools serves them (ProvidersService.poolViews): several of the
 * user's own Claude subscriptions under one slug, each member with its own quota and where it
 * stands. Which member a session starting now runs on (`next`) and when a spent pool frees up
 * (`resetsAt`) are the server's answers — the claim's own selector, asked the way the claim asks
 * it — so nothing here re-derives them.
 */

/**
 * Where one member stands, in the order the claim reads a member. INVALID is a shared pool's key that
 * OpenAI refused (a 401): its contributor or an admin replaces it. SIGNED_OUT is the ChatGPT account of
 * a Codex pool of one's own that OpenAI refused: only its owner's sign-in again puts it back.
 *
 * REFUSED and USAGE_UNKNOWN are the two ways the usage endpoint turns a credential away, and they are
 * not the same thing: REFUSED is it refusing to authenticate the key (401), while USAGE_UNKNOWN is it
 * refusing to *report* on a key that works — a Claude Code setup token carrying no `user:profile`
 * scope. A USAGE_UNKNOWN member still runs; it just ranks behind every member whose quota was read.
 */
export type PoolMemberState =
  | 'REFUSED'
  | 'DISABLED'
  | 'INVALID'
  | 'SIGNED_OUT'
  | 'SPENT'
  | 'RUNNING'
  | 'AVAILABLE'
  | 'NO_QUOTA'
  | 'USAGE_UNKNOWN';

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
  /** In a shared pool a member is one of its keys: the key as the server reads it (sharedPools.ts). */
  key?: SharedPoolKey;
  /** In a Codex pool of one's own the one member is its ChatGPT account (codexLogin.ts `withLogin`). */
  login?: CodexLogin;
}

export interface ProviderPool {
  id: string;
  slug: string;
  label: string;
  /** Set only while every member that can run is spent: the EARLIEST of their resets, since one
   *  account freeing up is enough for work to continue. */
  resetsAt: string | null;
  /** Set only when no member can run at all, and no reset will change that — none in it, or each one
   *  disabled, its key refused by the endpoint, or one the pool would not admit today: why, in a few
   *  words. The server refuses to start or switch a session onto such a pool, or to pin a task to it.
   *  A member whose quota could not be READ is not one of those: the pool is offered, and runs on it. */
  unavailable?: string | null;
  members: PoolMember[];
  /** What it runs on: `claude` (the 0265 pools of one's own Claude keys) or `codex` — a pool of one's
   *  own ChatGPT account (migration 0323), or a shared pool. Absent from an older server: `claude`. */
  engine?: string;
  /** A Codex pool of one's own: the ChatGPT account it runs on, or null before anyone signed in. */
  login?: CodexLogin | null;
  /** A shared pool (sharedPoolAsProviderPool): the whole of it as its page reads it — its people, its
   *  rules and the viewer's place in it. Absent on an account pool of the user's own. */
  shared?: SharedPool;
}

/** Under ['providers'], so every provider change — a key, a pool, a quota the server re-read, an
 *  account signed in — refreshes it along with the rest of the catalogue. */
export const PROVIDER_POOLS_KEY = ['providers', 'pools'] as const;

/** A Codex pool of one's own comes out of here with its ChatGPT account as its member (withLogin), so
 *  every reader of the list draws it as it draws any pool. */
export const providerPoolsQuery = () =>
  queryOptions({
    queryKey: PROVIDER_POOLS_KEY,
    queryFn: async () => (await api<ProviderPool[]>('/providers/pools')).map((pool) => withLogin(pool)),
  });

/** A member that can take work now — what "N of M accounts available" counts. One that reports no
 *  quota counts: the claim still picks it, just last. So does one whose quota could not be read at all
 *  (USAGE_UNKNOWN): the key is not refused, and with nothing better in the pool the run goes to it. */
export const canTakeWork = (member: PoolMember): boolean =>
  member.state === 'AVAILABLE' ||
  member.state === 'RUNNING' ||
  member.state === 'NO_QUOTA' ||
  member.state === 'USAGE_UNKNOWN';

/**
 * Why the pool would no longer admit each of the user's keys, by key id: the verdict the server puts on
 * the key's own row (`poolRefusal`, GET /providers/mine), in the words joining a pool is refused with.
 * The pool view has no state for it. A member made a metered key, or pointed off api.anthropic.com,
 * before an edit had to pass the pool's admission is no candidate — no claim picks it — but it reports
 * no quota, so the view reads it as last in line (NO_QUOTA).
 */
export type PoolRefusals = ReadonlyMap<string, string>;

export const poolRefusals = (keys: readonly ProviderRow[]): PoolRefusals =>
  new Map(
    keys.flatMap((row): [string, string][] =>
      row.poolRefusal ? [[routeId(row.id) ?? row.id, row.poolRefusal.message]] : [],
    ),
  );

/** Why the pool would no longer admit `member`, or null when it would. One its owner switched off
 *  reads as Disabled instead: that is the reason the server names first for an account that is out. */
export function memberRefusal(member: PoolMember, refusals: PoolRefusals): string | null {
  if (member.state === 'DISABLED') return null;
  return refusals.get(routeId(member.id) ?? member.id) ?? null;
}

/** The "N" of "N of M accounts available": the members a session could start on right now. */
export const availableCount = (pool: ProviderPool, refusals: PoolRefusals): number =>
  pool.members.filter((member) => canTakeWork(member) && !memberRefusal(member, refusals)).length;

/** How many of the user's keys the server would let into a pool. `poolRefusal` is its verdict,
 *  row by row; a row that carries none (an older server) is not counted. */
export const poolEligibleCount = (rows: readonly ProviderRow[]): number =>
  rows.filter((row) => row.poolRefusal === null).length;

/** Whether a pool runs Codex — a shared pool of OpenAI keys, or a pool of one's own ChatGPT account —
 *  rather than its members' Claude subscriptions. */
export const poolRunsCodex = (pool: Pick<ProviderPool, 'engine' | 'shared'>): boolean =>
  !!pool.shared || pool.engine === AgentProvider.CODEX;

/**
 * The pools as providers a session picker can offer and a composer can run: a pool runs on its
 * members' Claude subscriptions, whose models are the Claude CLI's own — the same model space an
 * Anthropic key has — and it carries no quota of its own (each member has one). A shared pool runs
 * Codex on OpenAI's own endpoint, and so does a pool of one's own ChatGPT account: their models are the
 * Codex CLI's.
 */
export const poolsAsProviders = (pools: readonly ProviderPool[]): ConfiguredProvider[] =>
  pools.map((pool) => ({
    slug: pool.slug,
    label: pool.label,
    runtime: poolRunsCodex(pool) ? AgentProvider.CODEX : AgentProvider.CLAUDE,
    models: [],
    defaultModel: null,
    presetSlug: poolRunsCodex(pool) ? 'openai' : 'anthropic',
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

/** The gauge a member row shows: the window that stopped a spent member, else the one closest to its
 *  limit — a 5-hour window at 6% says nothing of a weekly one at 97%, which stops the account first.
 *  A tie goes to the first of them, the 5-hour window. */
export function memberQuota(member: PoolMember): PlanUsageDisplayRow | null {
  if (!member.planUsage) return null;
  const rows = planUsageRows(member.planUsage);
  const binding = member.state === 'SPENT' ? rows.find((row) => row.window.utilization >= 100) : undefined;
  return (
    binding ??
    rows.reduce<PlanUsageDisplayRow | null>(
      (tightest, row) => (!tightest || row.window.utilization > tightest.window.utilization ? row : tightest),
      null,
    )
  );
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

/** A member's status tag: its words and its colour. `refusal` is why the pool would no longer admit it
 *  (memberRefusal), which outranks whatever the view says. */
export function memberStatus(
  member: PoolMember,
  now?: number,
  refusal?: string | null,
): { label: string; color: string } {
  // Out, however the view reads it. The refusal's own words go on a line of the row's: they run
  // longer than a status has room for.
  if (refusal) return { label: 'Unavailable', color: 'red' };
  switch (member.state) {
    case 'RUNNING':
      return { label: 'Running now', color: 'processing' };
    case 'AVAILABLE':
      return { label: 'Available', color: 'green' };
    case 'SPENT':
      // A key is not spent but capped: what ran out is what its contributor lets the others spend on
      // it this month, and that comes back on the first of the next one. One OpenAI itself put out of
      // budget comes back at its own mark instead — a date of its own, said the same way.
      if (member.key) {
        if (member.key.spentUntil) {
          return {
            label: `Out of budget · resets ${formatCapReset(member.key.spentUntil)}`,
            color: 'orange',
          };
        }
        return {
          label: member.resetsAt ? `At cap · resets ${formatCapReset(member.resetsAt)}` : 'At cap',
          color: 'orange',
        };
      }
      return {
        label: member.resetsAt ? `Spent · resets ${formatResetTime(member.resetsAt, now)}` : 'Spent',
        color: 'orange',
      };
    case 'INVALID':
      // Why is a line of the row's own: "Rejected by OpenAI — …" runs past the status column.
      return { label: 'Invalid', color: 'red' };
    case 'SIGNED_OUT':
      // Its line says what brings it back: its owner's sign-in again.
      return { label: 'Signed out', color: 'red' };
    case 'REFUSED':
      return { label: 'Unavailable · key refused', color: 'red' };
    case 'USAGE_UNKNOWN':
      // Not the refused key's words, and not its red: the endpoint would not report this credential's
      // quota, which says nothing about the credential. The account still runs — last in line.
      return { label: 'Unavailable · usage unreadable', color: 'default' };
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
 * untouched — or, with none to run on, when the first one frees up, or, with none that can run at
 * all, why.
 */
export type PoolHeadline =
  | { kind: 'next'; member: PoolMember; quota: PlanUsageDisplayRow | null }
  | { kind: 'spent'; resetsAt: string | null }
  | { kind: 'none'; reason: string };

export function poolHeadline(pool: ProviderPool): PoolHeadline {
  const next = pool.members.find((m) => m.next);
  if (next) return { kind: 'next', member: next, quota: memberQuota(next) };
  // The server's word before any reading of the members: no reset will help this pool, even one a
  // member it no longer admits still reports a spent window for.
  if (pool.unavailable) return { kind: 'none', reason: pool.unavailable };
  if (pool.members.some((m) => m.state === 'SPENT')) return { kind: 'spent', resetsAt: pool.resetsAt };
  return { kind: 'none', reason: pool.shared ? 'No key can run' : 'No account can run' };
}
