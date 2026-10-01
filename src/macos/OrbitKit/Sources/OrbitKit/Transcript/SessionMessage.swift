import Foundation

// Another Orbit session's message, as the control plane recorded who sent it beside the turn's echo
// (`sessionMessage`, apiserver `sessions/session-message.ts`).
//
// `session_send` and `project_send` write a turn into this conversation that the account owner did
// not type, and without this it was drawn as the owner's own bubble — the reader looking at another
// agent's words in their own name. The sender is the server's to record, from the caller's own
// identity, never from anything the caller sent. The web reads the same payload with
// `parseSessionMessage` (src/web/src/lib/sessionMessage.ts) and draws it as `SessionMessageCard.tsx`;
// this is that rule for iOS and macOS: the one field that makes a payload a card, the same defaults,
// and a payload that is not a card parses as NOTHING — which leaves every turn the owner typed, and
// every turn stored before the payload existed, drawn exactly as it was.
// `SessionMessageCopyParityTests` holds the two ends' words to each other. Nothing here is read out
// of the message's text.

/// Who sent one turn, when it was another Orbit session. Mirrors `@orbit/shared`'s
/// `SessionMessageCard`.
public struct SessionMessage: Sendable, Equatable, Codable {
    /// The sending session, in the uuid spelling every other read of one uses.
    public let fromSessionId: String
    public let fromTitle: String
    /// The sending session's workspace — the agent it runs as.
    public let fromAgentName: String
    /// The task the sending session runs; nil when it runs none.
    public let fromTaskId: String?

    public init(fromSessionId: String, fromTitle: String = "", fromAgentName: String = "",
                fromTaskId: String? = nil) {
        self.fromSessionId = fromSessionId
        self.fromTitle = fromTitle
        self.fromAgentName = fromAgentName
        self.fromTaskId = fromTaskId
    }

    /// The card a `user` event's payload carries, or nil for the ordinary case — every turn the
    /// account owner, a headless credential or the platform itself wrote.
    public static func parse(_ payload: JSONValue) -> SessionMessage? {
        parseCard(payload["sessionMessage"])
    }

    /// A card names the session that sent it: that is what makes it one, and a value without it is
    /// not drawn at all — never half a card. Every other field defaults, exactly as the web's reader
    /// defaults it.
    public static func parseCard(_ value: JSONValue?) -> SessionMessage? {
        guard case .object(let card)? = value,
              let from = card["fromSessionId"]?.stringValue, !from.isEmpty else { return nil }
        let task = card["fromTaskId"]?.stringValue
        return SessionMessage(fromSessionId: from,
                              fromTitle: card["fromTitle"]?.stringValue ?? "",
                              fromAgentName: card["fromAgentName"]?.stringValue ?? "",
                              fromTaskId: task?.isEmpty == false ? task : nil)
    }
}

/// What the card says, in the web's own words: `lib/sessionMessage.ts`, which
/// `SessionMessageCopyParityTests` holds this end to.
public enum SessionMessageCard {
    /// The word in front of the sending session's title, on the card's head and on the sticky bar.
    public static let from = "From"
    /// What a session with no title is called where its title would be.
    public static let untitled = "Untitled session"
    /// The foot line: who this is not.
    public static let notYou = "Sent by another Orbit session, not by you"
    public static let openTask = "Its task ↗"
    public static let undelivered = "The session has not confirmed it received this."

    /// The sending session as the card names it: its title, or what an untitled one is called.
    public static func title(_ card: SessionMessage) -> String {
        let title = card.fromTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? untitled : title
    }

    /// "Sent by another Orbit session, not by you · 2m ago".
    public static func meta(ts: String? = nil, now: Date = Date()) -> String {
        var line = notYou
        if let ts, let relative = RelativeTime.format(ts, now: now) { line += " · \(relative)" }
        return line
    }

    /// What the bar pinned to the top of a console says about this turn: who sent it, and what it
    /// said (web parity: the `data-sticky-label` / `data-sticky-text` the card's root carries). Not
    /// "Your question" — that above a card reading "not by you" is the screen contradicting itself.
    public static func sticky(_ card: SessionMessage, text: String) -> (label: String, text: String) {
        ("\(from) \(title(card))", text)
    }

    /// The session that sent the message, as the app's own `orbit-session:` door.
    public static func sessionLink(_ card: SessionMessage) -> URL? {
        link(card.fromSessionId, scheme: "orbit-session")
    }

    /// The task the sending session runs, as the app's own `orbit-task:` door.
    public static func taskLink(_ card: SessionMessage) -> URL? {
        link(card.fromTaskId, scheme: "orbit-task")
    }

    private static func link(_ id: String?, scheme: String) -> URL? {
        guard let id, PublicID.toUUID(id) != nil else { return nil }
        return URL(string: "\(scheme):\(id)")
    }
}
