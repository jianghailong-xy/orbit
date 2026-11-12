import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iPhone app's own CompactShell and Settings sheet,
// pointed at stub.py with `-orbit.instance`, opened on Settings › Sessions so Translation X1 can
// photograph its Translation group (board docs/mocks/session-translation, frames 2 and 7). The stub
// serves /users/me answers recorded from a real apiserver built from the project branch.
@main
struct TranslationProbeApp: App {
    @State private var model: AppModel

    init() {
        if ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
           let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
        }
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .settingsSheet(model)
                .task { await land(model) }
        }
    }
}

@MainActor
func land(_ model: AppModel) async {
    if let base = model.baseURL {
        model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
    }
    post("ME translationAvailable=\(String(describing: model.user?.translationAvailable)) translationEnabled=\(String(describing: model.user?.preferences?.translationEnabled)) language=\(String(describing: model.user?.preferences?.translationLanguage)) api=\(model.api != nil)")
    // The shell restores its own landing as it comes up: open Settings a few times with a gap.
    for _ in 0..<3 {
        try? await Task.sleep(for: .seconds(2))
        if !model.settingsPresented { model.settingsPresented = true }
        if model.nav.settingsPath != [.settingsPage(.sessions)] { model.nav.settingsPath = [.settingsPage(.sessions)] }
    }
}

func post(_ line: String) {
    var r = URLRequest(url: URL(string: "http://127.0.0.1:8765/__note")!)
    r.httpMethod = "POST"
    r.httpBody = line.data(using: .utf8)
    URLSession.shared.dataTask(with: r).resume()
}
