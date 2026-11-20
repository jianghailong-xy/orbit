import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): where one launch opens, `-probe.surface <name>`:
//   scheduled  the Scheduled page (board frame 4)
//   inspector  the Ceph capacity guard's detail panel over it (frame 6)
//   inbox      Waiting on you (frame 6)
//   console    one conversation, `-probe.session <id>` (frames 2 and 3, the widen card)
//   run        the guard's run, as its history or a push opens it (frame 5)
//   task       the task waiting for a third OSD (Tasks)
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Each fresh launch starts from what the stub serves, not from lists cached on disk by an earlier launch.
    static func wipeIfFresh() {
        guard ProcessInfo.processInfo.arguments.contains("-probe.fresh"),
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return }
        try? FileManager.default.removeItem(at: support.appendingPathComponent("Orbit"))
    }

    @MainActor
    static func land(_ model: AppModel) async {
        await model.agents?.load()
        model.selectedAgentID = value("-probe.agent") ?? "a1"
        // The shell restores its own landing as it comes up: wait for it before moving anywhere.
        try? await Task.sleep(for: .seconds(2))
        switch value("-probe.surface") ?? "scheduled" {
        case "inspector":
            await model.scheduled?.load()
            model.openSchedule("s-guard")
        case "inbox":
            await model.ownerRequests?.load()
            model.ownerRequests?.tab = .open
            model.ownerRequests?.inboxPresented = true
        case "console":
            model.route(to: .session(value("-probe.session") ?? "S-pool"))
        case "run":
            await model.scheduled?.load()
            model.openScheduleRun(sessionID: "S-run", scheduleID: "s-guard")
        case "task":
            model.route(to: .task("t-osd"))
        default:
            model.openSchedule("s-guard")
            model.scheduled?.inspectedID = nil
        }
    }
}
