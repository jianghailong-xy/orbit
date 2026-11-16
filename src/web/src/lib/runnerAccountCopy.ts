/**
 * What a runner's accounts say about removing Default from Orbit and bringing it back: the Providers
 * page and a runner's own page (RunnerEngines), and the workspace form's account field (AccountSelect).
 *
 * These are the web's words, which iOS/macOS and Android copy verbatim and whose parity tests read this
 * file as text. It keeps runnerCopy.ts's shape for that: one `export const X = '…'` per fixed sentence,
 * and one `export function` per sentence with values in it, whose body is a single template literal
 * with nothing but `${parameter}` interpolations. It is a file of its own because OrbitKit's
 * RunnerPageCopyParityTests holds runnerCopy.ts one to one with RunnerPageCopy, which has none of these.
 */

/** The question in front of an account's Remove account: Default's, and an added account's. */
export function runnerAccountRemoveTitle(name: string): string {
  return `Remove ${name}?`;
}

/** Removing an added account while Default is in use. */
export const RUNNER_ACCOUNT_REMOVE_DETAIL = 'Workspaces using it switch to Default.';

/** Removing Default, which only Orbit stops using; `cli` is the CLI's own name (Codex, Claude Code). */
export function runnerDefaultRemoveDetail(runner: string, cli: string): string {
  return `Orbit stops using it on ${runner}. Its sign-in stays on the machine, and ${cli} in a terminal there keeps working. Workspaces set to it run on Automatic.`;
}

/** Removing an added account while Default is removed from Orbit, with another account left. */
export function runnerAccountRemoveDetailAutomatic(runner: string): string {
  return `Its sign-in is deleted from ${runner}. Workspaces set to this account run on Automatic.`;
}

/** Removing the last account Orbit uses while Default is removed: the removal holds only while
 *  another account is there, so Default (`name`) comes back into use. */
export function runnerAccountRemoveDetailLast(runner: string, name: string): string {
  return `Its sign-in is deleted from ${runner}. Without it, Orbit uses ${name} there again, and workspaces set to this account run on it.`;
}

/** The line that ends an engine's accounts while its Default is removed: its name, and its directory
 *  the way a terminal spells it (`~/.codex`). */
export function runnerDefaultRemovedLine(name: string, dir: string): string {
  return `${name} · ${dir} isn’t used by Orbit`;
}

/** That line's button, which brings Default back. */
export const RUNNER_DEFAULT_USE_AGAIN = 'Use again';

export function runnerDefaultUseAgainFailed(name: string): string {
  return `Couldn’t use ${name} again`;
}

/** The workspace form's account field, for a workspace set to a Default removed from Orbit. */
export const ACCOUNT_SELECT_DEFAULT_REMOVED = 'removed from Orbit — sessions run on Automatic';
/** And for one set to an account the runner no longer reports, while its Default is removed. */
export const ACCOUNT_SELECT_GONE_AUTOMATIC = 'not on this runner — sessions run on Automatic';

/** Over the sessions a refused removal lists, when one session is running in the account; `engine` is
 *  the CLI's own name (Codex, Claude Code). */
export function runnerAccountInUseOne(engine: string): string {
  return `This ${engine} account can’t be removed while a session is running on it — end the session below, then remove it`;
}

/** The same, when several sessions are running in it. */
export function runnerAccountInUseMany(engine: string, count: number): string {
  return `This ${engine} account can’t be removed while ${count} sessions are running on it — end them, then remove it`;
}

/** Each listed session's way to it. */
export const RUNNER_ACCOUNT_IN_USE_OPEN = 'Open session';
/** A listed session in a turn (RUNNING, or PENDING on its way to one). */
export const RUNNER_ACCOUNT_IN_USE_RUNNING = 'Running';
/** A listed session between turns (AWAITING_INPUT): its process still holds the account. */
export const RUNNER_ACCOUNT_IN_USE_WAITING = 'Waiting for input';
/** A listed session with no title yet. */
export const RUNNER_ACCOUNT_IN_USE_UNTITLED = 'Untitled session';
