import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): the app lands by itself on the account's first workspace, unless this
// launch names a machine's record (`-probe.runner austin`, Settings → Machines & models → the machine). `-probe.dark`
// for dark. Each launch starts from what the stub serves, not from lists cached on disk by an earlier launch.
enum ProbeArgs {
    static func wipe() {
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
        // The shell's own landing runs as it comes up, so a named page follows it.
        try? await Task.sleep(for: .seconds(3))
        if let runner = value("-probe.runner") {
            // Settings → Machines & models → the machine, as a person reaches it.
            model.settingsPresented = true
            model.nav.settingsPath = [.settingsPage(.machines), .runnerDetail(runnerID: runner)]
        }
    }
}
