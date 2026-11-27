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
    /// Over the email field's list of people the owner has invited before.
    public static let invitedBefore = "People you’ve invited before"

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

/// The email field's suggestions (board docs/mocks/share-links/14-guest-suggestions): the people the
/// owner has invited before, narrowed by what is typed, and the date beside each — web's
/// `matchGuestSuggestions` and `lastInvitedLabel`, the same rules.
public enum SessionGuestSuggestions {
    /// How many the list shows at once.
    public static let shown = 5

    /// Where an email splits into words a query can start: `paula.ortiz@example.com` is found by "ortiz"
    /// and by "example".
    static let emailSeparators: Set<Character> = ["@", ".", "_", "+", "-"]

    /// The people to show for `query`, newest invitation first as the server ordered them. Empty field:
    /// the first five. Otherwise a person stays when the query starts their email, a word of their name
    /// or a word of their email; none when the query already is one of their emails, since there is
    /// nothing left to fill in.
    public static func matching(_ query: String, in people: [SessionGuestSuggestion]) -> [SessionGuestSuggestion] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return Array(people.prefix(shown)) }
        if people.contains(where: { $0.email.lowercased() == q }) { return [] }
        return Array(people.filter { matches(q, $0) }.prefix(shown))
    }

    static func matches(_ q: String, _ person: SessionGuestSuggestion) -> Bool {
        let email = person.email.lowercased()
        if email.hasPrefix(q) { return true }
        let nameWords = person.name.lowercased().split(whereSeparator: \.isWhitespace)
        let emailWords = email.split(whereSeparator: { emailSeparators.contains($0) })
        return (nameWords + emailWords).contains { $0.hasPrefix(q) }
    }

    /// One run of a name or email as the list draws it: `bold` where the query starts a word.
    public struct Run: Equatable, Sendable {
        public let text: String
        public let bold: Bool

        public init(_ text: String, bold: Bool) {
            self.text = text
            self.bold = bold
        }
    }

    /// `text` cut into runs, the query bold wherever it starts a word (after a space, or in an email
    /// after @ . _ + -). An empty query, or one that starts no word, is a single plain run.
    public static func runs(_ text: String, query: String) -> [Run] {
        let q = Array(query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        let chars = Array(text)
        guard !q.isEmpty else { return [Run(text, bold: false)] }
        var out: [Run] = []
        var plain = ""
        var i = 0
        while i < chars.count {
            let starts = i == 0 || chars[i - 1].isWhitespace || emailSeparators.contains(chars[i - 1])
            if starts, i + q.count <= chars.count,
               Array(String(chars[i..<(i + q.count)]).lowercased()) == q {
                if !plain.isEmpty { out.append(Run(plain, bold: false)); plain = "" }
                out.append(Run(String(chars[i..<(i + q.count)]), bold: true))
                i += q.count
            } else {
                plain.append(chars[i])
                i += 1
            }
        }
        if !plain.isEmpty { out.append(Run(plain, bold: false)) }
        return out
    }

    /// Beside each person: "Today" for an invitation today, else "Nov 13", in the reader's time zone.
    public static func date(_ iso: String, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        guard let at = RelativeTime.parse(iso) else { return "" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        if calendar.isDate(at, inSameDayAs: now) { return "Today" }
        return ProjectDone.date(iso, timeZone: timeZone) ?? ""
    }
}

/// Where and how the agent runs a guest's message: the session's runner and permission mode.
public struct SessionGuestContext: Equatable, Sendable {
    public let runnerName: String
    public let permissionMode: String

    /// A session that stores no mode runs in the account's, else Auto, as the server resolves it.
    public init(runnerName: String, permissionMode: String?, accountDefault: String? = nil) {
        self.runnerName = runnerName
        self.permissionMode = AgentDefaults.resolvePermissionMode(session: permissionMode,
                                                                  accountDefault: accountDefault).rawValue
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
    /// The people the owner has invited before, for the email field; empty until read, or when none.
    public private(set) var suggestions: [SessionGuestSuggestion] = []
    /// The row of the suggestion list that Return picks; none until an arrow moves to one, so Return
    /// invites what was typed, as on the web.
    public private(set) var highlighted: Int?
    /// Esc or a pick closes the list until the email is edited again.
    public private(set) var suggestionsClosed = false

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
        highlighted = nil
        suggestionsClosed = false
    }

    /// What the list under the focused field shows: nothing once closed.
    public var shownSuggestions: [SessionGuestSuggestion] {
        suggestionsClosed ? [] : SessionGuestSuggestions.matching(email, in: suggestions)
    }

    public mutating func suggestionsLoaded(_ people: [SessionGuestSuggestion]) {
        suggestions = people
        highlighted = nil
    }

    /// ↑ / ↓: move the highlighted row, staying within the list.
    public mutating func moveHighlight(by step: Int) {
        let count = shownSuggestions.count
        guard count > 0 else { return }
        guard let at = highlighted else {
            highlighted = step > 0 ? 0 : count - 1
            return
        }
        highlighted = min(max(at + step, 0), count - 1)
    }

    /// Fill the field with a suggestion's email and close the list. It never invites: Invite, and the
    /// tick a session that will not ask needs, stay the owner's to press.
    public mutating func pick(_ person: SessionGuestSuggestion) {
        email = person.email
        error = nil
        highlighted = nil
        suggestionsClosed = true
    }

    /// Return while a row is highlighted picks it; answers false otherwise (list closed, or no arrow
    /// pressed yet), so Return invites as before.
    public mutating func pickHighlighted() -> Bool {
        let shown = shownSuggestions
        guard let at = highlighted, !shown.isEmpty else { return false }
        pick(shown[min(at, shown.count - 1)])
        return true
    }

    public mutating func closeSuggestions() {
        suggestionsClosed = true
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
