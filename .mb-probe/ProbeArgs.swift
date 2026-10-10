import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where a launch opens.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account and its workspace as the app reads them once signed in, then one project's page —
    /// `-probe.project P2` — as `openProject` puts it there for a link, a notification or ⌘K; or one
    /// conversation — `-probe.session C5` — as a press on its row opens it.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        try? await Task.sleep(for: .seconds(1))
        if let session = UserDefaults.standard.string(forKey: "probe.session") {
            model.selectedAgentID = "a1"
            model.route(to: .session(session))
            return
        }
        model.openProject(UserDefaults.standard.string(forKey: "probe.project") ?? "P1")
    }
}
