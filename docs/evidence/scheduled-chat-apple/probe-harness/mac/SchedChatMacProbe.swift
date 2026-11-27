import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own MainView (three-column split), pointed at stub.py with
// `-orbit.instance`, opened on Scheduled — where the chat is a third column beside the inspector.
@main
struct SchedChatMacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            MainView()
                .environment(model)
                .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                .frame(minWidth: 900, minHeight: 600)
                .task { await ProbeArgs.land(model) }
        }
        .defaultSize(width: 1440, height: 860)
        .defaultPosition(.topLeading)
        .commands { SidebarCommands() }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
