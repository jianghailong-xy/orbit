import { choosePoolKey, poolKeySwitchNotice, type PoolKeyCandidate } from './pool-key-select';
import {
  chooseLoginAccount,
  keyToLoginSwitchNotice,
  loginCanRun,
  loginSwitchNotice,
  loginToKeySwitchNotice,
  type LoginAccount,
} from './pool-login-select';

/**
 * Which credential of a Codex pool a session runs on — one of the ChatGPT accounts its owner signed in
 * (migration 0323), or one of its API keys (migrations 0321, 0358) — chosen at every door that builds the
 * session's engine (QueueService.resolveLoginPool for a pool of the session owner's own, resolveSharedPool
 * for one somebody else made that they are a person of) and recorded on the session, which is all the
 * gateway sends on. Within each kind the rules are pool-login-select.ts's and pool-key-select.ts's; this
 * is the order between the two, and who may have which:
 *
 * - Any session of a pool of somebody's own runs on its ChatGPT accounts first, and on its keys only while
 *   none of them can run: a subscription's quota costs nothing more to use, where a key is billed by what
 *   it runs. A session on a key goes back onto an account at the first choosing that finds one that can.
 *   The accounts are the pool owner's, and (2026-10-03) run every person in the pool's sessions, not its
 *   owner's alone — signing one in or out is still the owner's alone (CodexLoginService).
 * - A shared pool (0321) holds no account: everyone in it runs on its keys, its maker included.
 */

/** A key as pool-key-select.ts chooses one, with the label the transcript names it by. */
type CredentialKey = PoolKeyCandidate & { label: string };

/** The pool, as choosing reads it. */
export interface CredentialPool<Account extends LoginAccount, Key extends CredentialKey> {
  /** Whose the pool is: whose its ChatGPT accounts are, and the only person who may sign one in or out. */
  ownerId: string;
  /** Made on the shared pools page (migration 0321): API keys alone, for everybody in it. */
  shared: boolean;
  /** Its ChatGPT accounts, oldest first. */
  accounts: readonly Account[];
  keys: readonly Key[];
  /** Its rule that a person's own key comes before everybody else's (pool-key-select.ts). */
  ownKeyFirst: boolean;
}

/** What a session runs on, as its row says: `pool_codex_account_id`, `pool_key_id` — neither before its first claim. */
export interface SessionCredential {
  accountId: string | null;
  keyId: string | null;
}

export interface CredentialChoice {
  /** The credential the session goes onto, one that can run now; null when none of the pool's can run for it. */
  chosen: SessionCredential | null;
  /**
   * What the session's row says from here: `chosen`, or — when nothing can run — what it is on already,
   * whose limit or refusal the gateway then answers with, until a claim finds something that can run. The
   * owner's session on nothing yet, or on an account the pool no longer holds, goes to the account
   * chooseLoginAccount falls back to — the first to come back — rather than to nothing, which the gateway
   * would answer as a pool with no account.
   */
  next: SessionCredential;
  /** The line the transcript owes for a move; null when the session stays, or starts here, which is no move. */
  notice: string | null;
}

/**
 * The credential a claim puts `session` — whose `ownerId` it is — on, in the order above. Within the
 * pool's accounts and within the keys, the session stays on what it is on while that can run.
 */
export function choosePoolCredential<Account extends LoginAccount, Key extends CredentialKey>(
  pool: CredentialPool<Account, Key>,
  session: SessionCredential & { ownerId: string },
  now: Date,
): CredentialChoice {
  if (pool.shared) return keysAlone(pool, session, now);
  // What the session was on: an account, else a key, else nothing yet.
  const onAccount = session.accountId !== null;
  const onKey = !onAccount && session.keyId !== null;
  const previous = pool.accounts.find((account) => account.accountId === session.accountId) ?? null;
  const account = chooseLoginAccount(pool.accounts, session.accountId, now);
  if (account && loginCanRun(account, now)) {
    const next = { accountId: account.accountId, keyId: null };
    if (account.accountId === session.accountId) return { chosen: next, next, notice: null };
    const notice = onAccount
      ? loginSwitchNotice(account, previous, now)
      : onKey
        ? keyToLoginSwitchNotice(account, session.ownerId === pool.ownerId)
        : null;
    return { chosen: next, next, notice };
  }
  const key = choosePoolKey(pool.keys, session.ownerId, pool.ownKeyFirst, session.keyId, now);
  if (key) {
    const next = { accountId: null, keyId: key.id };
    const notice = onAccount
      ? loginToKeySwitchNotice(key, previous, now)
      : onKey && key.id !== session.keyId
        ? poolKeySwitchNotice(key, pool.keys.find((left) => left.id === session.keyId) ?? null, session.ownerId, now)
        : null;
    return { chosen: next, next, notice };
  }
  // Nothing can run: on the key it is on, else the account chooseLoginAccount falls back to.
  if (onKey) return { chosen: null, next: { accountId: null, keyId: session.keyId }, notice: null };
  const moved = onAccount && account !== null && account.accountId !== session.accountId;
  return {
    chosen: null,
    next: { accountId: account?.accountId ?? null, keyId: null },
    notice: moved ? loginSwitchNotice(account, previous, now) : null,
  };
}

/**
 * A shared pool's (migration 0321): pool-key-select.ts's choice, and with none the key the session is on.
 * The pool holds no ChatGPT account, and an account a session's row names — carried over from a pool of
 * somebody's own it ran on before — is dropped without a line: the session never ran on it here.
 */
function keysAlone<Key extends CredentialKey>(
  pool: { keys: readonly Key[]; ownKeyFirst: boolean },
  session: SessionCredential & { ownerId: string },
  now: Date,
): CredentialChoice {
  const key = choosePoolKey(pool.keys, session.ownerId, pool.ownKeyFirst, session.keyId, now);
  if (!key) return { chosen: null, next: { accountId: null, keyId: session.keyId }, notice: null };
  const next = { accountId: null, keyId: key.id };
  // The first key a session runs on is where it starts, not a move.
  const notice =
    session.keyId !== null && key.id !== session.keyId
      ? poolKeySwitchNotice(key, pool.keys.find((left) => left.id === session.keyId) ?? null, session.ownerId, now)
      : null;
  return { chosen: next, next, notice };
}
