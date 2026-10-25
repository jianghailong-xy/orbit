import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens — `-probe.surface settings` (Settings, as
// the drawer's gear leaves it; the test taps Infrastructure), `compose` (a new session for `-probe.agent`)
// or `console` (session `-probe.session`). `-dark` for dark.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Each fresh launch starts from what the stub serves, not from what an earlier launch left on disk
    /// (Application Support/Orbit).
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
        switch value("-probe.surface") ?? "settings" {
        case "compose":
            model.startComposingSession()
        case "console":
            model.route(to: .session(value("-probe.session") ?? "S1"))
        default:
            model.settingsPresented = true
        }
    }
}
