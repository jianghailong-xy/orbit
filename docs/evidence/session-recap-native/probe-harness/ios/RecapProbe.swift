import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see NOTES.md): the iPhone app's own CompactShell, pointed at stub.py
// with `-orbit.instance`, opened on the workspace's session LIST — the page whose rows carry the
// server's recap — or on Settings (`-probe.settings`), where the Session recaps switch is.
@main
struct RecapProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            // The environment is applied OUTSIDE the sheet, exactly as OrbitiOSApp does it: there,
            // `RootView()` carries `.environment(model)` and applies `.settingsSheet(model)` in its
            // own body, so the sheet is presented from a view INSIDE the environment scope. With the
            // two swapped — `.environment(model)` on the shell, the sheet attached outside it — the
            // presented `SettingsSheet` finds no AppModel ancestor and traps in
            // `EnvironmentValues.subscript.getter` the moment the gear is pressed (the first CI run's
            // crash, on the Settings launch only; the list never opened a sheet).
            ProbeRoot(model: model)
                .environment(model)
                .task {
                    let settings = ProcessInfo.processInfo.arguments.contains("-probe.settings")
                    await ProbeArgs.land(model, settings: settings)
                }
        }
    }
}

/// The signed-in root the real app puts the sheet on (`RootView` in OrbitiOSApp.swift), which this
/// probe replaces along with the file: the shell, with Settings hosted over it.
private struct ProbeRoot: View {
    let model: AppModel

    var body: some View {
        CompactShell().settingsSheet(model)
    }
}
