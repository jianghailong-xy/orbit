import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). The real iOS session list — `AgentContentColumn` in
// the compact shell's push shape, in a navigation stack as `CompactShell` hosts it, minus the drawer,
// with the app's toast host as `CompactShell` attaches it — signed in to the fixture API `stub.py`
// serves. `-orbit.instance http://127.0.0.1:8765` points `AppModel` at it (the key `AppModel.init`
// restores its instance from); `-dark` for dark.

@main
struct MoveProbeApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("-dark") ? .dark : .light)
        }
    }
}

private struct ProbeRoot: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            AgentContentColumn(rowNavigation: .push)
        }
        .toastHost()
        .task {
            // What the launch landing does once the workspace list is in: open the one workspace.
            await app.agents?.load()
            app.selectedAgentID = "a1"
        }
    }
}
