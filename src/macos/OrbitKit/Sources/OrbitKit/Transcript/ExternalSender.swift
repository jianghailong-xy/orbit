import Foundation

// Somebody outside Orbit who sent a turn: a member of a connected Feishu group whose words the bot
// handed to one of the owner's sessions (docs/feishu-bot-design.md §8.2). The control plane records it
// from the event Feishu delivered — on the `user` event's payload (`externalSender`) and on the session
// row beside `lastUserText` (`lastUserFromExternal`) — and a client draws it as `From Feishu · <name>`:
// over the words in the conversation, and in front of them on the row, where "You:" would put a group
// member's request in the owner's mouth. The web reads the same fields with `parseExternalSender`
// (src/web/src/lib/externalSender.ts); `ExternalSenderParityTests` holds the two ends' words together.

/// Who outside Orbit sent a turn. Mirrors `@orbit/shared`'s `ExternalMessageFrom`.
public struct ExternalMessageFrom: Sendable, Equatable, Codable {
    /// Where the sender is: `FEISHU`, the one source there is so far.
    public let source: String
    /// The sender's name as Feishu gave it when the turn was written; nil when Feishu would not say.
    public let name: String?

    public init(source: String = ExternalSender.feishuSource, name: String?) {
        self.source = source
        self.name = name
    }

    private enum CodingKeys: String, CodingKey { case source, name }

    /// Decodes only a sender this build knows (`ExternalSender.parse`'s rule), so a row from a newer
    /// control plane with another source reads as no sender rather than failing the list.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let source = try c.decode(String.self, forKey: .source)
        guard source == ExternalSender.feishuSource else {
            throw DecodingError.dataCorruptedError(forKey: .source, in: c, debugDescription: "unknown source \(source)")
        }
        self.source = source
        self.name = ExternalSender.trimmedName(try? c.decodeIfPresent(String.self, forKey: .name))
    }
}

/// What the sender line says, in the web's own words (`lib/externalSender.ts`).
public enum ExternalSender {
    public static let feishuSource = "FEISHU"
    /// `EXTERNAL_SENDER_FROM_FEISHU`.
    public static let fromFeishu = "From Feishu"
    /// `EXTERNAL_SENDER_NAME_SEPARATOR`.
    public static let nameSeparator = " · "

    /// The sender a payload or a row carries, or nil. Anything that is not one — absent, from an older
    /// server, or of a source this build does not know — reads as nil, so the turn keeps the reading it
    /// has always had (web `parseExternalSender`).
    public static func parse(_ value: JSONValue?) -> ExternalMessageFrom? {
        guard case .object(let from)? = value, from["source"]?.stringValue == feishuSource else { return nil }
        return ExternalMessageFrom(name: trimmedName(from["name"]?.stringValue))
    }

    /// `From Feishu · <name>`, or `From Feishu` when Feishu would not say the name (web
    /// `externalSenderLabel`).
    public static func label(_ from: ExternalMessageFrom) -> String {
        guard let name = from.name else { return fromFeishu }
        return "\(fromFeishu)\(nameSeparator)\(name)"
    }

    static func trimmedName(_ raw: String?) -> String? {
        guard let name = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }
}
