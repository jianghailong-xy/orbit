import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's window as it is signed out — the same
// shared LoginView — pointed at stub.py and seeded per launch, like the iPhone probe.
@main
struct LraMacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.seed()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .frame(minWidth: 820, minHeight: 520)
        }
        .defaultSize(width: 1000, height: 640)
        .defaultPosition(.topLeading)
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
