import Foundation

/// Every sentence of a machine's first workspace: the setup card, the message waiting under it, the
/// line a created workspace opens its conversation with, and the entries that lead there. Names match
/// the web's `src/web/src/lib/machineSetupCopy.ts`, and `MachineSetupCopyParityTests` holds each one to
/// it; the ones it lists as this client's own are said here and in no web file.
public enum MachineSetupCopy {
    public static func setupTitle(machine: String) -> String { "Set up \(machine)" }

    public static func setupNeedsUpdate(machine: String) -> String {
        "\(machine) can’t check folders on this version, and it can’t update itself."
    }
    public static let SETUP_OPEN_MACHINE = "Open machine"

    public static let SETUP_FOLDER = "Folder"
    public static let SETUP_NEW_FOLDER_NAME = "name"
    public static let SETUP_FOLDER_HINT = "Uses this folder if it exists, otherwise creates it."
    public static let SETUP_NEW_FOLDER_META = "New folder · created as the session starts."
    public static let SETUP_NEW_FOLDER_DONE = "new folder · created as the session starts"
    public static let SETUP_NEW_FOLDER_INVALID = "Use letters, digits, dots, dashes and underscores, up to 64 characters."
    public static func setupNewFolderIsFile(machine: String) -> String {
        "There’s already a file with this name on \(machine). Pick another name."
    }
    // From GitHub (docs/mocks/github-workspace, board 01 P1–P4; board 04 A): a row under the folder's name field, behind an
    // "or" rule, that swaps the step to the repository picker; the link under the picker swaps it back.
    public static let SETUP_OR = "or"
    public static let SETUP_FOLDER_NAME_INSTEAD = "Type a folder name instead"
    public static let SETUP_FROM_GITHUB = "From GitHub"
    public static let SETUP_NEW_TAG = "NEW"
    public static let SETUP_GITHUB_META =
        "Clone a repository you can reach on GitHub. Orbit signs in for the clone and when it lands your work — nothing is saved on the machine."
    public static let SETUP_CONNECT_GITHUB = "Connect GitHub"
    public static let SETUP_CONNECT_GITHUB_META = "Opens GitHub, then comes back here."
    public static func setupGithubSignInAgain(login: String) -> String { "@\(login) needs to sign in again." }
    public static let SETUP_RECONNECT_GITHUB = "Reconnect GitHub"
    public static func setupGithubConnectFailed(why: String) -> String { "Couldn’t start connecting GitHub: \(why)" }
    /// The web's one GitHub template with a condition in it: the count is left out when GitHub wasn't asked.
    public static func setupGithubAccount(login: String, repositories: Int?) -> String {
        guard let repositories else { return "Signed in to GitHub as @\(login)" }
        return "Signed in to GitHub as @\(login) · \(repositories) \(repositories == 1 ? "repository" : "repositories")"
    }
    public static let SETUP_GITHUB_SEARCH = "Search your repositories"
    public static let SETUP_GITHUB_NOT_LISTED = "Not listed?"
    public static let SETUP_GITHUB_ADD_REPOSITORIES = "Add repositories on GitHub"
    public static let SETUP_GITHUB_LOADING = "Loading your repositories…"
    public static let SETUP_GITHUB_NONE = "No repository matches."
    public static func setupGithubListFailed(why: String) -> String { "Couldn’t list your repositories: \(why)" }
    public static let SETUP_GITHUB_PRIVATE = "Private"
    public static let SETUP_GITHUB_CLONED_META = "Cloned before the session starts. Work lands back on GitHub."
    public static let SETUP_OTHER_BRANCH = "Other branch"
    public static let SETUP_DEFAULT_BRANCH = "Default branch"
    public static let SETUP_BRANCH = "Branch"
    public static func setupGithubFolderExists(machine: String) -> String {
        "This folder already exists on \(machine). Pick another name."
    }
    public static let SETUP_GITHUB_DONE = "cloned before the session starts"
    public static func setupGithubDonePath(repository: String, path: String) -> String { "\(repository) → \(path)" }
    public static func setupCloneUpdating(machine: String) -> String {
        "\(machine) updates itself first: this version can’t clone yet."
    }
    public static func setupCloneNeedsUpdate(machine: String) -> String {
        "\(machine) can’t clone on this version, and it can’t update itself."
    }
    /// When a repository was last pushed, as the picker's row says it: minutes, hours, yesterday, then the date.
    public static func pushedAgo(_ pushedAt: String?, now: Date = Date()) -> String {
        guard let pushedAt, let at = RelativeTime.parse(pushedAt) else { return "" }
        let minutes = max(0, Int((now.timeIntervalSince(at) / 60).rounded(.down)))
        if minutes < 1 { return "pushed just now" }
        if minutes < 60 { return "pushed \(minutes) \(minutes == 1 ? "minute" : "minutes") ago" }
        let hours = minutes / 60
        if hours < 24 { return "pushed \(hours) \(hours == 1 ? "hour" : "hours") ago" }
        if hours < 48 { return "pushed yesterday" }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US")
        let calendar = Calendar.current
        format.dateFormat = calendar.component(.year, from: at) == calendar.component(.year, from: now) ? "MMM d" : "MMM d, yyyy"
        return "pushed \(format.string(from: at))"
    }
    /// Board 03 draws it in the platform's title case; the words are the web's.
    public static let SETUP_CHANGE = "Change"

    public static func setupChecking(machine: String) -> String { "Checking on \(machine)…" }
    public static func setupNoSuchDirectory(machine: String) -> String { "No such directory on \(machine)." }
    public static let SETUP_FOUND_PREFIX = "Found · "
    public static let SETUP_NOT_GIT = "not a git repository — sessions will share it instead of isolating."
    public static func setupGit(branch: String?) -> String {
        "git repository\(branch.map { " · \($0)" } ?? "")"
    }
    public static func setupNotADirectory(machine: String) -> String { "That isn’t a directory on \(machine)." }
    public static func setupNoAnswer(machine: String) -> String { "\(machine) didn’t answer." }
    public static func setupCouldNotCheck(machine: String, why: String) -> String {
        "Couldn’t check on \(machine): \(why)"
    }
    public static let SETUP_CHECK_AGAIN = "Check again"

    public static let SETUP_ON_A_KEY = "API key"
    public static let SETUP_ON_A_POOL = "account pool"


    // The card's own lines (owner 2026-11-16, docs/mocks/new-folder-in-home/workspace-card-with-name): a
    // machine with no workspace draws the card alone, which makes the workspace from a folder and a name,
    // and asks no sign-in.
    public static func setupNewWorkspaceTitle(machine: String) -> String { "New workspace on \(machine)" }
    public static func setupNewWorkspaceLead(machine: String) -> String {
        "Pick the folder on \(machine) this workspace works in. Its sessions can read and change everything in it."
    }
    public static let SETUP_NEW_FOLDER_WITH_WORKSPACE = "New folder · created with the workspace."
    public static let SETUP_NAME = "Name"
    public static let SETUP_NAME_PLACEHOLDER = "Same as the folder"
    public static let SETUP_NAME_HINT = "Same as the folder unless you change it. Shown in the sidebar."
    public static let SETUP_NAME_EDITED = "Shown in the sidebar. You can rename it later."
    public static let SETUP_NAME_EMPTY = "Give the workspace a name."
    public static func setupOfflineCreate(machine: String) -> String {
        "\(machine) is offline. It can’t check folders until it’s back."
    }
    public static func setupConnectingCreate(machine: String) -> String {
        "Waiting for \(machine) to connect. It can check folders as soon as it does."
    }
    public static func setupUpdatingCreate(machine: String) -> String {
        "\(machine) updates itself first: this version can’t check folders yet."
    }
    // The folder field takes a full path too (docs/mocks/new-workspace-form, decision 2 A). The hint is said where the
    // screen names the machine already (New workspace on a machine that has one); a bare machine's card keeps
    // SETUP_FOLDER_HINT.
    public static func setupFolderOrPathHint(root: String) -> String {
        "A name in \(root), or a full path. Uses the folder if it exists, otherwise creates it."
    }
    public static func setupPathUnchecked(machine: String) -> String { "\(machine) checks a full path once it’s up." }
    public static let SETUP_CREATE = "Create workspace"
    public static func setupCreateFailed(why: String) -> String { "Couldn’t create the workspace: \(why)" }

    public static func composerPlaceholderFor(machine: String) -> String { "Send \(machine) a task…" }

    public static func heldWaiting(machine: String) -> String { "Waiting for \(machine) — sends once both steps are done" }

    public static let CREATED_WORKSPACE = "Created workspace"
    public static let CREATED_ON = "on"
    public static let CREATED_RENAME = "Rename"
    public static let CREATED_SETTINGS = "Settings"
    public static let CREATED_RENAME_LABEL = "Workspace name"
    public static let CREATED_RENAME_FAILED = "Couldn’t rename the workspace"

    // A workspace cloned from GitHub: the same first line while its clone runs, once it is done, and when it failed (board 01, P5).
    public static let CLONE_CLONING = "Cloning"
    public static let CLONE_WAITING = "Waiting to clone"
    /// The reason arrives with the session's next read, a moment after the frame that says the clone failed: until
    /// then the sentence ends at the repository, with no colon left hanging.
    public static func cloneCouldNot(repository: String, why: String) -> String {
        why.isEmpty ? "Couldn’t clone \(repository)." : "Couldn’t clone \(repository): \(why)"
    }
    public static func cloneAppRemoved(repository: String) -> String {
        "Orbit’s GitHub App is no longer installed on \(repository)."
    }
    public static let CLONE_INSTALL_ON_GITHUB = "Install on GitHub"
    public static let CLONE_SIGN_IN_EXPIRED = "Your GitHub sign-in expired."
    public static let CLONE_RECONNECT = "Reconnect GitHub"
    public static let CLONE_RETRY = "Retry"
    public static let CLONE_RETRY_FAILED = "Couldn’t retry the clone"
    public static let CLONE_STARTS_WHEN_DONE = "Starts when the clone is done"

    public static let START_A_SESSION = "Start a session"
    public static let REGISTER_NEXT =
        "It's now on the Machines & models page, under Machines. Next, start a session on it — you pick the folder it works in and sign in a coding CLI there."

    // MARK: this client's own

    /// Board 03's second button under Sign In, and rule 5's words. On the web it is a sentence of
    /// RunnerSignIn, which says "instead".
    public static let SETUP_USE_API_KEY = "Use an API Key"
    /// The title bar of a machine's new session page: no workspace name to write yet (board 03).
    public static let SETUP_PAGE_TITLE = "New session"
    /// The web's `machineEmpty` without its "or add one here": these clients have no form to add one.
    public static func machineEmptyHere(machine: String) -> String {
        "No workspaces on \(machine) yet. Start a session and pick the folder it works in as you go."
    }
    /// A machine's Workspaces footer, now there is nothing to send anyone to the web for.
    public static let RUNNER_WORKSPACES_TAP = "Tap a workspace to open its sessions."
    /// Where a workspace list would be, for an account with none.
    public static let NO_WORKSPACES_YET = "No workspaces yet"
    public static let NO_WORKSPACES_DETAIL = "A session makes its workspace as it starts."
}
