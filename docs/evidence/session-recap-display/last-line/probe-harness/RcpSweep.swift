import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (the recap card's ⋯, never merged): the real RecapCardView with recaps of eleven lengths,
// whose last lines run past where the ⋯ stands, so that one of them must leave it no room. Each row's time is its
// number, which is how the test finds it. `-probe.sweep cjk` adds one ideograph a row (a break between any two);
// `-probe.sweep latin` one letter of the last word a row (a word that must move whole).
struct RcpSweep: View {
    let kind: String

    private func words(_ row: Int) -> String {
        kind == "latin"
            ? String(repeating: "word ", count: 17) + String(repeating: "x", count: row)
            : String(repeating: "长", count: 39 + row)
    }

    var body: some View {
        List(1...11, id: \.self) { row in
            RecapCardView(card: RecapCard(text: words(row), when: "\(row)"), sessionID: "R1", onHide: {})
                .listRowSeparator(.hidden)
        }
        .listStyle(.plain)
        #if os(macOS)
        .frame(width: 372)
        #endif
    }
}
