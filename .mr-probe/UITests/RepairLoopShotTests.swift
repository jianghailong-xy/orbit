import XCTest

// TEMPORARY evidence probe (see ../README.md). For each frame of the board (docs/mocks/
// merge-recovery-repair-loop-ios.html) — the repair row's six states and the check after a repair — open
// that conversation, press the merge recovery's row on the branch bar, and photograph the review sheet in
// light and in dark. What a frame must say (and must not) is asserted: a run that never reached a state
// fails rather than photographing something else.
final class RepairLoopShotTests: ProbeCase {
    struct Frame {
        let session: String
        let name: String
        /// The recovery's title: the branch bar's row that opens the review.
        let bar: String
        let shows: [String]
        var absent: [String] = []
        /// Words a footnote starts with that must be drawn whole: taller than one line (the sentence can't
        /// fit on one). The tree reports a cut text's whole string, so only its height tells.
        var wraps: String? = nil
    }

    static let frames: [Frame] = [
        Frame(session: "S1", name: "1-running", bar: "Your changes conflict with the synchronized target",
              shows: ["Repair session running", "解决 main 分支合并恢复", "Tap to open the running session",
                      "Checked 14m ago", "Conflicts", "Open repair session", "Orbit checks again when the repair stops."],
              absent: ["Check again", "Prepare PR candidate", "Resolve in repair session"]),
        Frame(session: "S2", name: "2-checking", bar: "Your changes conflict with the synchronized target",
              shows: ["Checking the repair…", "Repair session finished", "Checking its result…", "Checking…"],
              absent: ["Check again", "Prepare PR candidate", "Checked 14m ago"]),
        Frame(session: "S3", name: "3-ready", bar: "Review synchronization into main",
              shows: ["Repair session finished", "Checked just now — ready to merge", "Check again",
                      "Pushes to origin/main", "Sync main and merge", "Prepare PR candidate"]),
        Frame(session: "S4", name: "4-conflict-left", bar: "main synchronization has conflicts",
              shows: ["Repair session finished", "Checked just now — 1 conflict left", "Check again",
                      "origin/main moved after the repair. The repair was kept; only this file conflicts with the new commits.",
                      "Continue repair", "Prepare PR candidate"],
              absent: ["Resolve in repair session"], wraps: "origin/main moved after the repair."),
        Frame(session: "S9", name: "4b-conflicts-left-plural", bar: "main synchronization has conflicts",
              shows: ["Checked just now — 2 conflicts left",
                      "origin/main moved after the repair. The repair was kept; only these files conflict with the new commits.",
                      "Continue repair", "Prepare PR candidate"],
              absent: ["Resolve in repair session"], wraps: "origin/main moved after the repair."),
        Frame(session: "S5", name: "5-needs-reply", bar: "The repair isn’t finished",
              shows: ["Repair session needs your reply", "“Keep the target’s version?” · 2m ago",
                      "Some files in the repair worktree are still unresolved.", "Still unresolved", "Check again",
                      "Reply in repair session"],
              absent: ["main needs synchronization", "Prepare PR candidate"]),
        Frame(session: "S6", name: "6-already-landed", bar: "Already on origin/main",
              shows: ["This session’s changes reached origin/main on Oct 11. Nothing is left to merge.",
                      "On origin/main", "Merged Oct 11", "Matched by content — this branch was rewritten after these merged.",
                      "Local main’s own 2 commits aren’t part of this session.", "Done"],
              absent: ["Repair session", "Check again", "Conflicts"]),
        Frame(session: "S7", name: "7-failed", bar: "Your changes conflict with the synchronized target",
              shows: ["Repair session failed", "The model provider rejected the request", "Check again",
                      "Resolve in repair session", "Prepare PR candidate"],
              absent: ["Continue repair"]),
        // The coordinator's ruling: a failed repair keeps its row while the server checks, and Checking… is the step.
        Frame(session: "S8", name: "8-failed-checking", bar: "Your changes conflict with the synchronized target",
              shows: ["Checking the repair…", "Repair session failed", "The model provider rejected the request",
                      "Checking…"],
              absent: ["Check again", "Resolve in repair session", "Prepare PR candidate", "Checking its result…"]),
    ]

    func testTheRepairLoopFramesLight() { for frame in Self.frames { take(frame, dark: false) } }

    func testTheRepairLoopFramesDark() { for frame in Self.frames { take(frame, dark: true) } }

    private func take(_ frame: Frame, dark: Bool) {
        let name = "\(frame.name)-\(dark ? "dark" : "light")"
        let app = launch(session: frame.session, dark: dark, until: frame.bar, name)
        defer { app.terminate() }
        let row = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", frame.bar)).firstMatch
        press(row.exists ? row : element(app, containing: frame.bar))
        guard appears(app, frame.shows[0], timeout: 20) else {
            write(app.debugDescription, "no-sheet-\(name).txt")
            shot(app, name)
            XCTFail("\(name): the review never showed \(frame.shows[0])")
            return
        }
        settle(1.5)
        for words in frame.shows where !element(app, containing: words).exists {
            XCTFail("\(name): \(words) is not on the review")
        }
        for words in frame.absent where element(app, containing: words).exists {
            XCTFail("\(name): \(words) is on the review and should not be")
        }
        if let wraps = frame.wraps {
            let text = element(app, containing: wraps)
            let height = text.exists ? text.frame.height : 0
            note("\(name): the footnote is \(height) pt tall")
            if height < 22 { XCTFail("\(name): the footnote is cut to one line (\(height) pt tall)") }
        }
        shot(app, name)
        write(app.debugDescription, "tree-\(name).txt")
        note("\(name): photographed")
    }
}
