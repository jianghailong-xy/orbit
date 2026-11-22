/**
 * Every sentence of a machine's first workspace: the setup card, the message waiting under it, the
 * line a created workspace opens its conversation with, and the entries that lead there. The words are
 * the boards' (docs/mocks/first-workspace-in-conversation, 01 and 02) unless a note says otherwise. A
 * file of their own, so the native clients' copy parity can read one place when they draw the same card.
 */

export const setupTitle = (machine: string) => `Set up ${machine}`;
// Not on a board: a machine approved a moment ago that has not connected yet. It has declared nothing because it has not
// beaten yet, not because it is too old, and nothing is wrong with it: the card waits for it, as a message sent meanwhile does.

// The two sentences for a runner too old to answer the directory probe. Not on a board: the interface
// agreement asks for one, and the second is for a machine whose updater is off, where the first would
// be a promise nothing keeps.
export const setupNeedsUpdate = (machine: string) =>
  `${machine} can’t check folders on this version, and it can’t update itself.`;
export const SETUP_OPEN_MACHINE = 'Open machine';

export const SETUP_FOLDER = 'Folder';
export const SETUP_NEW_FOLDER_NAME = 'name';
export const SETUP_FOLDER_HINT = 'Uses this folder if it exists, otherwise creates it.';
export const SETUP_NEW_FOLDER_META = 'New folder · created as the session starts.';
export const SETUP_NEW_FOLDER_DONE = 'new folder · created as the session starts';
// Not on a board: what the server's newFolder rule refuses, said before it has to.
export const SETUP_NEW_FOLDER_INVALID = 'Use letters, digits, dots, dashes and underscores, up to 64 characters.';
// Not on a board: a folder's name the machine already has as a file, which can't become one.
export const setupNewFolderIsFile = (machine: string) =>
  `There’s already a file with this name on ${machine}. Pick another name.`;
// From GitHub (docs/mocks/github-workspace, board 01 P1–P4; board 04 A): a row under the folder's name field, behind an
// "or" rule, that swaps the step to the repository picker; the link under the picker swaps it back.
export const SETUP_OR = 'or';
export const SETUP_FOLDER_NAME_INSTEAD = 'Type a folder name instead';
export const SETUP_FROM_GITHUB = 'From GitHub';
export const SETUP_NEW_TAG = 'NEW';
export const SETUP_GITHUB_META =
  'Clone a repository you can reach on GitHub. Orbit signs in for the clone and when it lands your work — nothing is saved on the machine.';
export const SETUP_CONNECT_GITHUB = 'Connect GitHub';
export const SETUP_CONNECT_GITHUB_META = 'Opens GitHub, then comes back here.';
// Not on a board: a connection GitHub no longer takes, and a press that could not leave for GitHub.
export const setupGithubSignInAgain = (login: string) => `@${login} needs to sign in again.`;
export const SETUP_RECONNECT_GITHUB = 'Reconnect GitHub';
export const setupGithubConnectFailed = (why: string) => `Couldn’t start connecting GitHub: ${why}`;
export const setupGithubAccount = (login: string, repositories: number | null) =>
  repositories === null
    ? `Signed in to GitHub as @${login}`
    : `Signed in to GitHub as @${login} · ${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`;
export const SETUP_GITHUB_SEARCH = 'Search your repositories';
export const SETUP_GITHUB_NOT_LISTED = 'Not listed?';
export const SETUP_GITHUB_ADD_REPOSITORIES = 'Add repositories on GitHub';
// Not on a board: the list's other answers.
export const SETUP_GITHUB_LOADING = 'Loading your repositories…';
export const SETUP_GITHUB_NONE = 'No repository matches.';
export const setupGithubListFailed = (why: string) => `Couldn’t list your repositories: ${why}`;
export const SETUP_GITHUB_PRIVATE = 'Private';
export const SETUP_GITHUB_CLONED_META = 'Cloned before the session starts. Work lands back on GitHub.';
export const SETUP_OTHER_BRANCH = 'Other branch';
export const SETUP_DEFAULT_BRANCH = 'Default branch';
export const SETUP_BRANCH = 'Branch';
export const setupGithubFolderExists = (machine: string) => `This folder already exists on ${machine}. Pick another name.`;
export const SETUP_GITHUB_DONE = 'cloned before the session starts';
export const setupGithubDonePath = (repository: string, path: string) => `${repository} → ${path}`;
// A machine too old to clone: the board's edge row, in the words the folder check already uses for the same case.
export const setupCloneUpdating = (machine: string) => `${machine} updates itself first: this version can’t clone yet.`;
export const setupCloneNeedsUpdate = (machine: string) => `${machine} can’t clone on this version, and it can’t update itself.`;
export const pushedAgo = (pushedAt: string | null, now: number = Date.now()): string => {
  if (!pushedAt) return '';
  const at = Date.parse(pushedAt);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'pushed just now';
  if (minutes < 60) return `pushed ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `pushed ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  if (hours < 48) return 'pushed yesterday';
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return `pushed ${date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
};
export const SETUP_CHANGE = 'Change';

export const setupChecking = (machine: string) => `Checking on ${machine}…`;
export const setupNoSuchDirectory = (machine: string) => `No such directory on ${machine}.`;
export const SETUP_FOUND_PREFIX = 'Found · ';
export const SETUP_NOT_GIT = 'not a git repository — sessions will share it instead of isolating.';
export const setupGit = (branch: string | null) => `git repository${branch ? ` · ${branch}` : ''}`;
// Not on a board: the three ways a check ends without a verdict the board drew.
export const setupNotADirectory = (machine: string) => `That isn’t a directory on ${machine}.`;
export const setupNoAnswer = (machine: string) => `${machine} didn’t answer.`;
export const setupCouldNotCheck = (machine: string, why: string) => `Couldn’t check on ${machine}: ${why}`;
export const SETUP_CHECK_AGAIN = 'Check again';

// Not on a board: the step's two other shapes. A credential that needs no sign-in here, and an engine
// the machine doesn't have.
export const SETUP_ON_A_KEY = 'API key';
export const SETUP_ON_A_POOL = 'account pool';


// The web card's own lines (owner 2026-11-16, docs/mocks/new-folder-in-home/workspace-card-with-name): on the web a
// machine with no workspace draws the card alone, which makes the workspace from a folder and a name, and asks no
// sign-in. The native clients still send to make it, so the lines above stay theirs (copy parity).
export const setupNewWorkspaceTitle = (machine: string) => `New workspace on ${machine}`;
export const setupNewWorkspaceLead = (machine: string) =>
  `Pick the folder on ${machine} this workspace works in. Its sessions can read and change everything in it.`;
export const SETUP_NEW_FOLDER_WITH_WORKSPACE = 'New folder · created with the workspace.';
export const SETUP_NAME = 'Name';
export const SETUP_NAME_PLACEHOLDER = 'Same as the folder';
export const SETUP_NAME_HINT = 'Same as the folder unless you change it. Shown in the sidebar.';
export const SETUP_NAME_EDITED = 'Shown in the sidebar. You can rename it later.';
export const SETUP_NAME_EMPTY = 'Give the workspace a name.';
export const setupOfflineCreate = (machine: string) => `${machine} is offline. It can’t check folders until it’s back.`;
export const setupConnectingCreate = (machine: string) =>
  `Waiting for ${machine} to connect. It can check folders as soon as it does.`;
export const setupUpdatingCreate = (machine: string) =>
  `${machine} updates itself first: this version can’t check folders yet.`;
// The folder field takes a full path too (docs/mocks/new-workspace-form, decision 2 A). Web only until the native
// clients follow; their card keeps SETUP_FOLDER_HINT.
export const setupFolderOrPathHint = (root: string) =>
  `A name in ${root}, or a full path. Uses the folder if it exists, otherwise creates it.`;
export const setupPathUnchecked = (machine: string) => `${machine} checks a full path once it’s up.`;
export const SETUP_CREATE = 'Create workspace';
export const setupCreateFailed = (why: string) => `Couldn’t create the workspace: ${why}`;

export const composerPlaceholderFor = (machine: string) => `Send ${machine} a task…`;

export const heldWaiting = (machine: string) => `Waiting for ${machine} — sends once both steps are done`;
// Not on a board: the moment it goes, and the refusal it can meet there.

export const CREATED_WORKSPACE = 'Created workspace';
export const CREATED_ON = 'on';
export const CREATED_RENAME = 'Rename';
export const CREATED_SETTINGS = 'Settings';
// Not on a board: the field Rename opens, and a refusal of it.
export const CREATED_RENAME_LABEL = 'Workspace name';
export const CREATED_RENAME_FAILED = 'Couldn’t rename the workspace';

// A workspace cloned from GitHub: the same first line while its clone runs, once it is done, and when it failed (board 01, P5).
export const CLONE_CLONING = 'Cloning';
// Not on a board: before the machine has started it.
export const CLONE_WAITING = 'Waiting to clone';
// The reason arrives with the session's next read, a moment after the frame that says the clone failed.
export const cloneCouldNot = (repository: string, why: string) =>
  why ? `Couldn’t clone ${repository}: ${why}` : `Couldn’t clone ${repository}.`;
export const cloneAppRemoved = (repository: string) => `Orbit’s GitHub App is no longer installed on ${repository}.`;
export const CLONE_INSTALL_ON_GITHUB = 'Install on GitHub';
export const CLONE_SIGN_IN_EXPIRED = 'Your GitHub sign-in expired.';
export const CLONE_RECONNECT = 'Reconnect GitHub';
export const CLONE_RETRY = 'Retry';
export const CLONE_RETRY_FAILED = 'Couldn’t retry the clone';
export const CLONE_STARTS_WHEN_DONE = 'Starts when the clone is done';

export const START_A_SESSION = 'Start a session';
export const ENROLL_NEXT_TITLE = 'Next: start your first session';
export const ENROLL_NEXT_BODY =
  'Say what you want done. Orbit asks for the two things only you can decide — the folder it works in, and a coding CLI to sign in — on the same screen.';
export const ENROLL_OPEN_MACHINE = 'Open machine instead';
export const REGISTER_NEXT =
  "It's now on the Machines & models page, under Machines. Next, start a session on it — you pick the folder it works in and sign in a coding CLI there.";
export const REGISTER_NEXT_IN_SETTINGS =
  "It's now under Machines on the left. Next, start a session on it — you pick the folder it works in and sign in a coding CLI there.";
export const machineEmpty = (machine: string) =>
  `No workspaces on ${machine} yet. Start a session and pick the folder it works in as you go — or add one here.`;
