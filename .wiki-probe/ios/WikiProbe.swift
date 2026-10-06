import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance`, landing on workspace a1's (orbit-develop's) session list — the workspace the orbit
// space is bound to.
@main
struct WikiProbeApp: App {
    @State private var model: AppModel

    init() {
        // Each launch starts from what the stub serves, not from what an earlier launch left behind.
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
        }
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("orbit.wiki.") {
            defaults.removeObject(forKey: key)
        }
        // The reader last looked at orbit four hours ago: the maintenance runs of three hours ago are
        // what Activity marks new (mock 31 ②), the owner's amend of two days ago is not.
        defaults.set(Date().addingTimeInterval(-4 * 3600).timeIntervalSince1970,
                     forKey: "orbit.wiki.seen.github-com-jianghailong-xy-orbit.home")
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .task {
                    await model.agents?.load()
                    model.selectedAgentID = "a1"
                }
        }
    }
}
