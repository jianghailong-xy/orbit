import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md): the iPhone app's own CompactShell, pointed at
// stub.py with `-orbit.instance`, opened on Settings.
@main
struct SettingsOrderProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            // The environment goes OUTSIDE the sheet, as OrbitiOSApp's RootView has it: attached the
            // other way round, the presented SettingsSheet finds no AppModel and traps (the
            // session-recap probe's first run).
            ProbeRoot(model: model)
                .environment(model)
                .task { await ProbeArgs.land(model) }
        }
    }
}

/// The signed-in root the real app puts the sheet on (`RootView` in OrbitiOSApp.swift).
private struct ProbeRoot: View {
    let model: AppModel

    var body: some View {
        CompactShell().settingsSheet(model)
    }
}
