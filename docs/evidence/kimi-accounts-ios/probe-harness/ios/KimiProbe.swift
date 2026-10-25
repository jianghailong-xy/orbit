import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell with its Settings sheet,
// pointed at stub.py with `-orbit.instance`, opened on an engine's page or a session's console; `-dark`
// for dark. The model is put in the environment outermost, as RootView sits inside it in the app, so the
// sheet reads it too.
@main
struct KimiProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            CompactShell()
                .settingsSheet(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}
