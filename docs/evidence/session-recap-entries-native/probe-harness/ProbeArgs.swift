import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where a launch opens, and which account the app reads.
enum ProbeArgs {
    /// The page one launch photographs (`-probe.page <name>`):
    ///   chat      S1's conversation — the chat page, whose top carries the recap
    ///   list      the workspace's session list, where P1 is one row in its coordinator's place (iPhone)
    ///   sessions  P1's sessions page, the rows a project's sessions are entered from (iPhone)
    ///   project   P1's page, whose coordinator card opens the coordinator's conversation
    static var page: String { value("-probe.page") ?? "chat" }

    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// Each fresh launch starts from what the stub serves, not from lists or transcripts cached on
    /// disk by an earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account as the app reads it once signed in — `me` is where the Session recaps switch
    /// comes from (`UserPreferences.showRecaps`), and the stub's `--recaps-off` pass is exactly this
    /// read answering `recaps: false` — then the page `-probe.page` names. The walk is repeated with
    /// a gap, because the shell restores its own landing (the last section and stack) as it comes
    /// up: the later walks land on a shell that has finished.
    @MainActor
    static func land(_ model: AppModel) async {
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        for attempt in 0..<3 {
            try? await Task.sleep(for: .seconds(attempt == 0 ? 2 : 3))
            switch page {
            case "list":
                // The sidebar row's own press; the sessions load off the column's own `.task`.
                model.openAgent("a1")
            #if os(iOS)
            case "sessions":
                // The drawer's project row: P1's sessions page as the stack's root, over the
                // workspace of its coordinator (`AppModel.openProjectSessions`). iOS only — the Mac
                // has no project sessions page, and the drawer is AppModel's iOS block.
                model.openDrawerDestination(.project(projectID: "P1"), inColumn: false)
            #endif
            case "project":
                // P1's page, as a link, a notification or ⌘K puts it on screen.
                model.openProject("P1")
            default:
                model.selectedAgentID = "a1"
                model.route(to: .session("S1"))
            }
        }
    }
}
