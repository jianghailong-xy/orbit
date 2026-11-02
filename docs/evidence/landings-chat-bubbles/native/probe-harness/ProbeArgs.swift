import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): where a launch opens — the project's sessions page,
// or a landing session's id, which opens the project's Landings window focused on it.
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
        let page = value("-probe.page") ?? "landing"
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
            case "sessions":
                // The project's sessions page with its one Landings row (board 01 b).
                #if os(iOS)
                model.openProjectSessions(SessionProjectAddress(projectID: "P1", agentID: "a1",
                                                                view: .open))
                #endif
            case "window":
                // The project's Landings window as its sessions page's Landings row pushes it.
                #if os(iOS)
                model.openProjectSessions(SessionProjectAddress(projectID: "P1", agentID: "a1",
                                                                view: .open))
                try? await Task.sleep(for: .seconds(1))
                model.push(.landings(projectID: "P1"))
                #endif
            default:
                // A landing session's own id — what every Open landing › and orbit-session: link
                // opens: the project's Landings window, focused on that landing (board 03 f).
                model.route(to: .session("LY1"))
            }
        }
    }
}
