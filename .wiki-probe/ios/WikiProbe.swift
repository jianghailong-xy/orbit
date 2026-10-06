import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the iOS app's own shells — CompactShell on an iPhone, MainView's
// three columns on an iPad, picked by width as OrbitiOSApp's RootView picks them — pointed at stub.py with
// `-orbit.instance`, landing on workspace a1's (orbit-develop's) session list: the workspace the orbit space is
// bound to.
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
        // The reader last looked at orbit four hours ago: 3.1 and 3.2, written two hours ago, are new to them
        // (mock 30 ③); the rest, written two days ago, are not.
        defaults.set(Date().addingTimeInterval(-4 * 3600).timeIntervalSince1970,
                     forKey: "orbit.wiki.seen.github-com-jianghailong-xy-orbit.home")
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeShell()
                .environment(model)
                .task {
                    await model.agents?.load()
                    model.selectedAgentID = "a1"
                }
        }
    }
}

/// OrbitiOSApp's RootView once signed in: the shell follows the width.
private struct ProbeShell: View {
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        if hSize == .compact { CompactShell() } else { MainView() }
    }
}
