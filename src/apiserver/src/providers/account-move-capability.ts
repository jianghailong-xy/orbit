/**
 * What a runner declares when it carries a session's conversation onto another of its accounts — the
 * one kind a session is moved on, between Codex accounts (CODEX_HOMEs), Claude Code accounts
 * (CLAUDE_CONFIG_DIRs), Antigravity Google accounts, Kimi Code accounts (KIMI_CODE_HOMEs) or Cursor
 * CLI accounts. Kept apart from the runner controller that reads the rest of the declared
 * capabilities, so the sessions service can ask the same question without importing it.
 */
import { AgentProvider, ENGINE_CLI_NAMES } from '@orbit/shared';
import type { RunStatus } from '@prisma/client';
import { isSessionGenerating } from '../common/session-generating';

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
/** Kimi Code's, like Codex's and Claude's: a Kimi conversation lives in its account's KIMI_CODE_HOME
 *  (sessions/<bucket>/<id> and its session_index.jsonl entry), and the runner carries it into the one
 *  its claim names. A runner that does not declare it would resume the session from the other
 *  account's directory, where its conversation is not, so a session is not moved there on it. */
export const KIMI_ACCOUNT_MOVE_V1 = 'kimi-account-move/v1';
/** Cursor CLI's: a session's conversation stays in its own directory whichever account or key it runs
 *  on (runner cursor_launch.go), but whether Cursor continues it under another identity is not known yet
 *  (docs/cursor-runtime-contract.md §13.2). D5 (owner, 2026-10-17): no runner declares this until two
 *  real identities show it does, so until then a Cursor CLI session that has talked moves to no other
 *  account or key on any runner, and one that has not moves on every runner (cursorMoveRefusal, §13.3). */
export const CURSOR_ACCOUNT_MOVE_V1 = 'cursor-account-move/v1';

/** What a runner declares before a session of `engine` is moved onto another of its accounts. */
export const ACCOUNT_MOVE_CAPABILITY = {
  codex: CODEX_ACCOUNT_MOVE_V1,
  claude: CLAUDE_ACCOUNT_MOVE_V1,
  antigravity: ANTIGRAVITY_ACCOUNT_LOGIN_V1,
  kimi: KIMI_ACCOUNT_MOVE_V1,
  cursor: CURSOR_ACCOUNT_MOVE_V1,
} as const;

/** What a Cursor CLI session that has talked is told when it is asked onto another account or key (T0
 *  board, Web 6 ② and iOS 6, where the Provider menu greys those out with the same first sentence). */
export const CURSOR_CONVERSATION_MOVE_REFUSAL =
  `${ENGINE_CLI_NAMES[AgentProvider.CURSOR]} can't carry a conversation to another account or key yet. ` +
  'Start a new session to use a different one.';

/**
 * Whether a Cursor CLI session has a conversation another account or key would have to continue. Cursor
 * writes it with the first prompt, which the runner sends right after Cursor opened the conversation and
 * reported its id, the session's runtimeSessionId (§3.5). So it has once a turn of it settled, once that
 * id is known — a session ended in the middle of its first turn settled none — and while a turn runs,
 * since a switch takes effect only after it. Without any of these it has not talked: it waits for its
 * first claim, or ended before Cursor opened a conversation, and starts one on whichever it moves to.
 */
export function cursorConversationStarted(session: {
  numTurns: number;
  runtimeSessionId: string | null;
  status: RunStatus;
  engineTurnActive?: boolean | null;
}): boolean {
  return session.numTurns > 0 || session.runtimeSessionId != null || isSessionGenerating(session);
}

/** Why a Cursor CLI session may not move to another account or key on `runner`, or null when it may:
 *  one that has talked only on a runner that declares CURSOR_ACCOUNT_MOVE_V1, one that has not on any. */
export function cursorMoveRefusal(
  session: Parameters<typeof cursorConversationStarted>[0],
  runner: { capabilities: string[] } | null | undefined,
): string | null {
  if (!cursorConversationStarted(session)) return null;
  return (runner?.capabilities ?? []).includes(CURSOR_ACCOUNT_MOVE_V1) ? null : CURSOR_CONVERSATION_MOVE_REFUSAL;
}
