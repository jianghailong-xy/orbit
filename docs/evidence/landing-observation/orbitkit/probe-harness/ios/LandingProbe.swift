import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened where `ProbeArgs` says, light or dark.
@main
struct LandingProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .environment(model)
                .preferredColorScheme(ProbeArgs.scheme)
                .task { await ProbeArgs.land(model) }
        }
    }
}
