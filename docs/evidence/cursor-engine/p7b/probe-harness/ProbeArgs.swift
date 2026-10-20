import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens — `-probe.surface settings` (Settings, as
// the drawer's gear leaves it; the test taps Infrastructure — or, with `-probe.machine <runner>` and maybe
// `-probe.engine <engine>`, straight on that machine's page or its engine's, as a link into Settings opens
// them), `compose` (a new session for `-probe.agent`) or `console` (session `-probe.session`). `-dark` for
// dark.
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
        await model.runners?.load()
        model.selectedAgentID = value("-probe.agent") ?? "a1"
        switch value("-probe.surface") ?? "settings" {
        case "compose":
            model.startComposingSession()
        case "console":
            model.route(to: .session(value("-probe.session") ?? "C1"))
        default:
            // The window has to be up before a sheet goes over it: presented in a launch's first moments,
            // the sheet was dropped while the flag stayed set (the first CI run, 39166881682).
            try? await Task.sleep(for: .seconds(1.5))
            model.settingsPresented = true
            guard let machine = value("-probe.machine") else { return }
            try? await Task.sleep(for: .seconds(0.8))
            model.nav.settingsPath = [.settingsPage(.infrastructure), .runnerDetail(runnerID: machine)]
                + (value("-probe.engine").map { [.runnerEngine(runnerID: machine, engine: $0)] } ?? [])
        }
    }
}
