import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): the account a launch shows, and where it opens.
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account as the app reads it once signed in (`GET /users/me` from the stub), then — on the
    /// iPhone — Settings opened over the shell, as the drawer's gear opens it.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        #if os(iOS)
        try? await Task.sleep(for: .seconds(1))
        model.settingsPresented = true
        #endif
    }
}
