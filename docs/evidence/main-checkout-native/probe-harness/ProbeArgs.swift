import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (task 34vZvzdK0NZaSo0JNQ2ES, never merged): where one launch opens —
// one conversation (`-probe.session <id>`), or a workspace's settings form (`-probe.surface form -probe.agent <id>`).
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var form: Bool { value("-probe.surface") == "form" }

    /// Each fresh launch starts from what the stub serves, not from a transcript cached on disk.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        _ = await model.loadSessions()
        guard !form else { return }
        model.selectedAgentID = value("-probe.agent") ?? "a1"
        model.route(to: .session(value("-probe.session") ?? "W1"))
    }
}

/// The workspace settings form as the app draws it (AgentFormContent), on its own.
struct ProbeForm: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            if let agents = app.agents, let agent = agents.agent(ProbeArgs.value("-probe.agent") ?? "a1") {
                AgentFormContent(agents: agents, agent: agent)
                    .navigationTitle(agent.name)
            } else {
                ProgressView()
            }
        }
    }
}
