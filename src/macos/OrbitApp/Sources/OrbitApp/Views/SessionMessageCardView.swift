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
/// again; appended notes stay out of the transcript.
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
    /// Withdraws the message while it is still queued behind the running turn; nil once a runner has
    /// taken it. Withdrawing hands none of it back to the composer: the words are the sending
    /// session's, not the reader's (`ComposerLogic.restorableText`).
    var onCancelQueued: (() -> Void)? = nil
    /// A record link or a search hit asked for this turn: a folded message opens to show it.
    var revealed: Bool = false

    @Environment(\.openURL) private var openURL
    /// The app's own link door: the sender's session and its task are pushed over a phone's
    /// conversation (see `opensPagesOverConsole`), so the back swipe returns to it.
    @Environment(AppModel.self) private var app: AppModel?
    @Environment(\.opensPagesOverConsole) private var overConsole
    /// On a wide shell a task opens over the page instead of switching sections
    /// (`opensTasksOverPage`, owner decision 2026-11-12).
    @Environment(\.opensTasksOverPage) private var opensTasksOverPage
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
        // Drawn the way a chat draws somebody else's message (docs/mocks/session-message-bubble,
        // owner 2026-11-12): who sent it on one grey line, their words in a bubble on the incoming
        // side that hugs them, and everything else on one grey foot line.
        VStack(alignment: .leading, spacing: 3) {
            head
            bubble
            foot
            if let narrower {
                // A sender that runs narrower than this session: in the foot line's voice, under it.
                Text(narrower)
                    .font(.orbitMeta).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if undelivered {
                // Amber, not red: the message was handed to a session that has not confirmed it.
                Text(SessionMessageCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            if let onCancelQueued { queuedFoot(onCancelQueued) }
        }
        .orbitCardWidth()
    }

    /// The sending agent's words, in a bubble no wider than they need.
    private var bubble: some View {
        VStack(alignment: .leading, spacing: 2) {
            if !text.isEmpty {
                messageBody
            }
            if tall && !revealed {
                Button(expanded ? SessionMessageCard.showLess : SessionMessageCard.showMore) { expanded.toggle() }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
        // A hairline, dashed while it is still queued, as the control plane's own cards are.
        .overlay(
            RoundedRectangle(cornerRadius: 10).strokeBorder(
                Color.primary.opacity(0.12),
                style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(SessionMessageCard.notYou))
        // The paragraphs fill what they are offered on macOS; this offers them only their own width.
        .hugWidth()
    }

    /// The sending agent's words: whole, or their first lines fading out while the message is folded.
    private var messageBody: some View {
        FoldedProse(bodyHeight: $bodyHeight, lineHeight: $lineHeight, clamped: clamped) {
            MarkdownView(source: text, base: .body, ink: .primary, fillWidth: false)
                .font(.orbitProse)
                .textSelection(.enabled)
        }
    }

    /// One of this card's links through the app's own link door, told whether the card is in a
    /// phone's conversation (there what it opens is pushed over it) or on a wide shell (there a
    /// task opens over the page; anything else routes).
    private func openLink(_ url: URL) {
        if app?.openOrbitLink(url, overConsole: overConsole, overPage: opensTasksOverPage) != true { openURL(url) }
    }

    /// The queue's own line while the message waits behind a running turn: how it stands, and Cancel.
    private func queuedFoot(_ cancel: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            QueuedWord()
            Button("Cancel") { cancel() }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
    }

    /// "From <session title> · orbit" — who is speaking, on one grey line over what they said. The
    /// line is the way into that session, through the app's own `orbit-session:` door; that this is
    /// not the reader's own message is its help and its accessibility label, not a sentence on screen.
    private var head: some View {
        Group {
            if let url = SessionMessageCard.sessionLink(card) {
                Button {
                    openLink(url)
                } label: {
                    headText.multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
            } else {
                headText
            }
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .help(SessionMessageCard.notYou)
        .accessibilityLabel(Text(headLabel))
    }

    private var headText: Text {
        let agent = card.fromAgentName.isEmpty ? Text("") : Text(" · \(card.fromAgentName)").foregroundStyle(.tertiary)
        return Text(Image(systemName: "bubble.left.and.bubble.right")).foregroundStyle(.tertiary)
            + Text(" \(SessionMessageCard.from) ")
            + Text(SessionMessageCard.title(card)).fontWeight(.semibold)
            + agent
    }

    private var headLabel: String {
        var label = "\(SessionMessageCard.from) \(SessionMessageCard.title(card))"
        if !card.fromAgentName.isEmpty { label += " · \(card.fromAgentName)" }
        return "\(label). \(SessionMessageCard.notYou)"
    }

    /// One grey line under the bubble: "2m ago · Its task ↗ · Asked for a reply · Replied",
    /// each item that applies, wrapping between items when the column is narrow.
    private var foot: some View {
        let time = SessionMessageCard.meta(ts: ts)
        let task = SessionMessageCard.taskLink(card)
        let request = card.requestId != nil
        return FlowLayout(spacing: 0) {
            if let time {
                footItem(more: task != nil || request) { Text(time) }
            }
            if let url = task {
                footItem(more: request) {
                    Button(SessionMessageCard.openTask) { openLink(url) }
                        .buttonStyle(.plain)
                }
            }
            if let requestId = card.requestId {
                // The message asks for a reply: what it asks, by when, and where it stands — read live.
                footItem(more: false) {
                    SessionRequestStatusView(requestId: requestId)
                }
            }
        }
        .font(.orbitMeta)
        .foregroundStyle(.tertiary)
    }

    /// One item of the foot line, with the separator after it when another follows.
    private func footItem(more: Bool, @ViewBuilder _ content: () -> some View) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            content()
            if more { Text(" · ") }
        }
    }
}

/// Lays its one view out no wider than that view's own single-line width, nor than it is offered:
/// a bubble that hugs short words and wraps long ones at the column, even when what it holds would
/// take every point it is offered.
/// `hugs: false` passes the offer through untouched.
extension View {
    func hugWidth(_ hugs: Bool = true) -> some View { HugWidthLayout(hugs: hugs) { self } }
}

struct HugWidthLayout: Layout {
    var hugs = true

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let view = subviews.first else { return .zero }
        guard hugs else { return view.sizeThatFits(proposal) }
        let ideal = view.sizeThatFits(.unspecified).width
        let width = min(ideal, proposal.width ?? ideal)
        return view.sizeThatFits(ProposedViewSize(width: width, height: proposal.height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
                              proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
}

/// The widest an Orbit card in a conversation draws: on the agent's side, from the leading edge, and
/// no wider than this however wide the window (docs/mocks/session-message-bubble, owner 2026-11-12;
/// web's `--chat-card-max: 720px` on `.oic/.tsc/.psc/.crc` and `.smc-wrap`). A phone's column is narrower,
/// and there a card takes the column.
extension View {
    func orbitCardWidth() -> some View {
        frame(maxWidth: ConversationCardWidth.max, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A body of prose that folds by its rendered height (docs/mocks/session-message-clamp, approved
/// 2026-11-11): taller than `SessionMessageCard.clampFrom` lines it shows its first `clampLines` and
/// fades out, until its card opens it. The text is laid out at its full height and measured there,
/// then clipped, so opening it moves nothing else. Shared by the "From" message card and the reply
/// card, so the fold is one rule; whether it folds is the caller's to ask
/// (`SessionMessageCard.folds(height:lineHeight:)`).
struct FoldedProse<Content: View>: View {
    /// The body's full height as laid out before the clip, and one line of its font.
    @Binding var bodyHeight: CGFloat
    @Binding var lineHeight: CGFloat
    /// Whether it shows folded now: measured tall, neither opened by the reader nor revealed.
    let clamped: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
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
                    LinearGradient(stops: [.init(color: .black, location: 0.55), .init(color: .clear, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                } else {
                    Rectangle()
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
