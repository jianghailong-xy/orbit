import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iPhone app's own CompactShell, pointed at stub.py with
// `-orbit.instance` and opened on one coordinator conversation; `-dark` for dark. The model goes in the
// environment outermost, as RootView has it in the app.
@main
struct OacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot(model: model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}

/// The signed-in root the real app draws on a phone (`RootView` in OrbitiOSApp.swift).
private struct ProbeRoot: View {
    let model: AppModel

    var body: some View {
        CompactShell().settingsSheet(model)
    }
}
