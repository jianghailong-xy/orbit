import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own Settings form (`SettingsView`) at the
// Settings window's width (OrbitApp.swift's `Settings` scene, which the probe replaces), pointed at
// stub.py with `-orbit.instance`, as a window the UI test can drive.
@main
struct PatMacProbeApp: App {
    @State private var model: AppModel
    @StateObject private var updater = UpdaterModel()

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            SettingsView()
                .environment(model)
                .environmentObject(updater)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .frame(minWidth: 480, minHeight: 560)
                .task { await ProbeArgs.land(model) }
        }
        .defaultSize(width: 480, height: 620)
        .defaultPosition(.topLeading)
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
