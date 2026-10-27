import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see ../README.md): where a launch lands, and which account the app reads.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account as the app reads it once signed in, then Settings — the sheet the drawer's gear
    /// opens (`AppModel.settingsPresented`), at its root. The shell restores its own landing as it
    /// comes up, so the walk is repeated with a gap: the last one lands on a shell that has finished.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            model.selectedSection = .agents
            model.settingsPresented = true
        }
    }
}
