import SwiftUI
import OrbitKit

/// Another Orbit session's message, drawn as "From [that session]" — instead of the account owner's
/// own bubble.
///
/// `session_send` and `project_send` write a turn into this conversation that the owner did not type.
/// The words are the sending agent's and are drawn as they were sent; what the card adds is who sent
/// them — the session's title, which opens it, the agent it runs as, and the task it runs — from the
/// payload the control plane recorded beside the echo (OrbitKit's `SessionMessage`, read out of
/// `sessionMessage`). The block delivery appended to tell the recipient the same thing rides inside,
/// folded, with anything else delivery appended.
///
/// One view for both native clients: `src/ios/project.yml` compiles this folder in place. Web parity:
/// `SessionMessageCard.tsx`, with every word from OrbitKit's `SessionMessageCard`, which
/// `SessionMessageCopyParityTests` holds to the web's.
struct SessionMessageCardView: View {
    let card: SessionMessage
    /// The sending agent's words, as the recipient was handed them.
    let text: String
    var ts: String?
    var undelivered: Bool = false
    /// What delivery appended to the same turn (a `controlPlaneNote`), as its own folded entry.
    var attached: (kind: String, text: String)?

    @Environment(\.openURL) private var openURL
    @State private var expanded = false
    /// Collapse a giant message past this many characters, as the owner's own bubble does: one huge
    /// Text lays out synchronously and stalls the console.
    private let truncateAt = 6000

    var body: some View {
        let long = text.count > truncateAt
        let shown = long && !expanded ? String(text.prefix(truncateAt)) : text
        VStack(alignment: .leading, spacing: 6) {
            head
            if !shown.isEmpty {
                MarkdownView(source: shown, base: .body, ink: .primary)
                    .font(.orbitProse)
                    .textSelection(.enabled)
            }
            if long {
                Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
            foot
            if let requestId = card.requestId {
                // The message asks for a reply: what it asks, by when, and where it stands — read live.
                SessionRequestStatusView(requestId: requestId)
            }
            if undelivered {
                // Amber, not red: the message was handed to a session that has not confirmed it.
                Text(SessionMessageCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            if let attached { AttachedNoteEntry(attached: attached) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.tint.opacity(0.28), lineWidth: 1))
    }

    /// "From <session title> · orbit" — who is speaking, before what they said. The title is the way
    /// into that session, through the app's own `orbit-session:` door.
    private var head: some View {
        HStack(spacing: 6) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.orbitMeta).foregroundStyle(.tint)
            Text(SessionMessageCard.from)
                .font(.orbitLabel).foregroundStyle(.secondary)
            if let url = SessionMessageCard.sessionLink(card) {
                Button {
                    openURL(url)
                } label: {
                    Text(SessionMessageCard.title(card))
                        .font(.orbitLabel.weight(.semibold))
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                Text(SessionMessageCard.title(card))
                    .font(.orbitLabel.weight(.semibold))
            }
            Spacer(minLength: 6)
            if !card.fromAgentName.isEmpty {
                Text(card.fromAgentName)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.primary.opacity(0.05), in: Capsule())
                    .overlay(Capsule().strokeBorder(.tint.opacity(0.35), lineWidth: 1))
            }
        }
    }

    /// "Sent by another Orbit session, not by you · 2m ago", and the sender's task when it runs one.
    private var foot: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(SessionMessageCard.meta(ts: ts))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let url = SessionMessageCard.taskLink(card) {
                Button(SessionMessageCard.openTask) { openURL(url) }
                    .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
            }
        }
    }
}
