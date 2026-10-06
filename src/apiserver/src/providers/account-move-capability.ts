/**
 * What a runner declares when it carries a session's conversation onto another of its accounts — the
 * one kind a session is moved on, between Codex accounts (CODEX_HOMEs), Claude Code accounts
 * (CLAUDE_CONFIG_DIRs) or Antigravity Google accounts. Kept apart from the runner controller that reads
 * the rest of the declared capabilities, so the sessions service can ask the same question without
 * importing it.
 */

/** Runner carries a Codex session's thread onto the account its claim names when that is not the one
 *  the thread lives in (runner codex_account_move.go). One that does not keeps the session where its
 *  thread is, whatever the claim says — so a session is only moved off a spent account on one that
 *  declares it. */
export const CODEX_ACCOUNT_MOVE_V1 = 'codex-account-move/v1';
/** Claude Code's, the sibling of the one above: the runner carries a Claude session's conversation into
 *  the CLAUDE_CONFIG_DIR its claim names (runner claude_account_move.go), where an older one would
 *  rebuild it from the event log — shortened, behind a compact boundary, for a long session. */
export const CLAUDE_ACCOUNT_MOVE_V1 = 'claude-account-move/v1';
/** Antigravity's: a session's conversation lives in its own Gemini directory, never in an account's, so
 *  there is nothing to carry — the next agy simply starts on the other account's sign-in. What a runner
 *  has to declare is that it keeps Antigravity accounts at all (runner antigravity_account_slot.go). */
export const ANTIGRAVITY_ACCOUNT_LOGIN_V1 = 'antigravity-account-login/v1';

/** What a runner declares before a session of `engine` is moved onto another of its accounts. */
export const ACCOUNT_MOVE_CAPABILITY = {
  codex: CODEX_ACCOUNT_MOVE_V1,
  claude: CLAUDE_ACCOUNT_MOVE_V1,
  antigravity: ANTIGRAVITY_ACCOUNT_LOGIN_V1,
} as const;
