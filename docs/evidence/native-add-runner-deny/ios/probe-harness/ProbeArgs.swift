import SwiftUI
import OrbitKit

// Evidence probe (see README.md): where one launch opens — Settings, as the drawer's gear leaves it. The
// test taps Machines & models and then Add Runner, as a person does.
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
        await model.runners?.load()
        // The window has to be up before a sheet goes over it: presented in a launch's first moments, the
        // sheet was dropped while the flag stayed set (the Cursor probe's first CI run, 39166881682).
        try? await Task.sleep(for: .seconds(1.5))
        model.settingsPresented = true
    }
}
