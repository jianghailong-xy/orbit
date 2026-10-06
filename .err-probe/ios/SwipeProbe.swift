import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance`, landing on workspace a1's session list.
@main
struct SwipeProbeApp: App {
    @State private var model: AppModel

    init() {
        // Each launch starts from what the stub serves, not from a transcript or launch snapshot an
        // earlier launch left in Application Support/Orbit.
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
        }
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
