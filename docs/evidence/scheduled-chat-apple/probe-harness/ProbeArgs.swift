import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens — the Scheduled section, whose toolbar holds the
// chat's button (board docs/mocks/scheduled-chat/01-board-4.png).
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Each fresh launch starts from what the stub serves, not from anything cached on disk or remembered on the device
    /// by an earlier launch (the chat's open-or-closed is kept in UserDefaults, per account).
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh") else { return }
        if let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
        }
        let defaults = UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("orbit.scheduledChat.") {
            defaults.removeObject(forKey: key)
        }
    }

    /// Twice, 2 s apart: a launch-time restore of the shell's own state must not leave the probe elsewhere.
    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        for round in 0..<2 {
            if round > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
            model.selectedSection = .scheduled
            model.nav.path = []
        }
        // Without XCUITest (a Mac whose testmanagerd cannot be reached): `-probe.inspect <schedule>` selects a row,
        // `-probe.chat YES` presses the chat's button once the page has read its chats, for `screencapture`.
        let defaults = UserDefaults.standard
        if let id = defaults.string(forKey: "probe.inspect") {
            await model.scheduled?.load()
            model.scheduled?.inspectedID = id
        }
        if defaults.bool(forKey: "probe.chat") {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if model.scheduledChat?.presented == false { model.scheduledChat?.toggleScheduled() }
        }
    }
}
