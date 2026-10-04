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
 * Which credential of a Codex pool a session runs on — one of the ChatGPT accounts logged into it
 * (migrations 0323, 0371), or one of its API keys (migrations 0321, 0358) — chosen at every door that
 * builds the session's engine (QueueService.resolveLoginPool for a pool of the session owner's own,
 * resolveSharedPool for one somebody else made that they are a person of) and recorded on the session,
 * which is all the gateway sends on. Within each kind the rules are pool-login-select.ts's and
 * pool-key-select.ts's; this is the order between the two, and it is one rule for every pool:
 *
 * - every session runs on the pool's ChatGPT accounts first, and on its keys only while none of them can
 *   run: a subscription's quota costs nothing more to use, where a key is billed by what it runs. A
 *   session on a key goes back onto an account at the first choosing that finds one that can.
 * - the accounts are persons of the pool's, each signed in by whoever contributed it (migration 0371),
 *   and run every person in the pool's sessions; who may sign one in or out is CodexLoginService's, and
 *   a shared pool (0321) that holds no account simply has none to choose.
 */

/** A key as pool-key-select.ts chooses one, with the label the transcript names it by. */
type CredentialKey = PoolKeyCandidate & { label: string };

/** The pool, as choosing reads it. */
export interface CredentialPool<Account extends LoginAccount, Key extends CredentialKey> {
  /** Whose the pool is. */
  ownerId: string;
  /** Its ChatGPT accounts, oldest first — whoever in the pool signed each one in. */
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

