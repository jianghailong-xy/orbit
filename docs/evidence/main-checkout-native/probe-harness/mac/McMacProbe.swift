import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (task 34vZvzdK0NZaSo0JNQ2ES): the Mac app's own MainView (or the workspace settings
// form), pointed at stub.py with `-orbit.instance`.
@main
struct McMacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if ProbeArgs.form { ProbeForm().frame(width: 560, height: 560) } else { MainView() }
            }
            .environment(model)
            .preferredColorScheme(.light)
            .frame(minWidth: ProbeArgs.form ? 560 : 1000, minHeight: ProbeArgs.form ? 560 : 680)
            .task { await ProbeArgs.land(model) }
        }
        .defaultSize(width: ProbeArgs.form ? 560 : 1000, height: ProbeArgs.form ? 560 : 680)
        .defaultPosition(.topLeading)
        .commands { SidebarCommands() }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
