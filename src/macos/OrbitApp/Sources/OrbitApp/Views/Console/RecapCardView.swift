import SwiftUI
import OrbitKit

/// The conversation's last row while it is at rest (`RecapCard`; the web's `SessionRecapCard`): the
/// recap its list row reads in one line, here whole, with when it was written. Where it sits and when it steps aside is `TranscriptView`'s business; this is the card
/// (docs/mocks/session-recap-display/04-decided).
///
/// A footnote, not a panel (the owner, 2026-10-27, 05-quiet A): a grey card the composer's shape,
/// sitting on the composer, read as something floating over the conversation. So it is one paragraph
/// in secondary ink, flush with the reply's edge, the head running into the recap. One × at the end of
/// the last line (2026-11-02, 07-last-line B) hides this recap in this conversation on this device
/// (2026-11-01, 06-hide; `onHide` remembers that). It was a ⋯ menu with Refresh too; the owner,
/// 2026-11-16: no menu, no refresh, just the ×. On macOS the × shows only under the pointer or on
/// keyboard focus.
struct RecapCardView: View {
    let card: RecapCard
    let onHide: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        (paragraph + room)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .accessibilityLabel([RecapCard.word, card.when, card.text].compactMap { $0 }.joined(separator: ", "))
            .overlay(alignment: Alignment(horizontal: .trailing, vertical: .lastTextBaseline)) { hide }
            .font(.orbitSubtext)
            .foregroundStyle(.secondary)
            // One hover region over the whole row, as the message bubble's meta has: without it `.onHover`
            // fires only over the drawn glyphs, and the reach for × would cross a dead gap.
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

    /// Room for the × at the end of the last line: an empty image as wide as the part of the × inside
    /// the line, so the words never run under it. A no-break space holds it to the last word, so a last
    /// line with no room for it takes that word along to the next, rather than leaving the × a line
    /// of its own.
    private var room: Text {
        Text(verbatim: "\u{00A0}") + Text(Image(size: CGSize(width: 24, height: 1)) { _ in })
    }

    /// The × on the last line's baseline, hidden in place rather than removed, so the words never move
    /// when it appears. Touch has no hover, so on iOS it always shows (the message bubble's copy button
    /// makes the same split). The button lies over a hidden ×, whose baseline is the one the last line
    /// aligns on.
    private var hide: some View {
        glyph.hidden()
            .overlay {
                Button(action: onHide) {
                    // A line is shorter than a comfortable target, so the target hangs over it both ways. No
                    // negative padding to hide that from the row: the hidden × below is what the row lays out.
                    glyph
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                }
                // Plain draws the glyph as it is, in the row's grey.
                .buttonStyle(.plain)
                .help(RecapCard.hide)
                .accessibilityLabel(RecapCard.hide)
                .focused($focused)
            }
            // Not quite 0: SwiftUI drops a wholly transparent view from the accessibility tree, and a
            // screen reader has no pointer to bring it back with.
            .opacity(controlsShown ? 1 : 0.001)
            .allowsHitTesting(controlsShown)
            .padding(.trailing, -8)
    }

    private var glyph: some View {
        Text(Image(systemName: "xmark"))
            .font(.orbitControlGlyph)
            .frame(width: 30)
    }

    private var controlsShown: Bool {
        #if os(iOS)
        true
        #else
        hovering || focused
        #endif
    }
}
