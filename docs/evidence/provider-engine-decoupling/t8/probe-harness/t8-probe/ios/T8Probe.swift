import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell with its Settings sheet,
// pointed at stub.py with `-orbit.instance`, opened where `-probe.surface` says. The model is put in the
// environment outermost, as RootView sits inside it in the app, so the sheet reads it too.
@main
struct T8ProbeApp: App {
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
                // As the app's RootView: a tap outside a text field lowers the keyboard.
                .dismissesKeyboardOnBackgroundTap()
                .task { await ProbeArgs.land(model) }
        }
    }
}
