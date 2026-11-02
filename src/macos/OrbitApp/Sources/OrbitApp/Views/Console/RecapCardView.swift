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
/// Refresh shows only under the pointer, on keyboard focus or while it asks. Beside it, × hides this
/// recap in this conversation on this device (2026-11-01, 06-hide); `onHide` remembers that.
struct RecapCardView: View {
    @Environment(AppModel.self) private var app
    let card: RecapCard
    let sessionID: String
    let onHide: () -> Void
    @State private var refreshing = false
    @State private var hovering = false
    @FocusState private var focused: Control?

    private enum Control: Hashable { case refresh, hide }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            paragraph
                .opacity(refreshing ? 0.45 : 1)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .accessibilityLabel([RecapCard.word, card.when, card.text].compactMap { $0 }.joined(separator: ", "))
            controls
        }
        .font(.orbitSubtext)
        .foregroundStyle(.secondary)
        // One hover region over the whole row, as the message bubble's meta has: without it `.onHover`
        // fires only over the drawn glyphs, and the reach for ↻ or × would cross a dead gap.
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

    /// ↻ and ×, beside the first line, hidden in place rather than removed, so the words never move
    /// when they appear. Touch has no hover, so on iOS they always show (the message bubble's copy
    /// button makes the same split).
    private var controls: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Button(action: refresh) {
                glyph("arrow.clockwise")
                    .opacity(refreshing ? 0 : 1)
                    .overlay { if refreshing { ProgressView().controlSize(.small) } }
            }
            .disabled(refreshing)
            .help(RecapCard.refresh)
            .accessibilityLabel(RecapCard.refresh)
            .focused($focused, equals: .refresh)
            Button(action: onHide) { glyph("xmark") }
                .help(RecapCard.hide)
                .accessibilityLabel(RecapCard.hide)
                .focused($focused, equals: .hide)
        }
        .buttonStyle(.plain)
        .opacity(controlsShown ? 1 : 0)
        .allowsHitTesting(controlsShown)
        .padding(.trailing, -8)
    }

    /// A control's glyph on the first line's baseline. A line is shorter than a comfortable target: the
    /// target hangs over it both ways, and the row is laid out as if it didn't.
    private func glyph(_ name: String) -> some View {
        Text(Image(systemName: name))
            .font(.orbitControlGlyph)
            .frame(width: 30)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .padding(.vertical, -7)
    }

    private var controlsShown: Bool {
        #if os(iOS)
        true
        #else
        hovering || refreshing || focused != nil
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
