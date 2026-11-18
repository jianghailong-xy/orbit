import XCTest

// TEMPORARY evidence probe (never merged): the condition-triggers board's frames 2 to 6 (docs/mocks/condition-
// triggers/01-board.png) on the iPhone app, against .ct-probe/stub.py (task 34yx4AFSjXkHqMNOEbzci). One launch per
// surface; each checks the board's words on screen, then photographs it. A word the board draws that the screen does
// not show is a failure, and the picture is kept anyway.
final class ConditionShotTests: ProbeCase {
    /// Each of `lines` shows; a missing one fails the test and is noted.
    private func expect(_ app: XCUIApplication, _ lines: [String], _ name: String, timeout: TimeInterval = 8) {
        for line in lines {
            let shown = appears(app, line, timeout: timeout)
            note("\(name): \(line) \(shown ? "shown" : "MISSING")")
            if !shown { XCTFail("\(name): \(line) is not on screen") }
        }
    }

    /// Frame 4: the Scheduled page's "Waiting for a condition" group above Today, each row's newest reading and its
    /// age, the gauge, and the condition that cannot be read under Needs you.
    func test4ScheduledPage() {
        let app = launch("scheduled", until: "Waiting for a condition", "scheduled")
        expect(app, ["Needs you", "Mon disk guard", "Can't read", "When root disk below 5%",
                     "Ceph capacity guard", "When raw used above 90%", "6.9%", "1 min ago",
                     "Set kubernetes pool to 3 copies", "Task · once, when 3 or more OSDs are in · HPC", "2 in",
                     "3 min ago", "Today"], "scheduled")
        let group = containing(app, "Waiting for a condition")
        let today = text(app, "Today")
        if group.exists, today.exists {
            note("group at \(group.frame.minY), Today at \(today.frame.minY)")
            XCTAssertLessThan(group.frame.minY, today.frame.minY, "Waiting for a condition sits above Today")
        }
        tree(app, "scheduled")
        shot("ios-4-scheduled")
        app.terminate()
    }

    /// Frame 6, its lower half: the inspector's Condition block (reading, age, the bar, the firing and re-arm line),
    /// How it checks (interval, runner, command, approval) and the Fired / Ready again lines in its history.
    func test6Inspector() {
        let app = launch("inspector", until: "Fires above 90% for 10 min. Ready again below 85%.", "inspector")
        expect(app, ["CONDITION", "6.9%", "checked 1 min ago", "HOW IT CHECKS",
                     "Every 5 min on workstation-gpu, without a model.",
                     "ceph df -f json | jq .stats.total_used_raw_ratio", "Read-only. Approved by you on "],
               "inspector")
        tree(app, "inspector")
        shot("ios-6b-inspector")
        let ready = containing(app, "Ready again · 82.9%")
        bring(app, ready, between: 120, and: 700, missingIsAbove: false, "inspector-history")
        expect(app, ["HISTORY", "Ready again · 82.9%", "Fired · 90.4% for 10 min", "Run of ", "Created"],
               "inspector-history")
        tree(app, "inspector-history")
        shot("ios-6c-inspector-history")
        app.terminate()
    }

    /// Frame 6, its upper half: Waiting on you with the can't-read card, and the 30-day question.
    func test6WaitingOnYou() {
        let app = launch("inbox", until: "Can't read: Root disk below 5%", "inbox")
        expect(app, ["Condition", "The check timed out 3 times in a row.", "Pause", "Look into it",
                     "Still waiting for 3 or more OSDs are in. Keep waiting?", "Keep waiting", "Stop"], "inbox")
        tree(app, "inbox")
        shot("ios-6a-waiting-on-you")
        app.terminate()
    }

    /// Frame 2: the task create card with Starts when (the condition, how it is checked, the command), Today and If
    /// never.
    func test2TaskCreateCard() {
        let app = launch("console", session: "S-pool", until: "Create task that starts on a condition?", "task-card")
        let ifNever = containing(app, "Asks you after 30 days of waiting")
        bring(app, ifNever, between: 140, and: 640, missingIsAbove: false, "task-card")
        expect(app, ["Set kubernetes pool to 3 copies", "Starts when", "3 or more OSDs are in",
                     "Once. Checked every 5 min on workstation-gpu, no model.",
                     "ceph osd stat -f json | jq .num_in_osds", "Today", "2 in. Not yet.", "If never",
                     "Asks you after 30 days of waiting"], "task-card")
        tree(app, "task-card")
        shot("ios-2-task-card")
        app.terminate()
    }

    /// Frame 3: the schedule create card with its When lines and the command.
    func test3ScheduleCreateCard() {
        let app = launch("console", session: "S-cap", until: "Create scheduled task?", "schedule-card")
        let notice = containing(app, "You'll hear when it crosses 90%")
        bring(app, notice, between: 140, and: 640, missingIsAbove: false, "schedule-card")
        expect(app, ["Ceph capacity guard", "Raw used above 90%", " for 10 min",
                     "Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model.",
                     "ceph df -f json | jq .stats.total_used_raw_ratio", "6.9%. Nothing to report.", "HPC · Claude agent",
                     "Up to ", "3 runs a week"], "schedule-card")
        tree(app, "schedule-card")
        shot("ios-3-schedule-card")
        app.terminate()
    }

    /// The widen card for a changed command: both commands verbatim, Keep the approved command, Allow.
    func test3WidenCard() {
        let app = launch("console", session: "S-cmd", until: "check with a new command?", "widen-card")
        let keep = containing(app, "Keep the approved command")
        bring(app, keep, between: 140, and: 640, missingIsAbove: false, "widen-card")
        expect(app, ["Let Ceph capacity guard check with a new command?",
                     "ceph df -f json | jq .stats.total_used_raw_ratio", ".stats.total_used_raw_bytes",
                     "Keep the approved command", "Allow", "Read it before you allow it."], "widen-card")
        tree(app, "widen-card")
        shot("ios-3b-widen-card")
        app.terminate()
    }

    /// Frame 5: a run its condition started names the firing in its header, not a planned time.
    func test5RunHeader() {
        let app = launch("run", until: "Fired 03:12", "run")
        expect(app, ["Ceph capacity guard", "Run of ", "Fired 03:12 · 90.4% for 10 min · Check only"], "run")
        let planned = containing(app, "Scheduled run · planned")
        note("run: the planned-time strip is \(planned.exists ? "STILL SHOWN" : "gone")")
        XCTAssertFalse(planned.exists, "the firing replaces the planned time")
        tree(app, "run")
        shot("ios-5-run")
        app.terminate()
    }

    /// Tasks: the waiting line on a task that starts when its condition holds.
    func test7TaskWaitingLine() {
        let app = launch("task", until: "Waiting for: 3 or more OSDs are in", "task")
        expect(app, ["Set kubernetes pool to 3 copies", "2 in · 3 min ago"], "task")
        tree(app, "task")
        shot("ios-7-task-waiting-line")
        app.terminate()
    }
}
