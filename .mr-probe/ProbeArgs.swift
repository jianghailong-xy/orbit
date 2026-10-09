import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Each fresh launch starts from what the stub serves, not from a transcript cached on disk by an
    /// earlier launch (Application Support/Orbit, ConsoleRegistry.defaultStore).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// `compose`: the managed default workspace's New Session draft; `console`: its conversation S1;
    /// `runners`: Infrastructure, where an account with no workspace lands.
    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        switch value("-probe.surface") ?? "compose" {
        case "runners":
            model.selectedSection = .runners
        case "console":
            model.selectedAgentID = "a1"
            model.route(to: .session("S1"))
        default:
            model.selectedAgentID = "a1"
            model.startComposingSession()
        }
    }
}
