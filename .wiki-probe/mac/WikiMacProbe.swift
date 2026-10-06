import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): the Mac app's own three columns (`MainView`) in a window the CI
// screen holds (1024 × 768), pointed at stub.py with `-orbit.instance` — OrbitApp.swift, which the probe replaces,
// opens the same view once signed in.
@main
struct WikiMacProbeApp: App {
    @State private var model: AppModel
    @StateObject private var updater = UpdaterModel()

    init() {
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
        }
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("orbit.wiki.") {
            defaults.removeObject(forKey: key)
        }
        defaults.set(Date().addingTimeInterval(-4 * 3600).timeIntervalSince1970,
                     forKey: "orbit.wiki.seen.github-com-jianghailong-xy-orbit.home")
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            MainView()
                .environment(model)
                .environmentObject(updater)
                .frame(minWidth: 960, minHeight: 660)
                .task {
                    await model.agents?.load()
                    model.selectedAgentID = "a1"
                }
        }
        .defaultSize(width: 980, height: 700)
        .defaultPosition(.topLeading)
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
