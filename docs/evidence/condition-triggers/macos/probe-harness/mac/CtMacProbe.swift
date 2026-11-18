import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own MainView (the split with the source list, the
// Scheduled timeline and its right-hand column) and AppModel, pointed at stub.py with `-orbit.instance`, with the
// sheets the real app's RootView hangs over it (OrbitApp.swift, which the probe replaces).
@main
struct CtMacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            MainView()
                .sessionSearchSheet(model)
                .ownerRequestInboxSheet(model)
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .frame(minWidth: 960, minHeight: 640)
                .task { await ProbeArgs.land(model) }
        }
        .defaultSize(width: 1000, height: 680)
        .defaultPosition(.topLeading)
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
