import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where a launch opens.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account and its workspace as the app reads them once signed in, then one of the stub's
    /// sessions — the run that never started, opened the way a notification opens it.
    @MainActor
    static func land(_ model: AppModel, session: String = "S1") async {
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-probe.log"),
           ProcessInfo.processInfo.arguments.count > i + 1 {
            let path = ProcessInfo.processInfo.arguments[i + 1]
            try? "land: base=\(String(describing: model.baseURL)) session=\(session)\n"
                .write(toFile: path, atomically: true, encoding: .utf8)
        }
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        // The shell restores its own landing (the last section and stack) as it comes up, so the
        // route is walked twice with a gap: the second one lands on a shell that has finished.
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            // The route needs a section and an agent to land in: the sessions section is the one a
            // session lives in, and the console is drawn for the agent whose list holds it.
            model.selectedSection = .agents
            model.selectedAgentID = model.agents?.items.first(where: { $0.id == "a1" })?.id
                ?? model.agents?.items.first?.id
            model.route(to: .session(session))
        }
    }

    /// The same, on a project's page — for the SOURCE_UNRESOLVED card.
    @MainActor
    static func landOnProject(_ model: AppModel, _ id: String = "P1") async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        try? await Task.sleep(for: .seconds(1))
        model.openProject(id)
    }
}
