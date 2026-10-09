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
            CompactShell()
                .environment(model)
                // Settings is a sheet over whichever shell is showing, raised by the drawer's gear
                // (`AppModel.settingsPresented`). The real shell attaches this at its signed-in root
                // (OrbitiOSApp.swift's RootView, which this probe replaces), so the sheet the probe
                // photographs is composed exactly as production composes it — the probe only brings
                // the modifier over because the file that normally does is the one it stands in for.
                .settingsSheet(model)
                .task {
                    let settings = ProcessInfo.processInfo.arguments.contains("-probe.settings")
                    await ProbeArgs.land(model, settings: settings)
                }
        }
    }
}
