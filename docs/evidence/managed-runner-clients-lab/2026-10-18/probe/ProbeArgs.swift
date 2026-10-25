import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens. The scene being replayed names the
// workspace and the session (the test server's own public ids), and the test passes them here.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Each launch starts from what the replay serves, not from a transcript cached on disk by an
    /// earlier launch (Application Support/Orbit, ConsoleRegistry.defaultStore).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// `compose`: the New Session draft of the workspace `-probe.agent`; `console`: the conversation
    /// `-probe.session`; `home`: wherever the app lands by itself.
    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        switch value("-probe.surface") ?? "compose" {
        case "home":
            break
        case "console":
            if let agent = value("-probe.agent") { model.selectedAgentID = agent }
            if let session = value("-probe.session") { model.route(to: .session(session)) }
        default:
            if let agent = value("-probe.agent") { model.selectedAgentID = agent }
            model.startComposingSession()
        }
    }
}
