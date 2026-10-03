import Foundation

// One Orbit session asking another for a reply (docs/session-request-reply-contract.md §6), as the
// native cards draw it — the rules of `src/web/src/lib/sessionRequest.ts`, for
// iOS and macOS.
//
// The RECIPIENT's card is the "From [session]" card its message arrived as, with the request it is
// (`SessionMessage.requestId`) read live as a `SessionRequestView`: the stored event never changes,
// and the request's state does. The ASKER's card is the turn the outcome came back as
// (`sessionReplies`, `SessionReply.parse`), a snapshot — an outcome is written once. Both are
// read-only: the account owner does not answer on the recipient's behalf. Every word is the web's,
// which `SessionRequestCopyParityTests` holds this end to.

/// The five outcomes a request comes to, each written once. Mirrors `@orbit/shared`'s
/// `SessionRequestOutcome`.
public enum SessionRequestOutcome: String, Codable, Sendable, CaseIterable {
    case replied = "REPLIED"
    case noReply = "NO_REPLY"
    case recipientEnded = "RECIPIENT_ENDED"
    case expired = "EXPIRED"
    case undelivered = "UNDELIVERED"
}

/// Where a request stands: waiting, or which outcome it came to.
public enum SessionRequestState: Sendable, Equatable {
    case open
    case closed(SessionRequestOutcome)

    public init?(raw: String) {
        if raw == "OPEN" { self = .open; return }
        guard let outcome = SessionRequestOutcome(rawValue: raw) else { return nil }
        self = .closed(outcome)
    }

    public var raw: String {
        switch self {
        case .open: return "OPEN"
        case .closed(let outcome): return outcome.rawValue
        }
    }
}

/// One answer the asker offered: `ask_owner`'s option shape.
public struct SessionReplyOption: Codable, Equatable, Sendable {
    public let label: String
    public let description: String?
}

/// A request as it stands now: `GET /session-requests/:id`. Mirrors `@orbit/shared`'s
/// `SessionRequestView`.
public struct SessionRequestView: Decodable, Equatable, Sendable {
    public let requestId: String
    /// OPEN, or one of the five outcomes; an unknown spelling from a newer server reads as nil.
    public let state: SessionRequestState?
    public let fromSessionId: String
    public let fromTitle: String
    public let toSessionId: String
    public let toTitle: String
    public let requestPreview: String
    public let replyOptions: [SessionReplyOption]?
    public let replyBy: String
    public let createdAt: String?
    public let closedAt: String?
    public let replyText: String?
    public let replyOption: Int?
    public let excerpt: String?
    public let closeReason: String?

    private enum CodingKeys: String, CodingKey {
        case requestId, state, fromSessionId, fromTitle, toSessionId, toTitle, requestPreview
        case replyOptions, replyBy, createdAt, closedAt, replyText, replyOption, excerpt, closeReason
    }

    public init(requestId: String, state: SessionRequestState?, fromSessionId: String = "",
                fromTitle: String = "", toSessionId: String = "", toTitle: String = "",
                requestPreview: String = "", replyOptions: [SessionReplyOption]? = nil,
                replyBy: String, createdAt: String? = nil, closedAt: String? = nil,
                replyText: String? = nil, replyOption: Int? = nil, excerpt: String? = nil,
                closeReason: String? = nil) {
        self.requestId = requestId
        self.state = state
        self.fromSessionId = fromSessionId
        self.fromTitle = fromTitle
        self.toSessionId = toSessionId
        self.toTitle = toTitle
        self.requestPreview = requestPreview
        self.replyOptions = replyOptions
        self.replyBy = replyBy
        self.createdAt = createdAt
        self.closedAt = closedAt
        self.replyText = replyText
        self.replyOption = replyOption
        self.excerpt = excerpt
        self.closeReason = closeReason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        state = SessionRequestState(raw: try c.decode(String.self, forKey: .state))
        fromSessionId = try c.decodeIfPresent(String.self, forKey: .fromSessionId) ?? ""
        fromTitle = try c.decodeIfPresent(String.self, forKey: .fromTitle) ?? ""
        toSessionId = try c.decodeIfPresent(String.self, forKey: .toSessionId) ?? ""
        toTitle = try c.decodeIfPresent(String.self, forKey: .toTitle) ?? ""
        requestPreview = try c.decodeIfPresent(String.self, forKey: .requestPreview) ?? ""
        replyOptions = try? c.decodeIfPresent([SessionReplyOption].self, forKey: .replyOptions)
        replyBy = try c.decode(String.self, forKey: .replyBy)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        closedAt = try c.decodeIfPresent(String.self, forKey: .closedAt)
        replyText = try c.decodeIfPresent(String.self, forKey: .replyText)
        replyOption = try c.decodeIfPresent(Int.self, forKey: .replyOption)
        excerpt = try c.decodeIfPresent(String.self, forKey: .excerpt)
        closeReason = try c.decodeIfPresent(String.self, forKey: .closeReason)
    }
}

/// One outcome a turn of the ASKING session handed back, as the control plane recorded it beside the
/// echo. Mirrors `@orbit/shared`'s `SessionReplyCard`, field for field and in the same order
/// (`SessionRequestCopyParityTests` holds the two to it).
public struct SessionReply: Codable, Equatable, Sendable {
    /// The request's public id.
    public let requestId: String
    public let outcome: SessionRequestOutcome
    /// The session that was asked: where the request is, and who answered.
    public let fromSessionId: String
    public let fromTitle: String
    /// The turn the request arrived as in that session's transcript.
    public let requestTurnId: String?
    public let requestPreview: String
    public let replyText: String?
    public let replyOption: Int?
    public let replyOptionLabel: String?
    public let excerpt: String?
    public let closeReason: String?
    public let closedAt: String?

    public init(requestId: String, outcome: SessionRequestOutcome, fromSessionId: String,
                fromTitle: String = "", requestTurnId: String? = nil, requestPreview: String = "",
                replyText: String? = nil, replyOption: Int? = nil, replyOptionLabel: String? = nil,
                excerpt: String? = nil, closeReason: String? = nil, closedAt: String? = nil) {
        self.requestId = requestId
        self.outcome = outcome
        self.fromSessionId = fromSessionId
        self.fromTitle = fromTitle
        self.requestTurnId = requestTurnId
        self.requestPreview = requestPreview
        self.replyText = replyText
        self.replyOption = replyOption
        self.replyOptionLabel = replyOptionLabel
        self.excerpt = excerpt
        self.closeReason = closeReason
        self.closedAt = closedAt
    }

    /// The outcomes a `user` event's payload carries (`sessionReplies`), or nil for every other turn
    /// — and for every one stored before the field existed, which keeps the reading it always had.
    /// A card that does not name a request, a known outcome and the session asked is dropped, never
    /// drawn half — the web's `parseSessionReplies` rule.
    public static func parse(_ payload: JSONValue) -> [SessionReply]? {
        guard case .array(let raw)? = payload["sessionReplies"] else { return nil }
        let cards = raw.compactMap(parseCard)
        return cards.isEmpty ? nil : cards
    }

    /// A recorded note without the `<orbit-session-reply>` blocks in it: what is left for the folded
    /// "Orbit attached" entry once the reply cards have drawn those — the web's `withoutReplyBlocks`.
    public static func withoutReplyBlocks(_ note: String?) -> String {
        guard let note else { return "" }
        guard let blocks = try? NSRegularExpression(
            pattern: "<orbit-session-reply[\\s>][\\s\\S]*?\\n</orbit-session-reply>") else { return note }
        let stripped = blocks.stringByReplacingMatches(
            in: note, range: NSRange(note.startIndex..., in: note), withTemplate: "")
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func parseCard(_ value: JSONValue) -> SessionReply? {
        guard case .object(let card) = value,
              let requestId = card["requestId"]?.stringValue, !requestId.isEmpty,
              let outcome = card["outcome"]?.stringValue.flatMap(SessionRequestOutcome.init(rawValue:)),
              let from = card["fromSessionId"]?.stringValue, !from.isEmpty else { return nil }
        func text(_ key: String) -> String? {
            guard let value = card[key]?.stringValue, !value.isEmpty else { return nil }
            return value
        }
        var option: Int?
        switch card["replyOption"] {
        case .int(let n)?: option = n
        case .double(let d)?: option = Int(d)
        default: option = nil
        }
        return SessionReply(requestId: requestId, outcome: outcome, fromSessionId: from,
                            fromTitle: card["fromTitle"]?.stringValue ?? "",
                            requestTurnId: text("requestTurnId"),
                            requestPreview: card["requestPreview"]?.stringValue ?? "",
                            replyText: text("replyText"), replyOption: option,
                            replyOptionLabel: text("replyOptionLabel"), excerpt: text("excerpt"),
                            closeReason: text("closeReason"), closedAt: text("closedAt"))
    }
}

/// One open request on a session: the other session, and the request.
public struct SessionRequestPeer: Codable, Equatable, Sendable {
    public let requestId: String
    public let sessionId: String
    public let title: String

    public init(requestId: String, sessionId: String, title: String) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.title = title
    }
}

/// What the cards say, in the web's own words: `lib/sessionRequest.ts`, which
/// `SessionRequestCopyParityTests` holds this end to.
public enum SessionRequestCopy {
    /// The recipient's card: the line saying this message is a request.
    public static let asks = "Asked for a reply"
    /// Before the deadline, on the same line.
    public static let due = "due"
    /// The asker's card: whose reply this is.
    public static let replyFrom = "Reply from"
    public static let youAsked = "You asked"
    public static let lastWords = "Its last words, not a reply"
    public static let chose = "Chose"
    public static let openRequest = "Open the request ↗"
    public static let notYou = "Handed back by Orbit, not typed by you"
    public static let neverSeen = "The session never saw the request."

    /// What each state is called on the recipient's card.
    public static func stateLabel(_ state: SessionRequestState) -> String {
        switch state {
        case .open: return "Waiting for a reply"
        case .closed(.replied): return "Replied"
        case .closed(.noReply): return "Closed: went idle without replying"
        case .closed(.recipientEnded): return "Closed: this session ended"
        case .closed(.expired): return "Closed: the deadline passed"
        case .closed(.undelivered): return "Closed: never delivered"
        }
    }

    /// What each outcome is called on the asker's card.
    public static func outcomeLabel(_ outcome: SessionRequestOutcome) -> String {
        switch outcome {
        case .replied: return "Replied"
        case .noReply: return "No reply"
        case .recipientEnded: return "Session ended"
        case .expired: return "Expired"
        case .undelivered: return "Not delivered"
        }
    }

    /// The asked session as a card names it: its title, or what an untitled one is called.
    public static func title(_ reply: SessionReply) -> String {
        let title = reply.fromTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? SessionMessageCard.untitled : title
    }

    /// "Asked for a reply · due 18:00" while it waits; the deadline goes once it has an outcome.
    public static func statusLine(_ view: SessionRequestView?, now: Date = Date(),
                                  calendar: Calendar = .current) -> String {
        guard let view, view.state == .open, let due = formatReplyBy(view.replyBy, now: now, calendar: calendar) else {
            return asks
        }
        return "\(asks) · \(Self.due) \(due)"
    }

    /// The deadline as a card says it: the time today, otherwise the day and the time.
    public static func formatReplyBy(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let at = RelativeTime.parse(iso) else { return nil }
        let time = DateFormatter()
        time.calendar = calendar
        time.timeZone = calendar.timeZone
        time.dateFormat = "HH:mm"
        if calendar.isDate(at, inSameDayAs: now) { return time.string(from: at) }
        let day = DateFormatter()
        day.calendar = calendar
        day.timeZone = calendar.timeZone
        day.dateFormat = "MMM d"
        return "\(day.string(from: at)), \(time.string(from: at))"
    }

    /// The asked session, as the app's own `orbit-session:` door.
    public static func sessionLink(_ reply: SessionReply) -> URL? {
        guard PublicID.toUUID(reply.fromSessionId) != nil else { return nil }
        return URL(string: "orbit-session:\(reply.fromSessionId)")
    }

    /// The original request, where it sits in the asked session's transcript — that session opened
    /// at the request's own turn (`SessionRecordLink`), or at its latest message when the card names
    /// no turn.
    public static func requestLink(_ reply: SessionReply) -> URL? {
        guard let session = PublicID.toUUID(reply.fromSessionId) else { return nil }
        if let turn = reply.requestTurnId, PublicID.toUUID(turn) != nil {
            return SessionRecordLink.url(session: session, record: turn)
        }
        return sessionLink(reply)
    }
}
