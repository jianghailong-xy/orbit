import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): where a launch opens.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account and its workspace as the app reads them once signed in, then the Agents section
    /// at its root: the workspace's session list, which is the page being photographed.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        try? await Task.sleep(for: .seconds(2))
        model.selectedSection = .agents
        model.selectedAgentID = model.agents?.items.first(where: { $0.id == "a1" })?.id
            ?? model.agents?.items.first?.id
    }
}
