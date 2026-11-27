import Foundation

// A message sent from here that the server has not taken yet waits as its own bubble: dimmed, with
// `Sending…` in its foot row, until the POST's answer or its durable echo says the server has it
// (docs/mocks/composer-sending-bubble, board 04-native-parity; web parity: `.chat-sending` and
// `UserBubble`'s `Sending…` in Transcript.tsx). Then it is the ordinary bubble, the same row.

extension UserBubble {
    /// The foot row's words while the bubble waits.
    public static let sendingLabel = "Sending…"
    /// How strongly the waiting bubble is drawn (web `.chat-sending`).
    public static let sendingOpacity = 0.62

    /// Sent from here with neither the POST's answer (`turnId`) nor an echo yet.
    public var isSending: Bool { pending && turnId == nil && !undelivered }
}

extension TranscriptState {
    /// The transcript ends on a message the server has not taken: no turn has opened for it, so
    /// nothing under it says one is working.
    public var tailIsSending: Bool {
        if case .user(let bubble)? = items.last { return bubble.isSending }
        return false
    }
}
