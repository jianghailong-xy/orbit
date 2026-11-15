import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own MainView, pointed at stub.py, like the iOS probe.
@main
struct TmMacProbeApp: App {
    @State private var model: AppModel
    /// The Settings form reads Sparkle's model (Receive beta updates); with no feed it stays idle.
    @StateObject private var updater = UpdaterModel()

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            MainView()
                .environment(model)
                .environmentObject(updater)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .frame(minWidth: 960, minHeight: 600)
                .task { await ProbeArgs.land(model) }
        }
        .defaultSize(width: 1000, height: 680)
        .defaultPosition(.topLeading)
        .commands { SidebarCommands() }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
