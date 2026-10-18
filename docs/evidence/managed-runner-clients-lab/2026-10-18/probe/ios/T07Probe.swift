import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at replay.py
// with `-orbit.instance`, opened at one place per launch (`-probe.surface compose|console|runners`).
@main
struct T07ProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .preferredColorScheme(.light)
                .task { await ProbeArgs.land(model) }
        }
    }
}
