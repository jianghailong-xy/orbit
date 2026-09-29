import type { PlanUsageSnapshot } from '@orbit/shared';
import { encodeId } from './idCodec';
import { planUsageRows } from './planUsage';
import type { PoolMember, PoolMemberState, ProviderPool } from './providerPools';

/**
 * A Codex pool of the user's own (migration 0323): it runs on ONE ChatGPT account of theirs, which this
 * server signed in with the official codex CLI's device flow and keeps encrypted — never a runner, never
 * a response. What the pages read of it is `login` on the pool (ProvidersService.poolViews): the email,
 * the plan, `…AB12`, whether OpenAI still takes it, and its quota once something has read it.
 *
 * The pages draw such a pool the way they draw every other one: its account is the pool's one member
 * (`withLogin`), carrying `login` the way a shared pool's member carries its `key` — so the Providers
 * card, the session picker and the composer take it as they take any pool.
 */

/** The account a Codex pool of one's own runs on, as the server reads it (codex-login.ts). */
export interface CodexLogin {
  /** ACTIVE, or SIGNED_OUT once OpenAI refused it — which only its owner's sign-in again undoes. */
  state: string;
  email: string | null;
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
  /** Why it failed, in the server's words. */
  error?: string;
}

/** POST starts a sign-in, GET polls it, DELETE gives it up; `/account` signs the account out. */
export const codexLoginPath = (poolId: string) => `/providers/pools/${encodeId(poolId)}/codex-login`;

/** A Codex pool of the user's own: one ChatGPT account, not a set of member keys. */
export const isLoginPool = (pool: Pick<ProviderPool, 'engine' | 'shared'>): boolean =>
  pool.engine === 'codex' && !pool.shared;

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
 * A Codex pool of one's own in the shape every pool is drawn in: its account as the one member, and the
 * pool's own answers — why nothing can run, when a spent account frees up — read off that account in the
 * words a pool head has room for. A pool of any other kind comes back as it was.
 */
export function withLogin(pool: ProviderPool, now: number = Date.now()): ProviderPool {
  if (!isLoginPool(pool)) return pool;
  const login = pool.login ?? null;
  if (!login) return { ...pool, members: [], resetsAt: null, unavailable: 'Not signed in' };
  const state = loginState(login, now);
  const resetsAt = state === 'SPENT' ? (loginSpentUntil(login, now) ?? null) : null;
  const member: PoolMember = {
    id: `login:${login.fingerprint}`,
    slug: pool.slug,
    label: loginName(login),
    presetSlug: 'openai',
    enabled: true,
    planUsage: login.usage,
    state,
    resetsAt,
    next: state === 'AVAILABLE',
    login,
  };
  return {
    ...pool,
    members: [member],
    resetsAt,
    unavailable: state === 'SIGNED_OUT' ? 'Signed out' : null,
  };
}
