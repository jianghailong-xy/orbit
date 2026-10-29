import SwiftUI
import OrbitKit

// Evidence probe (see ../../../README.md): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance`, opened on the conversation `ProbeArgs` names, light or dark.
@main
struct CasProbeApp: App {
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
