import SwiftUI
import OrbitKit

// TEMPORARY evidence probe: where one launch opens — the workspace's session list (`-probe.list`), or one
// conversation (`-probe.session <id>`), routed twice 2 s apart because the shell restores its own landing.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        for _ in 0..<2 {
            if let session = value("-probe.session") {
                model.selectedAgentID = "a1"
                model.route(to: .session(session))
            } else {
                model.openAgent("a1")
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}
