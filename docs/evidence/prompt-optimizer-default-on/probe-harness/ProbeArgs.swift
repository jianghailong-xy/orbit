import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): where a launch opens. Prompt optimizer (board
// docs/mocks/prompt-optimizer/01-board.png): Settings for frame 1 / 1b, or conversation C1 with a
// draft already in its composer for frames 2–6 (the Mac composer field is not reliably queryable,
// so the draft is put there rather than typed).
enum ProbeArgs {
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

    @MainActor
    static func land(_ model: AppModel) async {
        let page = value("-probe.page") ?? "chat"
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        _ = await model.loadSessions()
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            model.selectedSection = .agents
            model.selectedAgentID = model.agents?.items.first(where: { $0.id == "a1" })?.id
                ?? model.agents?.items.first?.id
            switch page {
            case "settings":
                // The iPhone test opens Settings from the drawer itself.
                #if os(macOS)
                model.selectedSection = .settings
                #endif
            default:
                model.route(to: .session("C1"))
            }
        }
        if page != "settings", let draft = value("-probe.draft") {
            model.consoleRegistry?.model(for: "C1", agentID: "a1").composerText = draft
        }
    }
}
