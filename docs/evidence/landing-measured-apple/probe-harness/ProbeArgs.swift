import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where a launch opens — `-probe.page` names it:
//   session:C5   the coordinator conversation with the start request (①)
//   sessions:P1  the project's sessions page (②)
//   project:P2   the project's page, How it runs (③), and P3 for Coordinator's changes (⑤)
//   task:T1      the exempt task's page (④)
//   landing:L1   its landing's page (④)
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        let page = UserDefaults.standard.string(forKey: "probe.page") ?? "project:P2"
        let parts = page.split(separator: ":").map(String.init)
        let kind = parts.first ?? "project"
        let id = parts.count > 1 ? parts[1] : "P2"
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        // The shell restores its own landing as it comes up: walk the route a few times with a gap,
        // so the last lands on a shell that has finished.
        for attempt in 0..<3 {
            try? await Task.sleep(for: .seconds(attempt == 0 ? 1 : 2))
            switch kind {
            case "session", "landing":
                model.selectedAgentID = "a1"
                model.route(to: .session(id))
            case "sessions":
                model.selectedSection = .agents
                model.selectedAgentID = "a1"
                model.openProjectSessions(SessionProjectAddress(projectID: id, agentID: "a1", view: .open))
            case "task":
                model.route(to: .task(id))
            default:
                model.openProject(id)
                return
            }
        }
    }
}
