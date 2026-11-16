import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): one shared fixture case (`-probe.case <name prefix>`) drawn
// by the real AssistantBubbleView with "Show both languages" on, as a session's transcript draws it.
@main
struct BilingualProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeScreen() }
    }
}

private struct Fixture: Decodable {
    struct Case: Decodable { let name: String; let translation: String; let original: String }
    let cases: [Case]
}

private struct ProbeScreen: View {
    private var bubble: AssistantBubble {
        let args = ProcessInfo.processInfo.arguments
        let wanted = args.firstIndex(of: "-probe.case").map { args[$0 + 1] } ?? "headings"
        let url = Bundle.main.url(forResource: "bilingual-pairs.fixture", withExtension: "json")!
        let fixture = try! JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let c = fixture.cases.first { $0.name.hasPrefix(wanted) || $0.name.contains(wanted) }!
        let json: [String: Any] = [
            "id": "probe", "text": c.original, "streamingText": "", "seq": 2,
            "translation": ["lang": "zh-Hans", "text": c.translation, "failed": false],
        ]
        return try! JSONDecoder().decode(AssistantBubble.self, from: JSONSerialization.data(withJSONObject: json))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                AssistantBubbleView(bubble: bubble)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
            .navigationTitle("Show both languages")
            .navigationBarTitleDisplayMode(.inline)
        }
        .environment(\.translationActions, TranslationActions(on: true, bilingual: true,
                                                               retryTurn: { _ in }, sendAsWritten: { _ in }, retryReply: { _ in }))
    }
}
