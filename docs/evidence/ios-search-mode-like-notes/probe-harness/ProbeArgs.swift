import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where a launch opens — a conversation, the project's
// coordinator conversation, or the session list.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    private static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), args.count > i + 1 else { return nil }
        return args[i + 1]
    }

    /// The account and its workspace as the app reads them once signed in, then the page this
    /// launch photographs.
    @MainActor
    static func land(_ model: AppModel) async {
        let page = value("-probe.page") ?? "chat"
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        // The shell restores its own landing (the last section and stack) as it comes up, so the
        // route is walked a few times with a gap: the last one lands on a shell that has finished.
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            model.selectedSection = .agents
            model.selectedAgentID = model.agents?.items.first(where: { $0.id == "a1" })?.id
                ?? model.agents?.items.first?.id
            switch page {
            case "list":
                // The workspace's session list: the bar under the nav bar, over the rows.
                break
            case "owner":
                // The project's coordinator conversation, where the owner's X-E5 card is drawn.
                model.route(to: .session("C1"))
            default:
                // An ordinary conversation, while a coordinator elsewhere waits on a question.
                model.route(to: .session("S6"))
            }
        }
    }
}
