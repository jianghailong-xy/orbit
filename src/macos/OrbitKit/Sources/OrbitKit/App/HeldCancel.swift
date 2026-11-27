import Foundation

/// Cancel beside `Queued · runner full` (or `· runner updating`) under a message the server accepted
/// but no runner has taken yet. A message queued behind another already offers Cancel; this one sat
/// under the held tag with no way out. The press withdraws the turn through the same door
/// (`DELETE …/turns/:turnId`), which puts the session back to awaiting input, and its words go back
/// to the composer. Web parity: `cancellableHeldTurn` and `HeldFoot` (WorkspaceView.tsx).
public enum HeldCancel {
    public static let label = "Cancel"
    /// What a refused press says: a runner took the message first (web parity: the same notice).
    public static let refused = "This message is already being processed and cannot be withdrawn"

    /// Whether the message under the held tag can still be taken back: accepted — pending, neither
    /// queued nor a steer, with no runner's echo yet — with the server's turn id the DELETE keys on,
    /// and not the session's opening prompt, which the server keeps.
    public static func offers(_ bubble: UserBubble) -> Bool {
        bubble.pending && !bubble.queued && !bubble.steer && !bubble.undelivered && !bubble.receipt
            && bubble.turnId != nil && !bubble.opening
    }

    /// How a press came out.
    public enum Outcome: Equatable, Sendable {
        /// The server withdrew it; `words` go back to the composer (nil for a turn nobody typed).
        case withdrawn(words: String?)
        /// The server refused it: a runner has it, and it stays where it is.
        case refused
    }

    /// The press: asks the server to withdraw the turn, and on its yes hands back what the composer
    /// gets — the words the reader wrote, not the English a translated message delivered
    /// (`ComposerLogic.withdrawnText`). Nothing leaves the screen until the server answers.
    public static func press(_ bubble: UserBubble,
                             withdraw: (_ turnId: String) async throws -> Void) async -> Outcome {
        guard offers(bubble), let turnId = bubble.turnId else { return .refused }
        do {
            try await withdraw(turnId)
        } catch {
            return .refused
        }
        return .withdrawn(words: ComposerLogic.withdrawnText(of: bubble))
    }

    /// The composer once the words are back: under whatever is being typed there, an explicit press
    /// keeping a draft in its place, as the queued Cancel does.
    public static func composer(_ draft: String, restoring words: String?) -> String {
        guard let words else { return draft }
        return draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? words : draft + "\n\n" + words
    }
}
