import SwiftUI
import OrbitKit

// TEMPORARY evidence probe: where one launch opens — the session list, or one conversation with
// `-probe.session <id>`.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Each fresh launch starts from what the stub serves, not from a transcript cached on disk by an
    /// earlier launch (Application Support/Orbit, ConsoleRegistry.defaultStore).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        model.selectedAgentID = value("-probe.agent") ?? "a1"
        model.selectedSection = .agents
        // No session named: the workspace's session list, where the project row is.
        if let session = value("-probe.session") { model.route(to: .session(session)) }
    }
}
