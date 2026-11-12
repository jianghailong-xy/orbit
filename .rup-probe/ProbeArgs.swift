import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (never merged): where one launch opens. `-probe.session <id>` routes into
// that session's console; without it the launch stays on the workspace's session list.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Each fresh launch starts from what the stub serves, not from lists cached on disk.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        // The queued gate rides the Open list's rows only: read the list before the console opens.
        await model.loadSessions()
        let session = value("-probe.session")
        // The shell restores its own landing as it comes up, so the walk is repeated with a gap.
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            if let session {
                model.route(to: .session(session))
            } else {
                model.openAgent("a1")
            }
        }
    }
}
