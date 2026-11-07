import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on Wiki Review or one entry per launch (ProbeArgs).
@main
struct RvProbeApp: App {
    @State private var model: AppModel

    init() {
        // Task 34tKCNy9aN3Itk5SgIoIl: the watchdog that writes the main thread's stacks while it is late.
        StallWatch.start()
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .task { await ProbeArgs.land(model) }
        }
    }
}
