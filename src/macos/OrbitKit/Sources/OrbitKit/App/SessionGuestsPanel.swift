import Foundation

/// The words of the Share panel's People who can reply — web's `SessionGuests.tsx` and the line it
/// puts under Access, word for word (docs/session-guests-design.md §3; board
/// docs/mocks/share-links/10-session-guests-2).
public enum SessionGuestsCopy {
    public static let peopleWhoCanReply = "People who can reply"
    public static let emailPlaceholder = "Email of an Orbit account"
    public static let invite = "Invite"
    public static let remove = "Remove"
    public static let acknowledge = "I understand the agent won’t ask before acting on their messages"
    /// Under Access while no public link is open, in a session's panel: the people below can still reply.
    public static let privateDetail = "No public link. People you invite below can still open and reply."
    public static let couldNotRemove = "Couldn't remove them"

    /// The session's permission mode as the consequence line says it.
    public static func modeWords(_ mode: String) -> String {
        switch mode {
        case "default": return "Default"
        case "plan": return "Plan"
        case "acceptEdits": return "Accept edits"
        case "auto": return "Auto"
        case "dontAsk": return "Don’t ask"
        case "bypassPermissions": return "Bypass permissions"
        default: return mode
        }
    }

    /// The modes in which the agent acts on a guest's message without asking anyone first.
    public static let unaskingModes: Set<String> = ["auto", "dontAsk", "bypassPermissions"]

    /// What inviting someone means, said in the panel rather than in a separate warning (§3): their
    /// messages run on the owner's machine, in the session's mode, on the owner's accounts. In a mode
    /// that does not ask, the line is amber and says so instead of promising approvals that will not come.
    public static func consequence(runnerName: String, permissionMode: String) -> (text: String, warns: Bool) {
        let warns = unaskingModes.contains(permissionMode)
        let runs = "They can send messages to this session. The agent runs them on \(runnerName) as "
            + "\(modeWords(permissionMode)), using your accounts"
        return warns
            ? ("\(runs) — it won’t ask before acting.", true)
            : ("\(runs). Approvals and the agent’s questions still come only to you.", false)
    }

    /// "12 messages today" once the guest has opened the session or written, else "Not opened yet".
    public static func activity(_ guest: SessionGuestPerson) -> String {
        guest.opened || guest.messagesToday > 0
            ? "\(SharePanelCopy.countOf(guest.messagesToday, "message")) today"
            : SharePanelCopy.notOpenedYet
    }
}

/// Where and how the agent runs a guest's message: the session's runner and permission mode.
public struct SessionGuestContext: Equatable, Sendable {
    public let runnerName: String
    public let permissionMode: String

    public init(runnerName: String, permissionMode: String?) {
        self.runnerName = runnerName
        self.permissionMode = permissionMode ?? "default"
    }
}

/// People who can reply: the Share panel's section for a session — the native half of web's
/// `SessionGuestsSection`. An email and Invite, one row per guest with today's messages, and Remove,
/// which takes effect at once. The first invite to a session in Auto, Don't ask or Bypass needs the
/// owner to tick that the agent won't ask before acting on a guest's message.
public struct SessionGuestsPanel: Equatable, Sendable {
    public let context: SessionGuestContext
    /// Nil until the server has answered.
    public private(set) var guests: [SessionGuestPerson]?
    public var email = ""
    /// The reason the last invite was refused, shown under the field until the email changes.
    public private(set) var error: String?
    public var acknowledged = false
    public private(set) var inviting = false

    public init(context: SessionGuestContext) {
        self.context = context
    }

    public var consequence: (text: String, warns: Bool) {
        SessionGuestsCopy.consequence(runnerName: context.runnerName, permissionMode: context.permissionMode)
    }

    /// The tick is asked for only before the first guest of a session that will not ask.
    public var needsAcknowledge: Bool {
        consequence.warns && guests?.isEmpty == true
    }

    public var canInvite: Bool {
        !trimmedEmail.isEmpty && !inviting && (!needsAcknowledge || acknowledged)
    }

    public var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    public mutating func editEmail(_ value: String) {
        email = value
        error = nil
    }

    /// Start an invite: answers the email to send, or nil when Invite cannot be pressed.
    public mutating func beginInvite() -> String? {
        guard canInvite else { return nil }
        inviting = true
        return trimmedEmail
    }

    public mutating func loaded(_ people: [SessionGuestPerson]) {
        guests = people
    }

    public mutating func invited(_ people: [SessionGuestPerson]) {
        guests = people
        email = ""
        error = nil
        inviting = false
    }

    public mutating func inviteFailed(_ reason: String) {
        error = reason
        inviting = false
    }
}
