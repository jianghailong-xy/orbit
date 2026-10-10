import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): the iOS app's own shells, as `RootView` picks them —
// `MainView`'s three columns at regular width (an iPad), `CompactShell` at compact width — signed in
// to the fixture API `stub.py` serves (`-orbit.instance http://127.0.0.1:8765`), opened at one place
// per launch:
//   -probe.scene list    workspace orbit's sessions beside the conversation S1 (the default)
//   -probe.scene engine  Infrastructure: Mac Studio's record with its Claude Code page over it
//   -probe.sidebar 1|0   the sidebar column shown or hidden at launch (`shell.sidebarVisible`)
@main
struct IpadProbeApp: App {
    @State private var model: AppModel

    init() {
        ProbeArgs.prepare()
        _model = State(initialValue: AppModel())
    }

    var body: some Scene {
        WindowGroup {
            ProbeRoot()
                .environment(model)
                .preferredColorScheme(.light)
        }
    }
}

/// `RootView`'s signed-in branch (it is private to the excluded `OrbitiOSApp.swift`).
private struct ProbeRoot: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var hSize

    var body: some View {
        Group {
            if hSize == .compact { CompactShell() } else { MainView() }
        }
        .sessionSearchSheet(model)
        .settingsSheet(model)
        .task { await ProbeArgs.land(model) }
    }
}

enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Before the model exists: start from what the stub serves rather than from a transcript or launch
    /// snapshot an earlier launch left on disk, and seed the sidebar the way the last session left it.
    static func prepare() {
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
        }
        if let sidebar = value("-probe.sidebar") {
            UserDefaults.standard.set(sidebar == "1", forKey: "shell.sidebarVisible")
        }
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        model.selectedAgentID = "a1"
        switch value("-probe.scene") ?? "list" {
        case "engine":
            await model.runners?.load()
            model.openRunnerEngine("mac", engine: "claude")
        default:
            model.route(to: .session("S1"))
        }
    }
}
