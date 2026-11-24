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
export const RUNNER_ACCOUNT_REMOVE_DETAIL = 'Its sessions move to another account first. Workspaces using it switch to Default.';

/** Removing Default, which only Orbit stops using; `cli` is the CLI's own name (Codex, Claude Code). */
export function runnerDefaultRemoveDetail(runner: string, cli: string): string {
  return `Orbit stops using it on ${runner}. Its sign-in stays on the machine, and ${cli} in a terminal there keeps working. Workspaces set to it run on Automatic.`;
}

/** Removing an added account while Default is removed from Orbit, with another account left. */
export function runnerAccountRemoveDetailAutomatic(runner: string): string {
  return `Its sessions move to another account first, then its sign-in is deleted from ${runner}. Workspaces set to this account run on Automatic.`;
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

/** Over the sessions a refused removal lists, when one session in the account can't move to another —
 *  no other account is signed in, or its runner can't carry the conversation; `engine` is the CLI's own
 *  name (Codex, Claude Code). Sessions that can move are moved, and don't refuse it. */
export function runnerAccountInUseOne(engine: string): string {
  return `This ${engine} account can’t be removed while a session on it can’t move to another account — sign in another account, or end the session below; then remove the account`;
}

/** The same, when several sessions in it can't move. */
export function runnerAccountInUseMany(engine: string, count: number): string {
  return `This ${engine} account can’t be removed while ${count} sessions on it can’t move to another account — sign in another account, or end them below; then remove the account`;
}

/** Under an account whose removal is waiting on the one session it moved to another account to leave. */
export function runnerAccountMovingOne(engine: string): string {
  return `Moving a session to another ${engine} account — this one is removed once it has left, after its turn if one is running`;
}

/** The same, when it moved several. */
export function runnerAccountMovingMany(engine: string, count: number): string {
  return `Moving ${count} sessions to another ${engine} account — this one is removed once they have left, after their turns if any are running`;
}

/** Each listed session's way to it. */
export const RUNNER_ACCOUNT_IN_USE_OPEN = 'Open session';
/** A listed session in a turn (RUNNING, or PENDING on its way to one). */
export const RUNNER_ACCOUNT_IN_USE_RUNNING = 'Running';
/** A listed session between turns (AWAITING_INPUT): its process still holds the account. */
export const RUNNER_ACCOUNT_IN_USE_WAITING = 'Waiting for input';
/** A listed session with no title yet. */
export const RUNNER_ACCOUNT_IN_USE_UNTITLED = 'Untitled session';

/** An added Claude Code account's way to become the Default: the item in its ⋯ menu, and what it does. */
export const RUNNER_ACCOUNT_SET_DEFAULT = 'Set as default';
export const RUNNER_ACCOUNT_SET_DEFAULT_HINT = 'Moves this login into ~/.claude, so the terminal uses it too';
/** Why that item can't be chosen: the runner is offline, too old to swap logins, or swapping already. */
export const RUNNER_ACCOUNT_SET_DEFAULT_OFFLINE = 'The runner is offline';
export const RUNNER_ACCOUNT_SET_DEFAULT_UPDATE = 'Update the runner to set a default Claude Code account on it';
export const RUNNER_ACCOUNT_SET_DEFAULT_BUSY = 'A default is already being set on this runner';

/** The question in front of Set as default. */
export function runnerAccountSetDefaultTitle(name: string): string {
  return `Make ${name} the default?`;
}

/** What Set as default comes to: `name` is the added account and `dir` its folder, `defaultName` and
 *  `defaultDir` the Default's, each the way a terminal spells it. */
export function runnerAccountSetDefaultDetail(name: string, defaultDir: string, defaultName: string, dir: string, runner: string): string {
  return `${name}’s login moves to ${defaultDir}, and ${defaultName}’s to ${dir}. Claude Code in a terminal on ${runner} uses ${name} from then on — restart any that are open. Sessions stay on their accounts, and a turn in progress finishes first. Workspaces keep their account.`;
}

/** The confirmation's own button. */
export const RUNNER_ACCOUNT_SET_DEFAULT_CONFIRM = 'Make default';

/** Under the account while it is being made the Default, with no turn left to wait for. */
export function runnerAccountSettingDefault(name: string): string {
  return `Making ${name} the default`;
}

/** The same, while one session on either account finishes its turn. */
export function runnerAccountSettingDefaultOne(name: string): string {
  return `Making ${name} the default — waiting for 1 session to finish its turn`;
}

/** The same, while several do. */
export function runnerAccountSettingDefaultMany(name: string, count: number): string {
  return `Making ${name} the default — waiting for ${count} sessions to finish their turns`;
}

/** Beside it, while Claude Code runs in a terminal on either folder: the swap waits for it to exit. */
export const RUNNER_ACCOUNT_SETTING_DEFAULT_TERMINAL = 'It also waits for Claude Code running in a terminal there to exit.';

/** A swap that failed, or that the control plane refused: over the reason. */
export function runnerAccountSetDefaultFailed(name: string): string {
  return `Couldn’t make ${name} the default`;
}

/** Under that reason: a failed swap puts both logins back. */
export const RUNNER_ACCOUNT_SET_DEFAULT_UNCHANGED = 'Both logins are as they were.';

/** What a former Default is called — the account a Set as default moved out of ~/.claude into an added
 *  folder — while the owner has not named it and no email is known for it. */
export const RUNNER_ACCOUNT_FORMER_DEFAULT = 'Former default';

/** The question in front of Default's Sign out…, which deletes its login from the machine. */
export function runnerDefaultSignOutTitle(name: string): string {
  return `Sign out of ${name}?`;
}

/** What Sign out of Default does to the machine: the login goes, the history and settings stay. */
export function runnerDefaultSignOutDetail(runner: string): string {
  return `Its login is deleted from ${runner}. Its history and settings stay.`;
}

/** Added for Claude Code and Codex, whose CLI shares Default's login; `command` is `claude` or `codex`. */
export function runnerDefaultSignOutTerminal(runner: string, command: string): string {
  return `${command} in a terminal on ${runner} is signed out too.`;
}

export const RUNNER_DEFAULT_SIGN_OUT_CONFIRM = 'Sign out';

/** The menu item, and the row's state while the runner takes the login off the machine. */
export const RUNNER_DEFAULT_SIGN_OUT = 'Sign out…';
export const RUNNER_DEFAULT_SIGNING_OUT = 'Signing out…';

/** The second question, after the runner refused because sessions are running on Default. */
export function runnerDefaultSignOutRunningOne(name: string): string {
  return `1 session is running on ${name}. Sign out anyway?`;
}

export function runnerDefaultSignOutRunningMany(count: number, name: string): string {
  return `${count} sessions are running on ${name}. Sign out anyway?`;
}

export const RUNNER_DEFAULT_SIGN_OUT_RUNNING_DETAIL = 'They will stop working until you sign in again.';

export function runnerDefaultSignOutFailed(name: string): string {
  return `Couldn’t sign out of ${name}`;
}
