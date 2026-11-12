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
    /// The sending session's stored mode (`from-mode` in the block); nil on an event stored before the
    /// card carried it. Nothing draws it yet, here or on the web.
    public let fromMode: String?
    /// The sender runs narrower than the session it wrote to, by the server's own comparison; nil when
    /// it does not.
    public let fromModeNarrower: Bool?
    /// The request this message is, when its sender asked for a reply (`expectReply`) — the
    /// request's public id; nil on every message that asked for none. Its state is not here: the
    /// card reads it live (`SessionRequestView`), because the stored event never changes and the
    /// state does.
    public let requestId: String?

    public init(fromSessionId: String, fromTitle: String = "", fromAgentName: String = "",
                fromTaskId: String? = nil, fromMode: String? = nil, fromModeNarrower: Bool? = nil,
                requestId: String? = nil) {
        self.fromSessionId = fromSessionId
        self.fromTitle = fromTitle
        self.fromAgentName = fromAgentName
        self.fromTaskId = fromTaskId
        self.fromMode = fromMode
        self.fromModeNarrower = fromModeNarrower
        self.requestId = requestId
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
        let mode = card["fromMode"]?.stringValue
        let request = card["requestId"]?.stringValue
        return SessionMessage(fromSessionId: from,
                              fromTitle: card["fromTitle"]?.stringValue ?? "",
                              fromAgentName: card["fromAgentName"]?.stringValue ?? "",
                              fromTaskId: task?.isEmpty == false ? task : nil,
                              fromMode: mode?.isEmpty == false ? mode : nil,
                              fromModeNarrower: card["fromModeNarrower"]?.boolValue == true ? true : nil,
                              requestId: request?.isEmpty == false ? request : nil)
    }
}

/// Who sent the message a session row previews (`Session.lastUserText`), when another Orbit session
/// did — `session_send`, `project_send` or `session_interrupt` (docs/session-list-projects-design.md
/// §3.5). Mirrors `@orbit/shared`'s `SessionMessageFrom`: the same two facts the card names its sender
/// by, as they stood when the message was written. The rows carry it as `lastUserFrom`, nil when the
/// account owner wrote the message. Both fields default, as the card's do, so a value this build reads
/// only in part still says that someone other than the owner sent it.
public struct SessionMessageFrom: Sendable, Equatable, Codable {
    /// The sending session, in the uuid spelling every other read of one uses.
    public let sessionId: String
    public let title: String

    public init(sessionId: String, title: String = "") {
        self.sessionId = sessionId
        self.title = title
    }

    private enum CodingKeys: String, CodingKey { case sessionId, title }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? values.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        title = (try? values.decodeIfPresent(String.self, forKey: .title)) ?? ""
    }
}

/// That the message a session row previews (`Session.lastUserText`) is Orbit's own: a turn the control
/// plane wrote itself — a fact told to a coordinator, the answer to a criteria proposal, a watch's wake,
/// the owner's answer handed on, a task run's brief (docs/session-list-projects-design.md §3.5, owner
/// 2026-11-07). Mirrors `@orbit/shared`'s `OrbitMessageFrom`. The rows carry it as `lastUserFromOrbit`,
/// nil for anybody else's words, and the row says `Orbit: …` (`SessionLine.orbitLine`).
public struct OrbitMessageFrom: Sendable, Equatable, Codable {
    /// The card the conversation draws a coordinator's notification as, read by the conversation's own
    /// rule (`CoordinatorDelivery.parseCard`): the row says that line's sentence. Nil for every other
    /// message of Orbit's — and for a card this build cannot read — whose row says its first line.
    public let coordinatorDelivery: CoordinatorDelivery?

    public init(coordinatorDelivery: CoordinatorDelivery? = nil) {
        self.coordinatorDelivery = coordinatorDelivery
    }

    private enum CodingKeys: String, CodingKey { case coordinatorDelivery }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        coordinatorDelivery = CoordinatorDelivery.parseCard(try? values.decodeIfPresent(JSONValue.self, forKey: .coordinatorDelivery))
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

    /// A long message folds by its rendered height, not its length (docs/mocks/session-message-clamp,
    /// approved 2026-11-11): taller than `clampFrom` lines, it shows its first `clampLines` and
    /// `showMore`; opened, the whole text and `showLess`. Web: `SessionMessageCard.tsx`'s
    /// `SESSION_MESSAGE_CLAMP_*` and `SESSION_MESSAGE_SHOW_*`.
    public static let clampLines = 8
    public static let clampFrom = 12
    public static let showMore = "Show more"
    public static let showLess = "Show less"

    /// Whether a body `height` tall, at `lineHeight` per line, is long enough to fold. Nothing
    /// measured yet (a zero line height) folds nothing.
    public static func folds(height: Double, lineHeight: Double) -> Bool {
        lineHeight > 0 && height > lineHeight * Double(clampFrom)
    }

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

    /// The card's line for a sender that runs narrower than this session, each mode as the mode
    /// picker names it (web `sessionMessageNarrower`; board session-message-attached-line ③).
    public static func narrower(from: String, to: String) -> String {
        "Sender runs in \(modeLabel(from)), narrower than this session's \(modeLabel(to)): not taken as your approval"
    }

    /// A session message's recorded note without its own block, which only tells the agent what the
    /// card already shows (owner, 2026-11-12; web `splitSessionMessageNote`). `attached` is whatever
    /// else delivery appended, still folded under the card — nil when nothing else rode along — and
    /// `narrower` the card's line when the block says the sender runs narrower than this session.
    public static func splitNote(_ note: String?) -> (attached: (kind: String, text: String)?, narrower: String?) {
        guard let note else { return (nil, nil) }
        let range = NSRange(note.startIndex..., in: note)
        let blocks = blockPattern.matches(in: note, range: range).compactMap { Range($0.range, in: note).map { String(note[$0]) } }
        let narrower = blocks.lazy.compactMap { block -> String? in
            guard let m = narrowerPattern.firstMatch(in: block, range: NSRange(block.startIndex..., in: block)),
                  let from = Range(m.range(at: 1), in: block), let to = Range(m.range(at: 2), in: block) else { return nil }
            return Self.narrower(from: String(block[from]), to: String(block[to]))
        }.first
        let rest = blockPattern.stringByReplacingMatches(in: note, range: range, withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = rest.isEmpty ? "" : describeNote(rest)
        return (kind.isEmpty ? nil : (kind, rest), narrower)
    }

    /// The block delivery appends after another session's message (apiserver `sessionMessageBlock`).
    private static let blockPattern = try! NSRegularExpression(pattern: "<orbit-session-message\\b[^>]*>[\\s\\S]*?</orbit-session-message>")
    /// The block's sentence for a sender that may do less than this session (apiserver `narrowerSenderNote`).
    private static let narrowerPattern = try! NSRegularExpression(pattern: "The sender runs in (\\S+), which is narrower than this session's (\\S+)\\.")

    private static func modeLabel(_ mode: String) -> String {
        PermissionMode(rawValue: mode).map(AgentDefaults.label) ?? mode
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
