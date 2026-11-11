import Foundation

/// Every sentence of a new account's welcome card (docs/mocks/new-user-onboarding, board 02): on the
/// managed runner's draft, on a bare machine's setup card, and for an account with no machine. Names
/// match the web's `src/web/src/lib/welcomeCopy.ts`, and `WelcomeCopyParityTests` holds each one to it.
public enum WelcomeCopy {
    /// The first word of the account's name: "Welcome to Orbit, Mia". Without a name, no comma.
    public static func welcomeTitle(name: String?) -> String {
        let first = (name ?? "").split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        return first.isEmpty ? "Welcome to Orbit" : "Welcome to Orbit, \(first)"
    }
    public static let WELCOME_LEAD =
        "Orbit gives a coding agent a computer and a task, and keeps the conversation and its results here — on the web and on your phone."

    public static let WELCOME_COMPUTER = "A computer to work on"
    public static let WELCOME_COMPUTER_MANAGED = "Orbit is starting one for you. You don’t need to install anything."
    public static let WELCOME_COMPUTER_OWN = "Connect the computer you want the agent to work on. Run this there:"
    public static let WELCOME_OWN_INSTEAD = "Use my own computer instead"
    public static let WELCOME_COMPUTER_DONE = "Computer"
    public static func welcomeComputerReady(machine: String) -> String { "\(machine) is ready" }
    public static let WELCOME_WAITING_CONNECT = "Waiting for it to connect… this page moves on by itself."
    public static let WELCOME_HAVING_TROUBLE = "Having trouble?"

    public static let WELCOME_MODEL = "A model to think with"
    public static let WELCOME_MODEL_HELP =
        "Sign in with your Claude or ChatGPT subscription, or use an API key. The sign-in stays on that computer."
    public static let WELCOME_MODEL_DONE = "Model"
    public static let WELCOME_AFTER_COMPUTER = "Opens once the computer is up"
    public static let WELCOME_AFTER_STEP_ONE = "Opens after step 1"

    public static let WELCOME_FIRST = "Your first message"
    public static let WELCOME_FIRST_HELP = "Pick one to try, or write your own below."
    /// Each one finishes in an empty folder within minutes. Picking one only fills the composer.
    public static let WELCOME_EXAMPLES = [
        "Build a one-page site that shows today’s weather for a city",
        "Read github.com/owner/repo and explain how it is put together",
        "Write a script that renames my photos by the date they were taken",
    ]

    /// The managed draft's foot: a first session can't start yet, can start and wait, or starts now.
    public static let WELCOME_FOOT_WAIT = "Your first message can go once steps 1 and 2 are done."
    public static let WELCOME_FOOT_SEND_NOW = "You can send now — it starts as soon as steps 1 and 2 are done."
    public static let WELCOME_FOOT_READY = "All set. Send it and the agent starts right away."

    public static let WELCOME_PLACEHOLDER = "Describe a task for the agent…"

    // MARK: the web's words for the model step's done line, which it writes inline

    /// `${engineName} signed in on ${machine}` (web `ManagedWelcomeCard`).
    public static func welcomeSignedIn(engine: String, machine: String) -> String { "\(engine) signed in on \(machine)" }
}

/// The welcome card's rules (docs/mocks/new-user-onboarding, board 03), the web's `WelcomeCard.tsx`'s.
public enum Welcome {
    /// The managed draft's foot (board 02, P1/P2).
    public enum Foot: Equatable, Sendable {
        /// A first session can't start yet.
        case wait
        /// It can be sent now, and starts as soon as steps 1 and 2 are done.
        case sendNow
        /// Both steps are done: it starts right away.
        case ready

        public var text: String {
            switch self {
            case .wait: return WelcomeCopy.WELCOME_FOOT_WAIT
            case .sendNow: return WelcomeCopy.WELCOME_FOOT_SEND_NOW
            case .ready: return WelcomeCopy.WELCOME_FOOT_READY
            }
        }
    }

    /// Whether this account has never had a session: the Open list and the Completed list, each read
    /// with `limit=1`, both answered empty. A read that failed (nil) is an account that is not new.
    /// Nothing is stored to remember it (board 03, rule 1).
    public static func isNewAccount(openRows: Int?, completedRows: Int?) -> Bool {
        openRows == 0 && completedRows == 0
    }

    /// A New Session draft in the managed runner's default workspace — the one page the managed welcome
    /// card stands on. Compared through `PublicID.storageKey`, as the managed console compares.
    public static func isManagedDefaultDraft(status: ManagedRunnerStatus?, workspaceID: String?) -> Bool {
        guard let managed = status?.workspaceId, let workspaceID else { return false }
        return PublicID.storageKey(managed) == PublicID.storageKey(workspaceID)
    }

    /// The managed runner is up, whatever it still lacks: its kind says so, or the runner is online.
    public static func computerUp(_ kind: ManagedRunnerDisplayKind?, runnerOnline: Bool) -> Bool {
        kind == .available || kind == .modelUnavailable || runnerOnline
    }

    /// WAIT / SEND_NOW / READY, exactly as the web's foot: ready only when a first session can start,
    /// the computer is up and the model step is done.
    public static func foot(startsNow: Bool, up: Bool, signedIn: Bool) -> Foot {
        if startsNow && up && signedIn { return .ready }
        return startsNow ? .sendNow : .wait
    }

    /// The example the composer holds, if it holds one untouched (the web marks it pressed).
    public static func picked(_ composerText: String, _ example: String) -> Bool {
        composerText.trimmingCharacters(in: .whitespacesAndNewlines) == example
    }

    /// The engine the managed card offers a sign-in for: the draft's own when a first session can start
    /// and it is one that signs in, else the runner's first installed one (web `welcomeEngine`).
    public static func engine(draftEngine: String, startsNow: Bool, runner: Runner?) -> LoginEngine {
        if startsNow, let own = LoginEngine(rawValue: draftEngine) { return own }
        return MachineSetup.firstEngineOn(runner?.engines)
    }
}
