import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell and AppModel, pointed at stub.py with
// `-orbit.instance`, opened on the Waiting on you inbox or on Settings.
@main
struct TerminalProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            // The two sheets the real app's root hangs over its shell (OrbitiOSApp), inside the environment as
            // RootView hangs them: their views read AppModel from it.
            CompactShell()
                .settingsSheet(model)
                .ownerRequestInboxSheet(model)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
