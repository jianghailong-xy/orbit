import SwiftUI
import OrbitKit

/// The iOS probe app (evidence only): it draws the REAL cards — the same
/// `Views/ApprovalCards.swift` the iOS target compiles, reached through a real `ConsoleModel` whose
/// `GET /projects/:id/open-items` read came back from `.ios-probe/probe-server.mjs`.
///
/// Nothing here re-implements a card: the whole of `src/macos/OrbitApp/Sources/OrbitApp` is in this
/// target (the same shared-sources arrangement `src/ios/project.yml` uses), so what is
/// screenshotted is what ships.
@main
struct ProbeApp: App {
    var body: some Scene { WindowGroup { ProbeRoot() } }
}

struct ProbeRoot: View {
    /// A session id the stub answers for; the console's own reads are keyed by it.
    private static let sessionID = "34SgoRKPa0zhBhzdzD5PV"
    private static var baseURL: URL {
        let port = ProcessInfo.processInfo.environment["PROBE_PORT"] ?? "8931"
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    @State private var console: ConsoleModel?
    @State private var cards: [DeliveredDecisionCard] = []
    @State private var trace = "waiting for the read…"

    /// `-shot all` draws every delivered card (they do not all fit one phone screen), and `-shot N`
    /// draws just the Nth — the way each card gets a screenshot of its own without the reader
    /// having to scroll a simulator.
    private var visible: [DeliveredDecisionCard] {
        let args = ProcessInfo.processInfo.arguments
        guard let at = args.firstIndex(of: "-shot"), args.indices.contains(at + 1),
              let index = Int(args[at + 1]), cards.indices.contains(index) else { return cards }
        return [cards[index]]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(trace)
                    .font(.orbitMonoFine)
                    .foregroundStyle(.secondary)
                ForEach(visible) { card in
                    if let console {
                        DeliveredDecisionCardView(console: console, card: card)
                    }
                }
            }
            .padding(14)
        }
        .task {
            let store = InMemoryTokenStore()
            store.setToken("probe-token", for: Self.baseURL)
            let console = ConsoleModel(sessionID: Self.sessionID, baseURL: Self.baseURL,
                                       tokenStore: store,
                                       attachments: AttachmentImageStore(baseURL: Self.baseURL,
                                                                        tokenStore: store))
            self.console = console
            // The app's own path: the console loads its context (which names the project), and the
            // ruler read that follows files the cards. Nothing here injects a fixture.
            console.startStreaming()
            for _ in 0..<60 {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if !console.decisionCards.isEmpty { break }
            }
            cards = console.decisionCards
            trace = "\(cards.count) card(s): " + cards.map { "\($0.id)" }.joined(separator: ", ")
        }
    }
}
