import SwiftUI
import OrbitKit

// Evidence probe (see ../README.md): the Mac app's own window (`MainView`, which OrbitApp.swift's RootView
// shows once signed in; the probe replaces that file), pointed at stub.py with `-orbit.instance`, with the
// File menu's New Session as OrbitApp.swift declares it.
@main
struct FwMacProbeApp: App {
    @State private var model: AppModel
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
                .preferredColorScheme(ProbeArgs.scheme)
                .frame(minWidth: 900, minHeight: 600)
                .task { await ProbeArgs.land(model) }
        }
        .defaultSize(width: 1010, height: 740)
        .defaultPosition(.topLeading)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Session") { model.newSessionInCurrentAgent() }
                    .keyboardShortcut("n", modifiers: .command)
                    .disabled(model.newSessionTarget == nil)
            }
        }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
