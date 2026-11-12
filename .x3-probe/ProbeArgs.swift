import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch lands. `-probe.settings` opens Settings on its Sessions
// page (iPhone) or the Settings section (Mac); otherwise one conversation, `-probe.session <id>`.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }
    static var settings: Bool { ProcessInfo.processInfo.arguments.contains("-probe.settings") }

    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account as the app reads it once signed in (its translation switch and whether the server can translate),
    /// then the landing, repeated with a gap: the shell restores its own landing as it comes up.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        model.selectedAgentID = value("-probe.agent") ?? "a1"
        for _ in 0..<3 {
            if settings {
                #if os(iOS)
                model.selectedSection = .agents
                model.nav.openSettings(at: .sessions)
                #else
                model.selectedSection = .settings
                #endif
            } else {
                model.route(to: .session(value("-probe.session") ?? "T1"))
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}
