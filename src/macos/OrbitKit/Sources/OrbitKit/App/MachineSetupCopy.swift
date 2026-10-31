import Foundation

/// Every sentence of a machine's first workspace: the setup card, the message waiting under it, the
/// line a created workspace opens its conversation with, and the entries that lead there. Names match
/// the web's `src/web/src/lib/machineSetupCopy.ts`, and `MachineSetupCopyParityTests` holds each one to
/// it; the ones it lists as this client's own are said here and in no web file.
public enum MachineSetupCopy {
    public static func setupTitle(machine: String) -> String { "Set up \(machine)" }
    public static let SETUP_LEAD = "Pick where it works and sign in a coding CLI. Anything you send waits until both are done."
    public static func setupOffline(machine: String) -> String {
        "\(machine) is offline. It can’t check folders or sign in until it’s back."
    }

    public static func setupUpdating(machine: String) -> String {
        "\(machine) updates itself first: this version can’t check folders yet. You can sign in meanwhile."
    }
    public static func setupNeedsUpdate(machine: String) -> String {
        "\(machine) can’t check folders on this version, and it can’t update itself."
    }
    public static let SETUP_OPEN_MACHINE = "Open machine"

    public static let SETUP_FOLDER = "Folder"
    public static func setupFolderHelp(machine: String) -> String {
        "Where on \(machine) should sessions work? They can read and change everything in it."
    }
    public static let SETUP_REGISTER_DIR = "Where you ran orbit register"
    public static let SETUP_NEW_FOLDER = "A new folder"
    public static let SETUP_NEW_FOLDER_NAME = "name"
    public static let SETUP_NEW_FOLDER_META = "Starts empty. Ask for a clone or a new project in your first message."
    public static let SETUP_NEW_FOLDER_DONE = "new folder · created as the session starts"
    public static let SETUP_NEW_FOLDER_INVALID = "Use letters, digits, dots, dashes and underscores, up to 64 characters."
    public static func setupOtherFolder(machine: String) -> String { "Another folder on \(machine)" }
    /// Board 03 draws it in the platform's title case; the words are the web's.
    public static let SETUP_USE_FOLDER = "Use This Folder"
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

    public static func setupSignIn(engine: String, machine: String) -> String { "Sign in \(engine) on \(machine)" }
    public static let SETUP_SIGN_IN_HELP = "Sessions run on the coding CLIs signed in on that machine, and spend its subscription."
    public static func setupSignedIn(machine: String) -> String { "signed in on \(machine)" }
    public static func setupUseEngine(engine: String) -> String { "Use \(engine) instead" }
    public static let SETUP_ON_A_KEY = "API key"
    public static let SETUP_ON_A_POOL = "account pool"
    public static func setupNotInstalled(engine: String, machine: String) -> String {
        "\(engine) isn’t installed on \(machine)."
    }

    public static let SETUP_FOOT = "Nothing is created until you send. You can rename the workspace or change these later."
    public static func setupReady(workspace: String, path: String) -> String {
        "Ready. Send a task — Orbit adds the workspace “\(workspace)” for \(path) as it starts."
    }

    public static func composerPlaceholderFor(machine: String) -> String { "Send \(machine) a task…" }

    public static func heldWaiting(machine: String) -> String { "Waiting for \(machine) — sends once both steps are done" }
    public static let HELD_WITHDRAW = "Withdraw"
    public static let HELD_SENDING = "Sending…"
    public static func heldFailed(why: String) -> String { "Couldn’t send: \(why)" }
    public static let HELD_TRY_AGAIN = "Try again"
    public static let HELD_ALREADY_WAITING = "One message is already waiting"
    public static let HELD_ALREADY_WAITING_DETAIL = "Withdraw it to send a different one."

    public static let CREATED_WORKSPACE = "Created workspace"
    public static let CREATED_ON = "on"
    public static let CREATED_RENAME = "Rename"
    public static let CREATED_SETTINGS = "Settings"
    public static let CREATED_RENAME_LABEL = "Workspace name"
    public static let CREATED_RENAME_FAILED = "Couldn’t rename the workspace"

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
