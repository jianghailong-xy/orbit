import SwiftUI
import OrbitKit

// TEMPORARY evidence probe: where one launch opens — Settings → Providers, as the drawer's gear and its
// Providers row would leave it.
enum ProbeArgs {
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
        model.settingsPresented = true
        model.nav.settingsPath = [.settingsPage(.providers)]
    }
}
