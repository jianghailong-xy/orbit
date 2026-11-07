import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (task 34tDf8rxHzhwoGyK6r0kj): where one launch opens — the Wiki section with Review on its
// stack (`-probe.page review`, the page the Activity banner and the drawer's amber number push), or one entry's page
// (`-probe.page entry -probe.entry <id>`, the way `AppModel.openWikiEntry` opens one). The Wiki's spaces are read
// before the page goes up, so it never waits on a spinner for them.
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
        let page = value("-probe.page") ?? "review"
        for round in 0..<2 {
            if round > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            model.selectedSection = .wiki
            await model.wiki?.loadSpaces()
            if page == "entry" {
                let id = value("-probe.entry") ?? ""
                if model.nav.path != [.wikiEntry(entryID: id)] { model.nav.path = [.wikiEntry(entryID: id)] }
            } else {
                if round == 0 { await model.wiki?.loadReview() }
                if model.nav.path != [.wikiReview] { model.nav.path = [.wikiReview] }
            }
        }
    }
}
