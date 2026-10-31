/**
 * Every sentence of a machine's first workspace: the setup card, the message waiting under it, the
 * line a created workspace opens its conversation with, and the entries that lead there. The words are
 * the boards' (docs/mocks/first-workspace-in-conversation, 01 and 02) unless a note says otherwise. A
 * file of their own, so the native clients' copy parity can read one place when they draw the same card.
 */

export const setupTitle = (machine: string) => `Set up ${machine}`;
export const SETUP_LEAD = 'Pick where it works and sign in a coding CLI. Anything you send waits until both are done.';
export const setupOffline = (machine: string) => `${machine} is offline. It can’t check folders or sign in until it’s back.`;

// The two sentences for a runner too old to answer the directory probe. Not on a board: the interface
// agreement asks for one, and the second is for a machine whose updater is off, where the first would
// be a promise nothing keeps.
export const setupUpdating = (machine: string) =>
  `${machine} updates itself first: this version can’t check folders yet. You can sign in meanwhile.`;
export const setupNeedsUpdate = (machine: string) =>
  `${machine} can’t check folders on this version, and it can’t update itself.`;
export const SETUP_OPEN_MACHINE = 'Open machine';

export const SETUP_FOLDER = 'Folder';
export const setupFolderHelp = (machine: string) =>
  `Where on ${machine} should sessions work? They can read and change everything in it.`;
export const SETUP_REGISTER_DIR = 'Where you ran orbit register';
export const SETUP_NEW_FOLDER = 'A new folder';
export const SETUP_NEW_FOLDER_NAME = 'name';
export const SETUP_NEW_FOLDER_META = 'Starts empty. Ask for a clone or a new project in your first message.';
export const SETUP_NEW_FOLDER_DONE = 'new folder · created as the session starts';
// Not on a board: what the server's newFolder rule refuses, said before it has to.
export const SETUP_NEW_FOLDER_INVALID = 'Use letters, digits, dots, dashes and underscores, up to 64 characters.';
export const setupOtherFolder = (machine: string) => `Another folder on ${machine}`;
export const SETUP_USE_FOLDER = 'Use this folder';
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

export const setupSignIn = (engine: string, machine: string) => `Sign in ${engine} on ${machine}`;
export const SETUP_SIGN_IN_HELP = 'Sessions run on the coding CLIs signed in on that machine, and spend its subscription.';
export const setupSignedIn = (machine: string) => `signed in on ${machine}`;
export const setupUseEngine = (engine: string) => `Use ${engine} instead`;
// Not on a board: the step's two other shapes. A credential that needs no sign-in here, and an engine
// the machine doesn't have.
export const SETUP_ON_A_KEY = 'API key';
export const SETUP_ON_A_POOL = 'account pool';
export const setupNotInstalled = (engine: string, machine: string) => `${engine} isn’t installed on ${machine}.`;

export const SETUP_FOOT = 'Nothing is created until you send. You can rename the workspace or change these later.';
export const setupReady = (workspace: string, path: string) =>
  `Ready. Send a task — Orbit adds the workspace “${workspace}” for ${path} as it starts.`;

export const composerPlaceholderFor = (machine: string) => `Send ${machine} a task…`;

export const heldWaiting = (machine: string) => `Waiting for ${machine} — sends once both steps are done`;
export const HELD_WITHDRAW = 'Withdraw';
// Not on a board: the moment it goes, and the refusal it can meet there.
export const HELD_SENDING = 'Sending…';
export const heldFailed = (why: string) => `Couldn’t send: ${why}`;
export const HELD_TRY_AGAIN = 'Try again';
export const HELD_ALREADY_WAITING = 'One message is already waiting';
export const HELD_ALREADY_WAITING_DETAIL = 'Withdraw it to send a different one.';

export const CREATED_WORKSPACE = 'Created workspace';
export const CREATED_ON = 'on';
export const CREATED_RENAME = 'Rename';
export const CREATED_SETTINGS = 'Settings';
// Not on a board: the field Rename opens, and a refusal of it.
export const CREATED_RENAME_LABEL = 'Workspace name';
export const CREATED_RENAME_FAILED = 'Couldn’t rename the workspace';

export const START_A_SESSION = 'Start a session';
export const ENROLL_NEXT_TITLE = 'Next: start your first session';
export const ENROLL_NEXT_BODY =
  'Say what you want done. Orbit asks for the two things only you can decide — the folder it works in, and a coding CLI to sign in — on the same screen.';
export const ENROLL_OPEN_MACHINE = 'Open machine instead';
export const REGISTER_NEXT =
  "It's now on the Machines & models page, under Machines. Next, start a session on it — you pick the folder it works in and sign in a coding CLI there.";
export const machineEmpty = (machine: string) =>
  `No workspaces on ${machine} yet. Start a session and pick the folder it works in as you go — or add one here.`;
