import { accountIsPaused } from './accountPause';
import type { PlanUsageSnapshot } from '@orbit/shared';
import { encodeId } from './idCodec';
import { planUsageRows } from './planUsage';
import type { PoolMember, PoolMemberState, ProviderPool } from './providerPools';

/**
 * A Codex pool's ChatGPT accounts (migrations 0323, 0371): each is signed in by a person of the pool with
 * the official codex CLI's device flow, held encrypted by this server — never a runner, never a response.
 * What the pages read of a pool is `logins` (ProvidersService.poolViews, SharedPoolsService.poolView),
 * every account it holds, oldest first: each one's email, plan, `…AB12`, whether OpenAI still takes it, its
 * quota once something has read it, and `userId` — who signed it in, the one person who may sign it in
 * again. `login` is the first of them — the account its sessions run on.
 *
 * The pages draw such a pool the way they draw every other one: each account is one of the pool's members
 * (`withLogin`), carrying `login` the way a shared pool's member carries its `key` — so the Providers
 * card, the session picker and the composer take it as they take any pool.
 */

/** The account a Codex pool runs on, as the server reads it (codex-login.ts). */
export interface CodexLogin {
  /** ACTIVE, or SIGNED_OUT once OpenAI refused it — which only the sign-in again of the person who
   *  signed it in undoes (migration 0371; the pool owner's alone before that). */
  state: string;
  pausedUntil?: string | null;
  email: string | null;
  /** Who signed it in — a person of the pool. They alone may sign it in again; with the pool's admins
   *  they may take it out. The pool's `people` name them. */
  userId: string;
  /** The plan the account's sign-in names (`plus`, `pro`, …), when it names one. */
  plan: string | null;
  /** `…AB12`: all any response says of the account's id. */
  fingerprint: string;
  lastError: string | null;
  expiresAt: string;
  linkedAt: string;
  /** Its quota, once something has read it; null until then — which is not a refusal, and it runs. */
  usage: PlanUsageSnapshot | null;
  usageUnavailable: string | null;
}

/** Every account such a pool holds, oldest first: the server's `logins`, and — from an older server,
 *  which names only one — the pool's `login` as that one. */
export const poolLogins = (pool: Pick<ProviderPool, 'login' | 'logins'>): CodexLogin[] =>
  pool.logins ?? (pool.login ? [pool.login] : []);

/** What starting a sign-in answers: the page to open and the one-time code to enter there. */
export interface CodexLoginAttempt {
  status: 'PENDING';
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}

/** Where a sign-in stands, as its poll reads it — and the account the pool holds, before and after. */
export interface CodexLoginPoll {
  status: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'FAILED' | 'NONE';
  verificationUrl?: string | null;
  userCode?: string | null;
  expiresAt?: string;
  account: CodexLogin | null;
  /** Every account the pool holds, oldest first, once this poll stored the one it was waiting on. */
  logins?: CodexLogin[];
  /** Why it failed, in the server's words. */
  error?: string;
}

/** POST starts a sign-in, GET polls it, DELETE gives it up; `/account` signs the account out. */
export const codexLoginPath = (poolId: string) => `/providers/pools/${encodeId(poolId)}/codex-login`;

/** A Codex pool of the user's own, the one their ChatGPT accounts are in — its people and keys read beside
 *  them or not (ownPoolWithAccess), but never a pool made on the shared pools page. */
export const isLoginPool = (pool: Pick<ProviderPool, 'engine' | 'shared'>): boolean =>
  pool.engine === 'codex' && !pool.shared?.shared;

/** `Plus` for `plus`: the plan as OpenAI's own pages name it. */
const planName = (plan: string | null): string | null =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null;

/** The account's second line: `ChatGPT Plus · …AB12`. */
export function loginLine(login: CodexLogin): string {
  const plan = planName(login.plan);
  return `${plan ? `ChatGPT ${plan}` : 'ChatGPT'} · ${login.fingerprint}`;
}

/** What the account is called wherever it is named: its email, when its sign-in carried one. */
export const loginName = (login: CodexLogin): string => login.email ?? 'ChatGPT account';

/**
 * Until when a spent account waits: the latest reset of the windows it used up, null for a spent window
 * that named no reset, and undefined while none is spent. The account comes back when all of them have.
 */
export function loginSpentUntil(login: CodexLogin, now: number = Date.now()): string | null | undefined {
  if (!login.usage) return undefined;
  const spent = planUsageRows(login.usage).filter((row) => row.window.utilization >= 100);
  if (spent.length === 0) return undefined;
  const resets = spent.flatMap((row) => (row.window.resetsAt ? [row.window.resetsAt] : []));
  const latest = resets.reduce<string | null>(
    (at, reset) => (at === null || Date.parse(reset) > Date.parse(at) ? reset : at),
    null,
  );
  // A reset already behind us is a reading from before the window turned over: it runs again.
  return latest !== null && Date.parse(latest) <= now ? undefined : latest;
}

/** Where the account stands: OpenAI's refusal first, then a used-up window, else it runs. */
export function loginState(login: CodexLogin, now: number = Date.now()): PoolMemberState {
  if (login.state !== 'ACTIVE') return 'SIGNED_OUT';
  return loginSpentUntil(login, now) === undefined ? 'AVAILABLE' : 'SPENT';
}

/**
 * A Codex pool of one's own in the shape every pool is drawn in: each ChatGPT account it holds as one
 * member, and the pool's own answers — why nothing can run, when a spent account frees up — read off
 * those accounts in the words a pool head has room for. A pool of any other kind comes back as it was.
 */
export function withLogin(pool: ProviderPool, now: number = Date.now()): ProviderPool {
  if (!isLoginPool(pool)) return pool;
  const logins = poolLogins(pool);
  if (logins.length === 0) return { ...pool, members: [], resetsAt: null, unavailable: 'Not signed in' };
  const members = logins.map((login, index) => loginMember(pool, login, index, now));
  const spent = members.flatMap((member) => (member.resetsAt ? [member.resetsAt] : []));
  return {
    ...pool,
    members,
    // Only ever a mark of the pool as a whole: when every account is spent, the EARLIEST of their
    // resets — one account freeing up is enough for work to continue.
    resetsAt: spent.reduce<string | null>(
      (earliest, at) => (earliest === null || Date.parse(at) < Date.parse(earliest) ? at : earliest),
      null,
    ),
    unavailable: members[0].state === 'SIGNED_OUT' ? 'Signed out' : null,
  };
}

/** One of a pool's accounts as a member of it. The first is the account its sessions run on — the
 *  server's `login` — so it is the one a session starting now uses, and the row that says NEXT. */
function loginMember(pool: ProviderPool, login: CodexLogin, index: number, now: number): PoolMember {
  const state = loginState(login, now);
  return {
    id: `login:${login.fingerprint}`,
    slug: pool.slug,
    label: loginName(login),
    presetSlug: 'openai',
    enabled: true,
    planUsage: login.usage,
    state,
    resetsAt: state === 'SPENT' ? (loginSpentUntil(login, now) ?? null) : null,
    next: index === 0 && state === 'AVAILABLE' && !accountIsPaused(login.pausedUntil, now),
    pausedUntil: login.pausedUntil,
    login,
  };
}

/**
 * The account a session on a login pool is on, as the session's detail names it (`poolCodexLogin`,
 * the masked view the session DTO carries): that account as the pool's member of it — whatever its
 * state, a spent one still renders — read as the claim's pick (`current`). The pool's own `next`
 * member is no answer here: it marks the account a session STARTING now would get, which with the
 * pool's oldest account spent can be nobody while the session runs on that very account. Null when
 * the session names none, or names an account the pool no longer holds (the next claim chooses
 * again, and naming anyone until then would be a guess).
 */
export function poolSessionLoginMember(
  pool: ProviderPool,
  login: CodexLogin | null | undefined,
  now: number = Date.now(),
): { member: PoolMember; current: boolean } | null {
  if (!login) return null;
  const member = withLogin(pool, now).members.find((m) => m.login?.fingerprint === login.fingerprint);
  return member ? { member, current: true } : null;
}
