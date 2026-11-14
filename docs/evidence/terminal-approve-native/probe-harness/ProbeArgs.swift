import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where a launch opens.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an earlier launch.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account and its workspace as the app reads them once signed in, then either the Waiting on you inbox
    /// (`-probe.inbox`) — the sheet the drawer's entry and the terminal-login push open — or Settings (`-probe.settings`),
    /// the sheet the drawer's gear opens. Every list in them is the app's own read of the stub.
    @MainActor
    static func land(_ model: AppModel) async {
        let args = ProcessInfo.processInfo.arguments
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        // The shell restores its own landing as it comes up: wait for it before raising a sheet over it.
        try? await Task.sleep(for: .seconds(2))
        if args.contains("-probe.inbox") {
            await model.ownerRequests?.load()
            model.ownerRequests?.tab = .open
            model.ownerRequests?.inboxPresented = true
        } else if args.contains("-probe.settings") {
            model.settingsPresented = true
        }
    }
}
