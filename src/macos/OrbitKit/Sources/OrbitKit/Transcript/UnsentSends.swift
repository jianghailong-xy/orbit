import Foundation

/// A message sent from here that the server has not taken: on its way, or `Not sent`. Kept on disk so
/// it survives an app restart, and on launch drawn again as a `Not sent` bubble with Retry and Put
/// back — never sent again by itself: the person may have moved on, and the same `clientTurnId` makes
/// their own Retry safe (docs/mocks/composer-sending-bubble, board 04-native-parity, decision 2).
public struct UnsentSend: Codable, Equatable, Sendable {
    /// The send's key: every attempt of it, Retry's included, carries this one.
    public let clientTurnId: String
    public let sessionID: String
    /// The words as sent (a `!cmd` without its `!`), which the bubble draws and an echo is matched by.
    public var text: String
    /// What Put back returns to the composer: the words as typed, a `!cmd` with its `!`.
    public var draft: String
    public var shell: Bool
    /// The uploads it carries, by server id; Put back returns them to the composer as chips.
    public var attachments: [TurnAttachment]
    /// Why it is `Not sent`; nil while it is still on its way.
    public var reason: String?
    /// The transcript's newest seq when it was sent: its echo is a `user` event after it.
    public var afterSeq: Int
    /// Sent by "stop and send this instead": Retry goes back through the interrupt, which stops the
    /// turn and queues the message in one request. Nil for an ordinary send.
    public var stopsTurn: Bool?

    public init(clientTurnId: String, sessionID: String, text: String, draft: String, shell: Bool = false,
                attachments: [TurnAttachment] = [], reason: String? = nil, afterSeq: Int = 0,
                stopsTurn: Bool? = nil) {
        self.clientTurnId = clientTurnId
        self.sessionID = sessionID
        self.text = text
        self.draft = draft
        self.shell = shell
        self.attachments = attachments
        self.reason = reason
        self.afterSeq = afterSeq
        self.stopsTurn = stopsTurn
    }

    /// Why a message still on its way when the app closed reads `Not sent` when it opens again.
    public static let closedBeforeAnswerReason =
        "The app closed before the server answered. Retry sends the same message again; it can't arrive twice."

    /// Whether `bubble` is this message's echo: the server took it after all. Its words (or, for
    /// pictures and files alone, the same uploads), on a message opened after this one was sent.
    public func isEchoed(by bubble: UserBubble) -> Bool {
        guard !bubble.pending, bubble.clientTurnId == nil || bubble.clientTurnId == clientTurnId else { return false }
        if bubble.clientTurnId == clientTurnId { return true }
        guard (bubble.opensTurn?.seq ?? 0) > afterSeq else { return false }
        if text.isEmpty {
            return bubble.text.isEmpty && !attachments.isEmpty
                && bubble.attachments.map { PublicID.storageKey($0.id) } == attachments.map { PublicID.storageKey($0.id) }
        }
        return bubble.text == text || bubble.translation?.original == text
    }
}

extension TranscriptState {
    /// Whether the transcript already holds `send`'s echo (`UnsentSend.isEchoed`).
    public func holdsEcho(of send: UnsentSend) -> Bool {
        items.contains { item in
            if case .user(let b) = item { return send.isEchoed(by: b) }
            return false
        }
    }
}

/// Where unsent messages are kept between launches. A protocol so a console can be tested against
/// one in memory.
public protocol UnsentSendStoring: AnyObject {
    func load() -> [UnsentSend]
    func save(_ sends: [UnsentSend])
}

extension UnsentSendStoring {
    /// One session's unsent messages, oldest first.
    public func sends(in sessionID: String) -> [UnsentSend] {
        load().filter { $0.sessionID == sessionID }
    }

    /// Replace one session's unsent messages with `sends`, leaving every other session's as they are.
    public func replace(in sessionID: String, with sends: [UnsentSend]) {
        save(load().filter { $0.sessionID != sessionID } + sends)
    }
}

/// The unsent messages in UserDefaults, one key per server.
public final class UnsentSendDefaultsStore: UnsentSendStoring {
    private let defaults: UserDefaults
    private let key: String

    public init(baseURL: URL, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.key = "composer.unsentSends.\(baseURL.absoluteString)"
    }

    public func load() -> [UnsentSend] {
        guard let data = defaults.data(forKey: key),
              let sends = try? JSONDecoder().decode([UnsentSend].self, from: data) else { return [] }
        return sends
    }

    public func save(_ sends: [UnsentSend]) {
        if sends.isEmpty {
            defaults.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(sends) {
            defaults.set(data, forKey: key)
        }
    }
}

/// Unsent messages held in memory only: a console with nothing to keep (tests, previews).
public final class UnsentSendMemoryStore: UnsentSendStoring {
    private var sends: [UnsentSend]
    public init(_ sends: [UnsentSend] = []) { self.sends = sends }
    public func load() -> [UnsentSend] { sends }
    public func save(_ sends: [UnsentSend]) { self.sends = sends }
}
