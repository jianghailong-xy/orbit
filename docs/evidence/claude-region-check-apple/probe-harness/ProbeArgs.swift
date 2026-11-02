import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens. `-probe.session S1` opens that conversation's
// console, as a session link does; `-probe.list` the workspace's session list; `-probe.machine runner` HPC's page
// in Settings, `-probe.machine claude` its Claude Code page.
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Each fresh launch starts from what the stub serves, not from what an earlier launch left on disk
    /// (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The agents, then the place — routed twice, 2 s apart, because the shell restores its own landing as it
    /// comes up (the Settings-order probe's note).
    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        if let session = value("-probe.session") {
            model.selectedAgentID = "a1"
            for _ in 0..<2 {
                model.route(to: .session(session))
                try? await Task.sleep(for: .seconds(2))
            }
        } else if value("-probe.list") != nil {
            for _ in 0..<2 {
                model.openAgent("a1")
                try? await Task.sleep(for: .seconds(2))
            }
        } else if let page = value("-probe.machine") {
            await model.runners?.load()
            for _ in 0..<2 {
                model.settingsPresented = true
                try? await Task.sleep(for: .seconds(1))
                model.nav.settingsPath = page == "runner"
                    ? [.runnerDetail(runnerID: "hpc")]
                    : [.runnerDetail(runnerID: "hpc"), .runnerEngine(runnerID: "hpc", engine: page)]
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}
