package io.orbitd.android.composer

/**
 * Every sentence of a machine's first workspace: the setup card, the message waiting under it, the line a created workspace opens its
 * conversation with, and the entries that lead there. Names and words match iOS's `MachineSetupCopy.swift` and the web's
 * `src/web/src/lib/machineSetupCopy.ts`; `MachineSetupCopyParityTest` holds each one to `MachineSetupCopy.swift`.
 */
object MachineSetupCopy {
    fun setupTitle(machine: String): String = "Set up $machine"

    fun setupNeedsUpdate(machine: String): String =
        "$machine can’t check folders on this version, and it can’t update itself."
    const val SETUP_OPEN_MACHINE = "Open machine"

    const val SETUP_FOLDER = "Folder"
    const val SETUP_NEW_FOLDER_NAME = "name"
    const val SETUP_FOLDER_HINT = "Uses this folder if it exists, otherwise creates it."
    const val SETUP_NEW_FOLDER_META = "New folder · created as the session starts."
    const val SETUP_NEW_FOLDER_DONE = "new folder · created as the session starts"
    const val SETUP_NEW_FOLDER_INVALID = "Use letters, digits, dots, dashes and underscores, up to 64 characters."
    fun setupNewFolderIsFile(machine: String): String =
        "There’s already a file with this name on $machine. Pick another name."
    /** Board 03 draws it in the platform's title case; the words are the web's. */
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

    const val SETUP_ON_A_KEY = "API key"
    const val SETUP_ON_A_POOL = "account pool"


    // The card alone on a machine with no workspace (owner 2026-11-16, docs/mocks/new-folder-in-home/workspace-card-with-name): it
    // makes the workspace from a folder and a name, and asks no sign-in.
    fun setupNewWorkspaceTitle(machine: String): String = "New workspace on $machine"
    fun setupNewWorkspaceLead(machine: String): String =
        "Pick the folder on $machine this workspace works in. Its sessions can read and change everything in it."
    const val SETUP_NEW_FOLDER_WITH_WORKSPACE = "New folder · created with the workspace."
    const val SETUP_NAME = "Name"
    const val SETUP_NAME_PLACEHOLDER = "Same as the folder"
    const val SETUP_NAME_HINT = "Same as the folder unless you change it. Shown in the sidebar."
    const val SETUP_NAME_EDITED = "Shown in the sidebar. You can rename it later."
    const val SETUP_NAME_EMPTY = "Give the workspace a name."
    fun setupOfflineCreate(machine: String): String = "$machine is offline. It can’t check folders until it’s back."
    fun setupConnectingCreate(machine: String): String =
        "Waiting for $machine to connect. It can check folders as soon as it does."
    fun setupUpdatingCreate(machine: String): String =
        "$machine updates itself first: this version can’t check folders yet."
    const val SETUP_CREATE = "Create workspace"
    fun setupCreateFailed(why: String): String = "Couldn’t create the workspace: $why"

    fun composerPlaceholderFor(machine: String): String = "Send $machine a task…"

    fun heldWaiting(machine: String): String = "Waiting for $machine — sends once both steps are done"

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
