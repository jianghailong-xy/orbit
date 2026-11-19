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
    public static let WELCOME_COMPUTER_OWN = "Connect the computer you want the agent to work on. Run this there:"
    public static let WELCOME_WAITING_CONNECT = "Waiting for it to connect… this page moves on by itself."
    public static let WELCOME_HAVING_TROUBLE = "Having trouble?"

    public static let WELCOME_MODEL = "A model to think with"
    public static let WELCOME_MODEL_HELP =
        "Sign in with your Claude or ChatGPT subscription, or use an API key. The sign-in stays on that computer."
    public static let WELCOME_AFTER_STEP_ONE = "Opens after step 1"

    public static let WELCOME_FIRST = "Your first message"
    public static let WELCOME_FIRST_HELP = "Pick one to try, or write your own below."
    /// Each one finishes in an empty folder within minutes. Picking one only fills the composer.
    public static let WELCOME_EXAMPLES = [
        "Build a one-page site that shows today’s weather for a city",
        "Read github.com/owner/repo and explain how it is put together",
        "Write a script that renames my photos by the date they were taken",
    ]

    public static let WELCOME_PLACEHOLDER = "Describe a task for the agent…"
}

/// The welcome card's rules (docs/mocks/new-user-onboarding, board 03), the web's `WelcomeCard.tsx`'s.
public enum Welcome {
    /// Whether this account has never had a session: the Open list and the Completed list, each read
    /// with `limit=1`, both answered empty. A read that failed (nil) is an account that is not new.
    /// Nothing is stored to remember it (board 03, rule 1).
    public static func isNewAccount(openRows: Int?, completedRows: Int?) -> Bool {
        openRows == 0 && completedRows == 0
    }

    /// The example the composer holds, if it holds one untouched (the web marks it pressed).
    public static func picked(_ composerText: String, _ example: String) -> Bool {
        composerText.trimmingCharacters(in: .whitespacesAndNewlines) == example
    }
}
