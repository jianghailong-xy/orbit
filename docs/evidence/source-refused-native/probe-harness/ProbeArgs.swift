import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (GitHub workspaces P3): where a launch opens.
enum ProbeArgs {
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    static func arg(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: name), args.count > i + 1 else { return nil }
        return args[i + 1]
    }

    /// `-probe.machine <id>`: the machine's new session page (the setup card); `-probe.settings`: Settings → GitHub;
    /// otherwise `-probe.session <id>`: a conversation.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        await model.runners?.load()
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            if let machine = arg("-probe.machine") {
                model.openMachineDraft(machine)
            } else if ProcessInfo.processInfo.arguments.contains("-probe.settings") {
                model.showGithubSettings()
            } else {
                let session = arg("-probe.session") ?? "S1"
                model.selectedSection = .agents
                model.selectedAgentID = model.agents?.items.first(where: { $0.id == "w1" })?.id
                model.route(to: .session(session))
            }
        }
    }
}
