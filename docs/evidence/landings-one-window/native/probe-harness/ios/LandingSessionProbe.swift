import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the page `-probe.page` names — the project's sessions page with
// its Landings row, or a landing session's id, which opens the project's Landings window on it.
@main
struct LandingSessionProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
