import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance` and opened on one conversation; `-dark` for dark. The model is put in the environment
// outermost, as RootView sits inside it in the app.
@main
struct MrProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
