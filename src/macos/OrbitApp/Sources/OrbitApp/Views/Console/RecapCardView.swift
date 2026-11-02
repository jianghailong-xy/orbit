import SwiftUI
import OrbitKit

/// The conversation's last row while it is at rest (`RecapCard`; the web's `SessionRecapCard`): the
/// recap its list row reads in one line, here whole, with when it was written and a way to write it
/// again now. Where it sits and when it steps aside is `TranscriptView`'s business; this is the card
/// (docs/mocks/session-recap-display/04-decided).
///
/// A footnote, not a panel (the owner, 2026-10-27, 05-quiet A): a grey card the composer's shape,
/// sitting on the composer, read as something floating over the conversation. So it is one paragraph
/// in secondary ink, flush with the reply's edge, the head running into the recap. Refresh, and the ×
/// that hides this recap in this conversation on this device (2026-11-01, 06-hide; `onHide` remembers
/// that), sit behind one ⋯ at the end of the last line (2026-11-02, 07-last-line B): beside the first
/// line they held a column down the whole card. On macOS the ⋯ shows only under the pointer, on
/// keyboard focus or while it asks.
struct RecapCardView: View {
    @Environment(AppModel.self) private var app
    let card: RecapCard
    let sessionID: String
    let onHide: () -> Void
    @State private var refreshing = false
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        (paragraph + room)
            .opacity(refreshing ? 0.45 : 1)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .accessibilityLabel([RecapCard.word, card.when, card.text].compactMap { $0 }.joined(separator: ", "))
            .overlay(alignment: Alignment(horizontal: .trailing, vertical: .lastTextBaseline)) { more }
            .font(.orbitSubtext)
            .foregroundStyle(.secondary)
            // One hover region over the whole row, as the message bubble's meta has: without it `.onHover`
            // fires only over the drawn glyphs, and the reach for ⋯ would cross a dead gap.
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

    /// Room for the ⋯ at the end of the last line: an empty image as wide as the part of the ⋯ inside
    /// the line, so the words never run under it. A no-break space holds it to the last word, so a last
    /// line with no room for it takes that word along to the next, rather than leaving the ⋯ a line
    /// of its own.
    private var room: Text {
        Text(verbatim: "\u{00A0}") + Text(Image(size: CGSize(width: 24, height: 1)) { _ in })
    }

    /// The ⋯ on the last line's baseline, hidden in place rather than removed, so the words never move
    /// when it appears. Touch has no hover, so on iOS it always shows (the message bubble's copy button
    /// makes the same split). The Menu lies over a hidden ⋯, whose baseline is the one the last line
    /// aligns on; while a refresh asks, a spinner takes its place.
    private var more: some View {
        glyph.hidden()
            .overlay {
                Menu {
                    Button(action: refresh) { Label(RecapCard.refresh, systemImage: "arrow.clockwise") }
                    Button(action: onHide) { Label(RecapCard.hide, systemImage: "xmark") }
                } label: {
                    // A line is shorter than a comfortable target: the target hangs over it both ways,
                    // and the row is laid out as if it didn't.
                    glyph
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                        .padding(.vertical, -7)
                }
                #if os(macOS)
                // `.button` + plain draws the label as it is, in the row's grey (the account menu's recipe).
                .menuStyle(.button)
                .buttonStyle(.plain)
                #endif
                .menuIndicator(.hidden)
                .menuOrder(.fixed)
                // iOS tints a menu's label with the accent; the ⋯ keeps the row's grey, as the composer's + does.
                .neutralMenuTint(.secondary)
                .opacity(refreshing ? 0 : 1)
                .disabled(refreshing)
                .accessibilityLabel(RecapCard.more)
                .focused($focused)
            }
            .overlay { if refreshing { ProgressView().controlSize(.small) } }
            // Not quite 0: SwiftUI drops a wholly transparent view from the accessibility tree, and a
            // screen reader has no pointer to bring it back with.
            .opacity(controlsShown ? 1 : 0.001)
            .allowsHitTesting(controlsShown)
            .padding(.trailing, -8)
    }

    private var glyph: some View {
        Text(Image(systemName: "ellipsis"))
            .font(.orbitControlGlyph)
            .frame(width: 30)
    }

    private var controlsShown: Bool {
        #if os(iOS)
        true
        #else
        hovering || refreshing || focused
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
