import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (the recap card's ⋯, never merged). Round 4 found that every way of standing the control
// shows in the Mac's accessibility tree under the pointer on a page like this, the shipped overlay included, while the
// real card's ⋯ does not in the real console. So: the shipped overlay, plus one of the real card's differences per
// row (each control named for its row, "Control F3"); then all of them; then the real RecapCardView on this page, to
// tell the card from the console around it. Shown with `-probe.variants`.
struct RcpVariants: View {
    var body: some View {
        List {
            Factor(tag: "F0")
            Factor(tag: "F1", focus: true)
            Factor(tag: "F2", attachments: true)
            Factor(tag: "F3", hangingTarget: true)
            Factor(tag: "F4", hang: true)
            Factor(tag: "F5", guards: true)
            Factor(tag: "F6", spinnerSlot: true)
            Factor(tag: "F7", outer: true)
            Factor(tag: "F8", focus: true, attachments: true, hangingTarget: true, hang: true, guards: true,
                   spinnerSlot: true, outer: true)
            RecapCardView(card: RecapCard(text: "The real card's words, long enough to wrap in this narrow list.", when: "7:03 AM"),
                          sessionID: "R1", onHide: {})
        }
        .frame(width: 372)
    }
}

private extension View {
    @ViewBuilder func when<V: View>(_ condition: Bool, _ apply: (Self) -> V) -> some View {
        if condition { apply(self) } else { self }
    }
}

private struct Factor: View {
    let tag: String
    var focus = false
    var attachments = false
    var hangingTarget = false
    var hang = false
    var guards = false
    var spinnerSlot = false
    var outer = false
    @State private var hovering = false
    @FocusState private var focused: Bool

    private var words: Text {
        let said = Text("\(tag) · the words of a recap long enough to wrap in this narrow list.")
        guard attachments else { return said }
        return Text(Image(systemName: "text.alignleft")) + Text(verbatim: "\u{00A0}") + said
            + Text(verbatim: "\u{00A0}") + Text(Image(size: CGSize(width: 24, height: 1)) { _ in })
    }

    private var glyph: some View {
        Text(Image(systemName: "ellipsis")).frame(width: 30)
    }

    private var menu: some View {
        Menu {
            Button("One") {}
            Button("Two") {}
        } label: {
            glyph.when(hangingTarget) { $0.padding(.vertical, 7).contentShape(Rectangle()).padding(.vertical, -7) }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .menuOrder(.fixed)
        .when(guards) { $0.opacity(1).disabled(false) }
        .accessibilityLabel("Control \(tag)")
        .when(focus) { $0.focused($focused) }
    }

    var body: some View {
        let shown = hovering || (focus && focused)
        words
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .accessibilityLabel("Paragraph \(tag)")
            .overlay(alignment: Alignment(horizontal: .trailing, vertical: .lastTextBaseline)) {
                glyph.hidden()
                    .overlay { menu }
                    .when(spinnerSlot) { $0.overlay { if focused { ProgressView().controlSize(.small) } } }
                    .opacity(shown ? 1 : 0)
                    .allowsHitTesting(shown)
                    .when(hang) { $0.padding(.trailing, -8) }
            }
            .when(outer) { $0.font(.orbitSubtext).foregroundStyle(.secondary) }
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .animation(.easeOut(duration: 0.12), value: hovering)
            .accessibilityElement(children: .contain)
    }
}
