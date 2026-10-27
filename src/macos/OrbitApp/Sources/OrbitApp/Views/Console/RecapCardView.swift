import SwiftUI
import OrbitKit

/// The conversation's last row while it is at rest (`RecapCard`; the web's `SessionRecapCard`): the
/// recap its list row reads in one line, here whole, with when it was written and a way to write it
/// again now. Where it sits and when it steps aside is `TranscriptView`'s business; this is the card
/// (docs/mocks/session-recap-display/04-decided).
///
/// A footnote, not a panel (the owner, 2026-10-27, 05-quiet A): a grey card the composer's shape,
/// sitting on the composer, read as something floating over the conversation. So it is one paragraph
/// in secondary ink, flush with the reply's edge, the head running into the recap; and on macOS
/// Refresh shows only under the pointer, on keyboard focus or while it asks.
struct RecapCardView: View {
    @Environment(AppModel.self) private var app
    let card: RecapCard
    let sessionID: String
    @State private var refreshing = false
    @State private var hovering = false
    @FocusState private var refreshFocused: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            paragraph
                .opacity(refreshing ? 0.45 : 1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .accessibilityLabel([RecapCard.word, card.when, card.text].compactMap { $0 }.joined(separator: ", "))
            refreshButton
        }
        .font(.orbitSubtext)
        .foregroundStyle(.secondary)
        // One hover region over the whole row, as the message bubble's meta has: without it `.onHover`
        // fires only over the drawn glyphs, and the reach for ↻ would cross a dead gap.
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
        .accessibilityElement(children: .contain)
    }

    /// The Settings row's own glyph (the switch that governs this line), the word and when the recap
    /// was written, then the recap: one paragraph.
    private var paragraph: Text {
        Text(Image(systemName: "text.alignleft")) + Text(verbatim: "\u{00A0}")
            + Text(RecapCard.word).fontWeight(.semibold)
            + Text(card.when.map { " · \($0)" } ?? "")
            + Text(verbatim: "  ") + Text(card.text)
    }

    /// Beside the first line, hidden in place rather than removed, so the words never move when it
    /// appears. Touch has no hover, so on iOS it always shows (the message bubble's copy button makes
    /// the same split).
    private var refreshButton: some View {
        Button(action: refresh) {
            Text(Image(systemName: "arrow.clockwise"))
                .font(.orbitControlGlyph)
                .opacity(refreshing ? 0 : 1)
                .overlay { if refreshing { ProgressView().controlSize(.small) } }
                .frame(width: 30)
                // A line is shorter than a comfortable target: the target hangs over it both ways, and
                // the row is laid out as if it didn't.
                .padding(.vertical, 7)
                .contentShape(Rectangle())
                .padding(.vertical, -7)
        }
        .buttonStyle(.plain)
        .disabled(refreshing)
        .help(RecapCard.refresh)
        .accessibilityLabel(RecapCard.refresh)
        .focused($refreshFocused)
        .opacity(refreshShown ? 1 : 0)
        .allowsHitTesting(refreshShown)
        .padding(.trailing, -8)
    }

    private var refreshShown: Bool {
        #if os(iOS)
        true
        #else
        hovering || refreshing || refreshFocused
        #endif
    }

    private func refresh() {
        guard !refreshing else { return }
        refreshing = true
        Task { @MainActor in
            if let notice = await app.refreshRecap(sessionID) {
                app.showToast(notice.text, tone: notice.failed ? .error : .info)
            }
            refreshing = false
        }
    }
}
