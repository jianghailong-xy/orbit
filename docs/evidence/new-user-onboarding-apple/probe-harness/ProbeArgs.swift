import SwiftUI
import OrbitKit

// Evidence probe (see README.md): the app lands by itself, as a new account does, unless this launch names a
// page: a workspace's new session draft (`-probe.compose <workspace id>`) or a machine's new session page
// (`-probe.machine austin`). `-probe.dark` for dark.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an earlier launch.
    static func wipeIfFresh() {
        UserDefaults.standard.removeObject(forKey: "orbit.lastAgent")
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    static var scheme: ColorScheme {
        ProcessInfo.processInfo.arguments.contains("-probe.dark") ? .dark : .light
    }

    private static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), args.count > i + 1 else { return nil }
        return args[i + 1]
    }

    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.runners?.load()
        await model.managedRunner?.load()
        // The shell's own landing runs as it comes up, so a named page follows it.
        try? await Task.sleep(for: .seconds(3))
        if let workspace = value("-probe.compose") {
            model.selectedAgentID = workspace
            try? await Task.sleep(for: .seconds(1))
            model.newSessionInCurrentAgent()
        } else if let machine = value("-probe.machine") {
            model.openMachineDraft(machine)
        }
    }
}
