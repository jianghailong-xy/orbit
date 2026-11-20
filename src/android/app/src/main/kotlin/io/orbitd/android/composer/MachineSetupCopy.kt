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
    // From GitHub (docs/mocks/github-workspace, board 01 P1–P4; board 04 A): a row under the folder's name field, behind an "or"
    // rule, that swaps the step to the repository picker; the link under the picker swaps it back.
    const val SETUP_OR = "or"
    const val SETUP_FOLDER_NAME_INSTEAD = "Type a folder name instead"
    const val SETUP_FROM_GITHUB = "From GitHub"
    const val SETUP_NEW_TAG = "NEW"
    const val SETUP_GITHUB_META =
        "Clone a repository you can reach on GitHub. Orbit signs in for the clone and when it lands your work — nothing is saved on the machine."
    const val SETUP_CONNECT_GITHUB = "Connect GitHub"
    const val SETUP_CONNECT_GITHUB_META = "Opens GitHub, then comes back here."
    fun setupGithubSignInAgain(login: String): String = "@$login needs to sign in again."
    const val SETUP_RECONNECT_GITHUB = "Reconnect GitHub"
    fun setupGithubConnectFailed(why: String): String = "Couldn’t start connecting GitHub: $why"
    /** The web's one GitHub template with a condition in it: the count is left out when GitHub wasn't asked. */
    fun setupGithubAccount(login: String, repositories: Int?): String =
        if (repositories == null) "Signed in to GitHub as @$login"
        else "Signed in to GitHub as @$login · $repositories ${if (repositories == 1) "repository" else "repositories"}"
    const val SETUP_GITHUB_SEARCH = "Search your repositories"
    const val SETUP_GITHUB_NOT_LISTED = "Not listed?"
    const val SETUP_GITHUB_ADD_REPOSITORIES = "Add repositories on GitHub"
    const val SETUP_GITHUB_LOADING = "Loading your repositories…"
    const val SETUP_GITHUB_NONE = "No repository matches."
    fun setupGithubListFailed(why: String): String = "Couldn’t list your repositories: $why"
    const val SETUP_GITHUB_PRIVATE = "Private"
    const val SETUP_GITHUB_CLONED_META = "Cloned before the session starts. Work lands back on GitHub."
    const val SETUP_OTHER_BRANCH = "Other branch"
    const val SETUP_DEFAULT_BRANCH = "Default branch"
    const val SETUP_BRANCH = "Branch"
    fun setupGithubFolderExists(machine: String): String = "This folder already exists on $machine. Pick another name."
    const val SETUP_GITHUB_DONE = "cloned before the session starts"
    fun setupGithubDonePath(repository: String, path: String): String = "$repository → $path"
    fun setupCloneUpdating(machine: String): String = "$machine updates itself first: this version can’t clone yet."
    fun setupCloneNeedsUpdate(machine: String): String = "$machine can’t clone on this version, and it can’t update itself."
    /** When a repository was last pushed, as the picker's row says it: minutes, hours, yesterday, then the date. */
    fun pushedAgo(pushedAt: String?, nowMs: Long = System.currentTimeMillis()): String {
        val at = pushedAt?.let { runCatching { java.time.OffsetDateTime.parse(it).toInstant() }.getOrNull() } ?: return ""
        val minutes = maxOf(0L, Math.floorDiv(nowMs - at.toEpochMilli(), 60_000L))
        if (minutes < 1) return "pushed just now"
        if (minutes < 60) return "pushed $minutes ${if (minutes == 1L) "minute" else "minutes"} ago"
        val hours = minutes / 60
        if (hours < 24) return "pushed $hours ${if (hours == 1L) "hour" else "hours"} ago"
        if (hours < 48) return "pushed yesterday"
        val zone = java.time.ZoneId.systemDefault()
        val date = at.atZone(zone)
        val sameYear = date.year == java.time.Instant.ofEpochMilli(nowMs).atZone(zone).year
        val pattern = if (sameYear) "MMM d" else "MMM d, yyyy"
        return "pushed " + java.time.format.DateTimeFormatter.ofPattern(pattern, java.util.Locale.US).format(date)
    }
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
    // The folder field takes a full path too (docs/mocks/new-workspace-form, decision 2 A). The hint is said where the screen names
    // the machine already (New workspace on a machine that has one); a bare machine's card keeps SETUP_FOLDER_HINT.
    fun setupFolderOrPathHint(root: String): String =
        "A name in $root, or a full path. Uses the folder if it exists, otherwise creates it."
    fun setupPathUnchecked(machine: String): String = "$machine checks a full path once it’s up."
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

    // A workspace cloned from GitHub: the same first line while its clone runs, once it is done, and when it failed (board 01, P5).
    const val CLONE_CLONING = "Cloning"
    const val CLONE_WAITING = "Waiting to clone"
    /** The reason arrives with the session's next read, a moment after the frame that says the clone failed: until then the sentence
     *  ends at the repository, with no colon left hanging. */
    fun cloneCouldNot(repository: String, why: String): String =
        if (why.isEmpty()) "Couldn’t clone $repository." else "Couldn’t clone $repository: $why"
    fun cloneAppRemoved(repository: String): String = "Orbit’s GitHub App is no longer installed on $repository."
    const val CLONE_INSTALL_ON_GITHUB = "Install on GitHub"
    const val CLONE_SIGN_IN_EXPIRED = "Your GitHub sign-in expired."
    const val CLONE_RECONNECT = "Reconnect GitHub"
    const val CLONE_RETRY = "Retry"
    const val CLONE_RETRY_FAILED = "Couldn’t retry the clone"
    const val CLONE_STARTS_WHEN_DONE = "Starts when the clone is done"

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
