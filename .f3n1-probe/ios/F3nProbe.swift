import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance`.
@main
struct F3nProbeApp: App {
    @State private var model: AppModel

    init() {
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
