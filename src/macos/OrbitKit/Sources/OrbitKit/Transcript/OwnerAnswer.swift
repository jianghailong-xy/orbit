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

// THE QUESTION'S OWN CARD (docs/mocks/owner-answer-sent-card/merged.html). Where the conversation holds
// the record of the question an answer's turn hands over, the turn is that question's Answered card —
// drawn where the coordinator was told, which is where its next turn starts — and the conversation does
// not draw the record again at the moment it was answered. The owner reads "Answered" as "the agent has
// my answer", so a line under the card saying it was sent said the same thing twice. Web parity:
// `answeredItemKey` and `answersHandedOver` (lib/ownerAnswer.ts), `OwnerAnswerLine.tsx`.
extension OwnerAnswer {
    /// An answered item's key, in one spelling whichever the read it came from used: the open-items read
    /// and the turn's card each name the item, and a lookup between them must not depend on both having
    /// been served the same way.
    public static func itemKey(_ itemId: String) -> String {
        PublicID.storageKey(itemId)
    }

    /// The questions a turn of this conversation hands to its coordinator — echoed, accepted, or still on
    /// the queue — by item key (`itemKey`). Each such turn draws the question's own card, so
    /// `TranscriptRows.build` does not draw that card again at the moment the question was answered. A
    /// Not yet… to a request to record the project done has no card to be, and is left out.
    public static func handedOver(_ state: TranscriptState) -> Set<String> {
        Set(handovers(state).compactMap { $0.ownerAnswer.map { itemKey($0.itemId) } })
    }

    /// The turn that handed one question's answer to the coordinator — the newest, should there be more
    /// than one — whose words the question's card folds at the foot of its sheet. Nil where no turn of
    /// this conversation did.
    public static func handover(of itemId: String, in state: TranscriptState) -> UserBubble? {
        let key = itemKey(itemId)
        return handovers(state).last { $0.ownerAnswer.map { itemKey($0.itemId) } == key }
    }

    /// The ended question an answer's turn is drawn as: the record of the coordinator's question it
    /// answers, where the conversation holds one (`records`, by `itemKey`). Nil for a Not yet… to a
    /// request to record the project done, which has no card, and for a question the conversation cannot
    /// draw — both keep the line.
    public static func record(of card: OwnerAnswer,
                              in records: [String: ProjectClosedQuestion]) -> ProjectClosedQuestion? {
        card.kind == .coordinatorQuestion ? records[itemKey(card.itemId)] : nil
    }

    /// Every turn that hands a coordinator's question its answer, in the order the conversation draws
    /// them: the transcript's, the accepted head's, then the queued tail's — less what waits in the tray
    /// instead (`PendingTray.holds`), as `TranscriptRows.build` leaves it out.
    private static func handovers(_ state: TranscriptState) -> [UserBubble] {
        func hands(_ b: UserBubble) -> Bool { b.ownerAnswer?.kind == .coordinatorQuestion }
        var turns: [UserBubble] = []
        for case .user(let b) in state.items where hands(b) { turns.append(b) }
        turns += state.accepted.filter(hands)
        turns += state.queued.filter { hands($0) && !PendingTray.holds($0) }
        return turns
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
