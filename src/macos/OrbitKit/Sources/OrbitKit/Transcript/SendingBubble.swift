import Foundation

// A message sent from here that the server has not taken yet waits as its own bubble: dimmed, with
// `Sending…` in its foot row, until the POST's answer or its durable echo says the server has it
// (docs/mocks/composer-sending-bubble, board 04-native-parity; web parity: `.chat-sending` and
// `UserBubble`'s `Sending…` in Transcript.tsx). Then it is the ordinary bubble, the same row.
//
// A send the server refused, or did not answer within `answerTimeout`, keeps its bubble too: at
// full strength, its foot reading `⚠ Not sent · Retry · Put back in the composer`, with the reason beside
// it (web parity: `markNotSent` in pendingSend.ts and `UserBubble`'s not-sent foot).

extension UserBubble {
    /// The foot row's words while the bubble waits.
    public static let sendingLabel = "Sending…"
    /// How strongly the waiting bubble is drawn (web `.chat-sending`).
    public static let sendingOpacity = 0.62

    /// The foot row's words once the send did not get through, and its two ways on (web copy).
    public static let notSentLabel = "⚠ Not sent"
    public static let retryLabel = "Retry"
    public static let putBackLabel = "Put back in the composer"

    /// How long a send waits for the server's answer before its request is ended and its bubble says
    /// `Not sent` (web `SEND_ANSWER_TIMEOUT_MS`). Same-key replays of a dropped connection run inside it.
    public static let answerTimeout: TimeInterval = 20
    /// Why, when the answer did not come in time (web `SendNotAnsweredError`).
    public static let notAnsweredReason =
        "The server didn't answer in 20 seconds. Retry sends the same message again; it can't arrive twice."

    /// Sent from here with neither the POST's answer (`turnId`) nor an echo yet: on its way, or `Not sent`.
    public var isUntaken: Bool { pending && turnId == nil && !undelivered }
    /// On its way: `Sending…`.
    public var isSending: Bool { isUntaken && notSentReason == nil }
    /// Refused, or unanswered in time: `Not sent`, with Retry and Put back.
    public var isNotSent: Bool { isUntaken && notSentReason != nil }
    /// How strongly the message is drawn: dimmed only while it is on its way; `Not sent` is at full strength.
    public var strength: Double { isSending ? Self.sendingOpacity : 1 }
}

extension TranscriptState {
    /// The transcript ends on a message the server has not taken: no turn has opened for it, so
    /// nothing under it says one is working.
    public var tailIsSending: Bool {
        if case .user(let bubble)? = items.last { return bubble.isUntaken }
        return false
    }
}
