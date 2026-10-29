import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): where a launch opens — a project's page
// (`-probe.project P1`), a conversation (`-probe.session C1`), the workspace's session list
// (`-probe.page list`) or the projects list (`-probe.page projects`) — and in which appearance
// (`-probe.dark`).
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The appearance this launch is photographed in.
    static var scheme: ColorScheme {
        ProcessInfo.processInfo.arguments.contains("-probe.dark") ? .dark : .light
    }

    private static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), args.count > i + 1 else { return nil }
        return args[i + 1]
    }

    /// The account and its workspace as the app reads them once signed in, then the page this launch
    /// photographs. The shell restores its own landing (the last section and stack) as it comes up,
    /// so the route is walked a few times with a gap: the last one lands on a shell that has finished.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            if let session = value("-probe.session") {
                model.selectedSection = .agents
                model.selectedAgentID = "a1"
                model.route(to: .session(session))
            } else if value("-probe.page") == "list" {
                model.selectedSection = .agents
                model.selectedAgentID = "a1"
            } else if value("-probe.page") == "projects" {
                model.selectedSection = .projects
                model.nav.path = []
            } else {
                model.openProject(value("-probe.project") ?? "P1")
            }
        }
    }
}
