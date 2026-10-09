import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see NOTES.md): where a launch opens, and which account the app reads.
enum ProbeArgs {
    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an
    /// earlier launch (Application Support/Orbit).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    /// The account and its workspace as the app reads them once signed in, then the WORKSPACE'S
    /// SESSION LIST — the page these pictures are of. Nothing is routed into a session: the recap
    /// line lives on the list's rows, so every further push would be a page the row is not on.
    ///
    /// The account is read here rather than left to the app's own load because `me` is where the
    /// Session recaps switch comes from (`UserPreferences.showRecaps`): the stub's `--recaps-off`
    /// pass is exactly this read answering `recaps: false`, and the row's `recaps:` argument is
    /// then this account's off rather than the default the app would otherwise assume.
    ///
    /// `settings: true` lands on Settings instead — the sheet's root on iOS (the drawer's gear's
    /// own door, `AppModel.settingsPresented`) and the Settings section's middle column on macOS,
    /// which is where the "Session recaps" toggle is drawn.
    @MainActor
    static func land(_ model: AppModel, settings: Bool = false) async {
        if let i = ProcessInfo.processInfo.arguments.firstIndex(of: "-probe.log"),
           ProcessInfo.processInfo.arguments.count > i + 1 {
            let path = ProcessInfo.processInfo.arguments[i + 1]
            try? "land: base=\(String(describing: model.baseURL)) settings=\(settings)\n"
                .write(toFile: path, atomically: true, encoding: .utf8)
        }
        if let base = model.baseURL {
            model.user = try? await APIClient(baseURL: base, tokenStore: InMemoryTokenStore()).me()
        }
        await model.agents?.load()
        // The shell restores its own landing (the last section and stack) as it comes up, so the
        // walk is repeated with a gap: the second one lands on a shell that has finished.
        for _ in 0..<3 {
            try? await Task.sleep(for: .seconds(2))
            // The list needs a section and a workspace to be showing in, not a session: `openAgent`
            // is the sidebar row's own press, and the sessions load off the column's own `.task`
            // (`AgentsModel.loadSessions`) the moment the workspace resolves.
            let id = model.agents?.items.first(where: { $0.id == "a1" })?.id
                ?? model.agents?.items.first?.id
            if let id { model.openAgent(id) } else { model.selectedSection = .agents }
            if settings {
                #if os(iOS)
                // Never a section on iOS: choosing Settings presents the sheet over the section that
                // is showing (the drawer's gear writes this same flag).
                model.settingsPresented = true
                #else
                // macOS keeps Settings as a section whose middle column is the whole form.
                model.selectedSection = .settings
                #endif
            }
        }
    }
}
