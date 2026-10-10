import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the page `-probe.page` names — S1's conversation, the workspace's
// list, P1's sessions page or P1's page (`ProbeArgs.land`).
@main
struct RecapEntriesProbeApp: App {
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
