import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own LoginView and AppModel behind its
// sign-in gate, in a window the CI screen (1024 × 768) holds at the main window's minimum width,
// pointed at stub.py with `-orbit.instance`.
@main
struct A1MacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.signOut()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .frame(minWidth: 820, minHeight: 520)
        }
        .defaultSize(width: 860, height: 640)
        .defaultPosition(.topLeading)
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
