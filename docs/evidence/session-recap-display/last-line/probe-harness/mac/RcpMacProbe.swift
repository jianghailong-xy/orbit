import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (the recap card's ⋯, never merged): the Mac app's own MainView (three-column split),
// pointed at stub.py with `-orbit.instance`, opened on one conversation per launch, like the iOS probe. With
// `-probe.variants`, the page of ways to stand the control instead (RcpVariants).
@main
struct RcpMacProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.wipeIfFresh()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            if let kind = ProbeArgs.value("-probe.sweep") {
                RcpSweep(kind: kind)
                    .environment(model)
                    .preferredColorScheme(.light)
            } else if ProcessInfo.processInfo.arguments.contains("-probe.variants") {
                RcpVariants()
                    .environment(model)
                    .preferredColorScheme(.light)
            } else {
                MainView()
                    .environment(model)
                    .preferredColorScheme(ProbeArgs.dark ? .dark : .light)
                    .frame(minWidth: 960, minHeight: 600)
                    .task { await ProbeArgs.land(model) }
            }
        }
        .defaultSize(width: 1000, height: 620)
        .defaultPosition(.topLeading)
        // ⌃⌘S, which the test presses to fold the source list away for the wide frame.
        .commands { SidebarCommands() }
    }
}

/// MenuBarContent opens the runner window by this id (OrbitApp.swift, which the probe replaces).
enum OrbitApp {
    static let runnerWindowID = "runner-manager"
}
