import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens — the Wiki section with the document of board 42 ⑤
// on its stack, at its section 3, the way the directory opens a section.
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Each fresh launch starts from what the stub serves, not from anything cached on disk by an earlier launch.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// Twice, 2 s apart: a launch-time restore of the shell's own state must not leave the probe elsewhere.
    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        for round in 0..<2 {
            if round > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            model.selectedSection = .wiki
            model.nav.path = [.wikiDoc(slug: "session-runtime", section: "s3")]
        }
    }
}
