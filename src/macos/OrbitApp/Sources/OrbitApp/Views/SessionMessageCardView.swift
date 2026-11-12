import SwiftUI
import OrbitKit

/// Another Orbit session's message, drawn as "From [that session]" — instead of the account owner's
/// own bubble.
///
/// `session_send` and `project_send` write a turn into this conversation that the owner did not type.
/// The words are the sending agent's and are drawn as they were sent; what the card adds is who sent
/// them — the session's title, which opens it, the agent it runs as, and the task it runs — from the
/// payload the control plane recorded beside the echo (OrbitKit's `SessionMessage`, read out of
/// `sessionMessage`). The block delivery appended to tell the recipient the same thing is not shown
/// again (`SessionMessageCard.splitNote`); anything else delivery appended rides inside, folded.
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
    /// The line for a sender that runs narrower than this session (`SessionMessageCard.narrower`).
    var narrower: String? = nil
    /// What delivery appended to the same turn (a `controlPlaneNote`), as its own folded entry.
    var attached: (kind: String, text: String)?
    /// Withdraws the message while it is still queued behind the running turn; nil once a runner has
    /// taken it. Withdrawing hands none of it back to the composer: the words are the sending
    /// session's, not the reader's (`ComposerLogic.restorableText`).
    var onCancelQueued: (() -> Void)? = nil
    /// A record link or a search hit asked for this turn: a folded message opens to show it.
    var revealed: Bool = false

    @Environment(\.openURL) private var openURL
    @State private var expanded = false
    /// The body's full height and one line of its font, measured as drawn: a message taller than
    /// `SessionMessageCard.clampFrom` lines shows its first `clampLines` until "Show more" (web parity:
    /// `SessionMessageCard.tsx`, measured rather than counted, which replaced a 6,000-character cut).
    @State private var bodyHeight: CGFloat = 0
    @State private var lineHeight: CGFloat = 0

    private var queued: Bool { onCancelQueued != nil }
    private var tall: Bool { SessionMessageCard.folds(height: bodyHeight, lineHeight: lineHeight) }
    private var clamped: Bool { tall && !expanded && !revealed }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            head
            if !text.isEmpty {
                messageBody
            }
            if tall && !revealed {
                Button(expanded ? SessionMessageCard.showLess : SessionMessageCard.showMore) { expanded.toggle() }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
            foot
            if let narrower {
                Text(narrower)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
            if let onCancelQueued { queuedFoot(onCancelQueued) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        // Dashed while it is still queued, as the control plane's own cards are.
        .overlay(
            RoundedRectangle(cornerRadius: 8).strokeBorder(
                .tint.opacity(0.28),
                style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
        )
    }

    /// The sending agent's words: whole, or their first lines fading out while the message is folded.
    /// The text is laid out at its full height and measured there, then clipped, so opening it moves
    /// nothing but the foot.
    private var messageBody: some View {
        MarkdownView(source: text, base: .body, ink: .primary)
            .font(.orbitProse)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: SessionMessageBodyHeightKey.self, value: proxy.size.height)
            })
            .background(alignment: .topLeading) {
                // One line of the body's font, never shown: what "a line" is on this device and size.
                Text(verbatim: "Ag").font(.orbitProse).fixedSize().hidden()
                    .background(GeometryReader { proxy in
                        Color.clear.preference(key: SessionMessageLineHeightKey.self, value: proxy.size.height)
                    })
            }
            .onPreferenceChange(SessionMessageBodyHeightKey.self) { bodyHeight = $0 }
            .onPreferenceChange(SessionMessageLineHeightKey.self) { lineHeight = $0 }
            .frame(maxHeight: clamped ? lineHeight * CGFloat(SessionMessageCard.clampLines) : nil, alignment: .top)
            .clipped()
            .mask {
                if clamped {
                    LinearGradient(stops: [.init(color: .black, location: 0.7), .init(color: .clear, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                } else {
                    Rectangle()
                }
            }
    }

    /// The queue's own line while the message waits behind a running turn: how it stands, and Cancel.
    private func queuedFoot(_ cancel: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text("Queued").font(.orbitMeta).foregroundStyle(.secondary)
            Button("Cancel") { cancel() }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
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

/// The message body's full height, as laid out before it is clipped.
private struct SessionMessageBodyHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// One line of the body's font.
private struct SessionMessageLineHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
