import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens. `-probe.engine <engine>` opens
// Settings on HPC's page for that engine; `-probe.engine runner` on the machine's own page.
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

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        await model.runners?.load()
        model.settingsPresented = true
        guard let engine = value("-probe.engine") else { return }
        try? await Task.sleep(for: .seconds(0.8))
        model.nav.settingsPath = engine == "runner"
            ? [.runnerDetail(runnerID: "hpc")]
            : [.runnerDetail(runnerID: "hpc"), .runnerEngine(runnerID: "hpc", engine: engine)]
    }
}
