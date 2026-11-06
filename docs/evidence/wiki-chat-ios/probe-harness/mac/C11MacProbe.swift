import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the Mac app's own MainView (three-column split), pointed at stub.py with
// `-orbit.instance`, opened on the wiki document of board 42 ⑤ — where the chat is the third column beside the page.
@main
struct C11MacProbeApp: App {
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
        // The runner's screen is 1024 × 768: the whole window, the button at its bottom right included, stays on it.
        .defaultSize(width: 1010, height: 680)
        .defaultPosition(.topLeading)
        // ⌃⌘S folds the source list, as OrbitApp.swift's scene offers it, so the chat's column has room.
        .commands { SidebarCommands() }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
