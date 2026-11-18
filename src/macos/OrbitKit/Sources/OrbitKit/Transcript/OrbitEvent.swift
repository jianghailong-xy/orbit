import Foundation

/// A turn Orbit opened whose note is a block no dedicated line knows, drawn as one generic line in the
/// agent's stream rather than as the reader's bubble (owner rule 2026-11-16: the right side of a
/// conversation is only for words the person typed). Before this, such a turn fell through to an empty
/// bubble on the reader's side carrying only "Orbit attached: context" and the raw block — which is how
/// a SubAgent's end first reached the owner.
///
/// Web parity: `OrbitEventLine.tsx` and `Transcript.tsx`'s `orbitOnlyTurn`, whose words
/// `OrbitEventCopyParityTests` holds these to.
public enum OrbitEvent {
    /// The line's title.
    public static let title = "From Orbit"
    /// Its mark: neutral, Orbit's own, neither a success nor a failure.
    public static let mark = "⊕"
    /// What its fold opens on.
    public static let details = "Details"
    /// The raw blocks, under this name in the fold.
    public static let whatTheAgentRead = "What the agent read"
    /// The name the line gives a note describeNote names nothing in.
    public static let unnamed = "context"

    /// What the line names after its title: the blocks as `describeNote` names them, `context` when it
    /// names none.
    public static func name(_ note: String) -> String {
        let named = describeNote(note)
        return named.isEmpty ? unnamed : named
    }

    /// Whether a delivered turn is Orbit's alone: nothing typed, nothing attached, and a recorded note.
    /// The dedicated lines (a watch's wake, a job's news, a SubAgent's end, the control plane's cards)
    /// are asked first; this is what is left of a turn that would otherwise draw as the reader's bubble.
    public static func draws(text: String, note: String?, hasAttachments: Bool = false) -> Bool {
        guard let note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !hasAttachments && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The same, for a transcript's bubble.
    public static func draws(_ bubble: UserBubble) -> Bool {
        draws(text: bubble.text, note: bubble.note, hasAttachments: !bubble.attachments.isEmpty)
    }
}
