import Foundation

// The owner's answer handed to the coordinator, as the control plane recorded it beside the turn's
// echo (`ownerAnswer`, apiserver `projects/project-open-item.ts` `readOwnerAnswerCard`).
//
// The turn's words are written for the AGENT — `From Orbit · owner answer: you asked "…"`, the
// question replayed in full and the answer with its ISO moment, or the Not yet… that sent back a
// request to record the project done — and they stay exactly that: a coordinator rotated in after the
// answer learns from them what was asked. Until the card existed they were all the record held, so
// this client drew the turn as the owner's own bubble: the question asked a second time, in the
// reader's name, under the card that already shows it answered.
//
// The web reads the same payload with `parseOwnerAnswer` (src/web/src/lib/ownerAnswer.ts) and draws
// it as `OwnerAnswerLine.tsx`. This is that rule for iOS and macOS: the same four fields make a card,
// and a payload that is not one parses as NOTHING rather than as half of one — which leaves every turn
// stored before this existed drawn exactly as it was. Neither end compiles the other, so
// `OwnerAnswerCopyParityTests` is what holds the two to each other. Nothing is read out of the words.

/// One answer's delivery to the coordinator, as the control plane recorded it.
///
/// Mirrors `@orbit/shared`'s `OwnerAnswerCard`.
public struct OwnerAnswer: Sendable, Equatable, Codable {
    /// What was answered: a coordinator's question, or its request to record the project done.
    public enum Kind: String, Sendable, Equatable, Codable, CaseIterable {
        case coordinatorQuestion = "COORDINATOR_QUESTION"
        case doneRequest = "DONE_REQUEST"
    }

    /// The item answered, in the uuid spelling every other read of one uses.
    public let itemId: String
    public let kind: Kind
    /// The conversation the answer was delivered to: the one the turn is on.
    public let sessionId: String
    /// When this conversation was handed the answer (ISO-8601) — its own delivery's moment, which for
    /// a coordinator rotated in after the answer is when IT was told.
    public let deliveredAt: String

    public init(itemId: String, kind: Kind, sessionId: String, deliveredAt: String) {
        self.itemId = itemId
        self.kind = kind
        self.sessionId = sessionId
        self.deliveredAt = deliveredAt
    }

    /// The card a `user` event's payload carries, or nil for the ordinary case: a turn that is nobody's
    /// answer (and every answer stored before the payload existed) keeps its old reading.
    public static func parse(_ payload: JSONValue) -> OwnerAnswer? {
        parseCard(payload["ownerAnswer"])
    }

    /// The same reading for the card itself rather than a payload that carries it: the queued-turn
    /// projection (`QueuedTurnInfo.ownerAnswer`) hands over the object the echo would have put under
    /// that key, and one function reads both, so the line drawn while the answer waits is the line its
    /// echo is drawn as. The item, what it was, the conversation and when it was told make a card; the
    /// moment has to read as one, since it is the only word on the line that is not the product's own.
    public static func parseCard(_ value: JSONValue?) -> OwnerAnswer? {
        guard case .object(let card)? = value,
              let itemId = nonEmptyString(card["itemId"]),
              let kind = card["kind"]?.stringValue.flatMap(Kind.init(rawValue:)),
              let sessionId = nonEmptyString(card["sessionId"]),
              let deliveredAt = nonEmptyString(card["deliveredAt"]),
              ThinkingSummary.date(deliveredAt) != nil else { return nil }
        return OwnerAnswer(itemId: itemId, kind: kind, sessionId: sessionId, deliveredAt: deliveredAt)
    }

    private static func nonEmptyString(_ value: JSONValue?) -> String? {
        guard let text = value?.stringValue, !text.isEmpty else { return nil }
        return text
    }
}

/// What the line says, in the web's own words (`OwnerAnswerLine.tsx`), which
/// `OwnerAnswerCopyParityTests` holds this end to.
public enum OwnerAnswerCard {
    /// The heading over the words the coordinator was handed, once the line is opened.
    public static let told = "What the coordinator was told"
    /// What the line says when the session has not confirmed it received the answer.
    public static let undelivered = "The session has not confirmed it received this."

    /// "Sent to the coordinator · 08:29": the line a version handed to its coordinator leaves, in the
    /// same words and on the same clock (`EvidenceDecisions.sentLine`), so one thing reads as one
    /// sentence wherever it is drawn.
    public static func line(_ card: OwnerAnswer, now: Date = Date()) -> String {
        EvidenceDecisions.sentLine(card.deliveredAt, now: now)
    }
}
