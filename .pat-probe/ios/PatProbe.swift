import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell with Settings' sheet
// over it (`settingsSheet`, as OrbitiOSApp's RootView hangs it), pointed at stub.py with
// `-orbit.instance`. The launch opens Settings; the UI test does the rest.
@main
struct PatProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            // The sheet inside the environment, as RootView hangs it: its views read AppModel from it.
            CompactShell()
                .settingsSheet(model)
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}
