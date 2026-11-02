package io.orbitd.android.composer

/**
 * Every sentence of a machine's first workspace: the setup card, the message waiting under it, the line a created workspace opens its
 * conversation with, and the entries that lead there. Names and words match iOS's `MachineSetupCopy.swift` and the web's
 * `src/web/src/lib/machineSetupCopy.ts`; `MachineSetupCopyParityTest` holds each one to `MachineSetupCopy.swift`.
 */
object MachineSetupCopy {
    fun setupTitle(machine: String): String = "Set up $machine"
    const val SETUP_LEAD = "Pick where it works and sign in a coding CLI. Anything you send waits until both are done."
    fun setupOffline(machine: String): String = "$machine is offline. It can’t check folders or sign in until it’s back."
    fun setupConnecting(machine: String): String =
        "Waiting for $machine to connect. It can check folders and sign in as soon as it does."

    fun setupUpdating(machine: String): String =
        "$machine updates itself first: this version can’t check folders yet. You can sign in meanwhile."
    fun setupNeedsUpdate(machine: String): String =
        "$machine can’t check folders on this version, and it can’t update itself."
    const val SETUP_OPEN_MACHINE = "Open machine"

    const val SETUP_FOLDER = "Folder"
    fun setupFolderHelp(machine: String): String =
        "Where on $machine should sessions work? They can read and change everything in it."
    const val SETUP_REGISTER_DIR = "Where you ran orbit register"
    const val SETUP_NEW_FOLDER = "A new folder"
    const val SETUP_NEW_FOLDER_NAME = "name"
    const val SETUP_NEW_FOLDER_META = "Starts empty. Ask for a clone or a new project in your first message."
    const val SETUP_NEW_FOLDER_DONE = "new folder · created as the session starts"
    const val SETUP_NEW_FOLDER_INVALID = "Use letters, digits, dots, dashes and underscores, up to 64 characters."
    fun setupNewFolderExists(machine: String): String =
        "This folder already exists on $machine. Sessions will use what’s in it."
    fun setupNewFolderIsFile(machine: String): String =
        "There’s already a file with this name on $machine. Pick another name."
    fun setupOtherFolder(machine: String): String = "Another folder on $machine"
    /** Board 03 draws it in the platform's title case; the words are the web's. */
    const val SETUP_USE_FOLDER = "Use This Folder"
    const val SETUP_CHANGE = "Change"

    fun setupChecking(machine: String): String = "Checking on $machine…"
    fun setupNoSuchDirectory(machine: String): String = "No such directory on $machine."
    const val SETUP_FOUND_PREFIX = "Found · "
    const val SETUP_NOT_GIT = "not a git repository — sessions will share it instead of isolating."
    fun setupGit(branch: String?): String = "git repository" + (branch?.takeIf { it.isNotEmpty() }?.let { " · $it" } ?: "")
    fun setupNotADirectory(machine: String): String = "That isn’t a directory on $machine."
    fun setupNoAnswer(machine: String): String = "$machine didn’t answer."
    fun setupCouldNotCheck(machine: String, why: String): String = "Couldn’t check on $machine: $why"
    const val SETUP_CHECK_AGAIN = "Check again"

    fun setupSignIn(engine: String, machine: String): String = "Sign in $engine on $machine"
    const val SETUP_SIGN_IN_HELP = "Sessions run on the coding CLIs signed in on that machine, and spend its subscription."
    fun setupSignedIn(machine: String): String = "signed in on $machine"
    fun setupUseEngine(engine: String): String = "Use $engine instead"
    const val SETUP_ON_A_KEY = "API key"
    const val SETUP_ON_A_POOL = "account pool"
    fun setupNotInstalled(engine: String, machine: String): String = "$engine isn’t installed on $machine."

    const val SETUP_FOOT = "Nothing is created until you send. You can rename the workspace or change these later."
    fun setupReady(workspace: String, path: String): String =
        "Ready. Send a task — Orbit adds the workspace “$workspace” for $path as it starts."

    fun composerPlaceholderFor(machine: String): String = "Send $machine a task…"

    fun heldWaiting(machine: String): String = "Waiting for $machine — sends once both steps are done"
    const val HELD_WITHDRAW = "Withdraw"
    const val HELD_SENDING = "Sending…"
    fun heldFailed(why: String): String = "Couldn’t send: $why"
    const val HELD_TRY_AGAIN = "Try again"
    const val HELD_ALREADY_WAITING = "One message is already waiting"
    const val HELD_ALREADY_WAITING_DETAIL = "Withdraw it to send a different one."

    const val CREATED_WORKSPACE = "Created workspace"
    const val CREATED_ON = "on"
    const val CREATED_RENAME = "Rename"
    const val CREATED_SETTINGS = "Settings"
    const val CREATED_RENAME_LABEL = "Workspace name"
    const val CREATED_RENAME_FAILED = "Couldn’t rename the workspace"

    const val START_A_SESSION = "Start a session"
    const val REGISTER_NEXT =
        "It's now on the Machines & models page, under Machines. Next, start a session on it — you pick the folder it works in and sign in a coding CLI there."

    // Client's own
    const val SETUP_USE_API_KEY = "Use an API Key"
    const val SETUP_PAGE_TITLE = "New session"
    fun machineEmptyHere(machine: String): String =
        "No workspaces on $machine yet. Start a session and pick the folder it works in as you go."
    const val RUNNER_WORKSPACES_TAP = "Tap a workspace to open its sessions."
    const val NO_WORKSPACES_YET = "No workspaces yet"
    const val NO_WORKSPACES_DETAIL = "A session makes its workspace as it starts."
}
