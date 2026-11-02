import SwiftUI
import OrbitKit

// TEMPORARY evidence probe: where one launch opens — the Wiki section with one document on its stack,
// `-probe.slug <slug>`, the way `AppModel.openWikiEntry` opens an entry from outside the Wiki.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

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
        let slug = value("-probe.slug") ?? "diagram-fits"
        for round in 0..<2 {
            if round > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            model.selectedSection = .wiki
            model.nav.path = [.wikiDoc(slug: slug, section: nil)]
        }
    }
}
