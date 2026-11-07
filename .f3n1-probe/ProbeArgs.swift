import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens — `-probe.session F1` opens that
// conversation's console, as a session link does; with no session, the workspace's session list.
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Each fresh launch starts from what the stub serves, not from anything cached on disk.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        model.selectedSection = .agents
        model.selectedAgentID = "a1"
        guard let session = value("-probe.session") else { return }
        model.route(to: .session(session))
    }
}
