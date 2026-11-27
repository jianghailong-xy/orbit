import Foundation
import XCTest
@testable import OrbitKit

/// The scheduled tasks' display rules (`ScheduleDisplay`) say what the web's say (`src/shared/src/schedule.ts`):
/// these are `schedule.spec.ts`'s cases, input for input, plus the contract's `boardPhrases` in
/// `ScheduleBoardPhraseTests`.
final class ScheduleDisplayTests: XCTestCase {
    // The boards' demo day: Friday Nov 14, 12:19 in Asia/Shanghai (UTC+8, no DST).
    static let tz = "Asia/Shanghai"
    static let now = ScheduleDisplay.parse("2025-11-14T04:19:00.000Z")!

    /// An instant from a Shanghai wall clock, as the server writes it.
    static func sh(_ local: String) -> String {
        let date = ISO8601DateFormatter().date(from: "\(local):00+08:00")!
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }

    private var seq = 0
    private func schedule(title: String? = nil, rule: ScheduleRule = .daily(time: "09:00"),
                          workspaceName: String? = "apiserver", accessLevel: String = "CHECK_ONLY",
                          state: String = "ACTIVE", heldReason: String? = nil, nextDueAt: String? = nil,
                          consecutiveFailures: Int = 0) -> ScheduleView {
        seq += 1
        return ScheduleView(id: "s\(seq)", title: title ?? "Schedule \(seq)", rule: rule, timezone: Self.tz,
                            workspaceId: "w1", workspaceName: workspaceName, accessLevel: accessLevel, state: state,
                            heldReason: heldReason, nextDueAt: nextDueAt, consecutiveFailures: consecutiveFailures)
    }

    private func run(_ s: ScheduleView, _ state: String, _ plannedAt: String) -> ScheduleRunView {
        ScheduleRunView(id: "r-\(s.id)-\(plannedAt)", scheduleId: s.id, plannedAt: plannedAt, state: state,
                        startedAt: plannedAt)
    }

    private func names(_ groups: [ScheduleDisplay.TimelineGroup]) -> [String] {
        groups.map { g in
            let items = g.items.map { item -> String in
                switch item {
                case .schedule(let s, _): return s.title
                case .run(let s, _, _): return s.title
                case .draft(let c, _): return c.title ?? ""
                case .task(let t): return t.title
                }
            }
            return "\(g.title)|\(g.subtitle ?? "nil")|\(items.joined(separator: ","))"
        }
    }

    private let sh = ScheduleDisplayTests.sh

    // MARK: timeline

    func testBoardOneLayout() {
        let sweep = schedule(title: "Nightly pg spec sweep", nextDueAt: sh("2025-11-15T02:00"), consecutiveFailures: 3)
        let audit = schedule(title: "Weekly dependency audit", state: "HELD", heldReason: "AGENT_DISABLED")
        let docs = schedule(title: "Docs link check", nextDueAt: sh("2025-11-15T12:00"))
        let notes = schedule(title: "Release notes draft", nextDueAt: sh("2025-11-14T17:00"))
        let deploy = schedule(title: "Deploy health check", rule: .once(at: "2025-11-14T18:00"),
                              nextDueAt: sh("2025-11-14T18:00"))
        let codex = schedule(title: "Codex stable check", nextDueAt: sh("2025-11-15T09:00"))
        let cost = schedule(title: "Weekly cost report", nextDueAt: sh("2025-11-17T10:00"))
        let csp = schedule(title: "Gateway CSP report digest", state: "PAUSED")
        let gone = schedule(title: "Ended one", state: "ENDED")
        let groups = ScheduleDisplay.timeline(
            schedules: [sweep, audit, docs, notes, deploy, codex, cost, csp, gone],
            runs: [run(docs, "RUNNING", sh("2025-11-14T12:00"))], now: Self.now, timezone: Self.tz)
        // No group of errors (owner 2026-11-19): the failing one is on its day, the held one in Paused.
        XCTAssertEqual(names(groups), [
            "Today|Fri, Nov 14|Docs link check,Release notes draft,Deploy health check",
            "Tomorrow|Sat, Nov 15|Nightly pg spec sweep,Codex stable check,Docs link check",
            "Monday|Nov 17|Weekly cost report",
            "Paused|2|Weekly dependency audit,Gateway CSP report digest",
        ])
        XCTAssertEqual(groups.map(\.key), [.today, .tomorrow, .day, .paused])
        guard case .run = groups[0].items[0] else { return XCTFail("the running run leads Today") }
    }

    func testAFailingScheduleIsTaggedOnItsDayRow() {
        let sweep = schedule(title: "Nightly pg spec sweep", nextDueAt: sh("2025-11-15T02:00"), consecutiveFailures: 3)
        let groups = ScheduleDisplay.timeline(schedules: [sweep], now: Self.now, timezone: Self.tz)
        XCTAssertEqual(names(groups), ["Tomorrow|Sat, Nov 15|Nightly pg spec sweep"])
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(sweep),
                       .init(.failed, .alert, .init(tone: .fail, text: "Failed 3 in a row")))
        XCTAssertEqual(ScheduleDisplay.needsYouCount([sweep]), 1)
    }

    func testARunUnderWayClearsTheFailure() {
        let sweep = schedule(title: "Nightly pg spec sweep", nextDueAt: sh("2025-11-15T02:00"), consecutiveFailures: 2)
        let other = schedule(title: "Other", nextDueAt: sh("2025-11-15T03:00"))
        for state in ["QUEUED", "RUNNING", "AWAITING_APPROVAL"] {
            let runs = [run(sweep, state, sh("2025-11-14T12:00"))]
            XCTAssertEqual(ScheduleDisplay.scheduleCircle(sweep, runs: runs), .init(.open), state)
            XCTAssertFalse(ScheduleDisplay.needsYou(sweep, runs: runs), state)
            XCTAssertEqual(ScheduleDisplay.needsYouCount([sweep, other], runs: runs), 0, state)
        }
        // An ended run, or a run of another schedule, leaves the tag on.
        for runs in [[run(sweep, "FAILED", sh("2025-11-14T02:00"))], [run(other, "RUNNING", sh("2025-11-14T12:00"))]] {
            XCTAssertEqual(ScheduleDisplay.scheduleCircle(sweep, runs: runs).tag?.text, "Failed 2 in a row")
            XCTAssertEqual(ScheduleDisplay.needsYouCount([sweep, other], runs: runs), 1)
        }
        // A held one stays counted with a run under way.
        let held = schedule(state: "HELD", heldReason: "AGENT_DISABLED")
        XCTAssertEqual(ScheduleDisplay.needsYouCount([held], runs: [run(held, "RUNNING", sh("2025-11-14T12:00"))]), 1)
    }

    func testHeldSchedulesLeadPaused() {
        let a = schedule(title: "A paused", state: "PAUSED")
        let z = schedule(title: "Z held", state: "HELD", heldReason: "AGENT_DISABLED")
        let b = schedule(title: "B held", state: "HELD", heldReason: "AGENT_DISABLED")
        let groups = ScheduleDisplay.timeline(schedules: [a, z, b], now: Self.now, timezone: Self.tz)
        XCTAssertEqual(names(groups), ["Paused|3|B held,Z held,A paused"])
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(z).tag, .init(tone: .held, text: "Held"))
    }

    func testSplitsAtLocalMidnight() {
        let late = schedule(title: "Late", nextDueAt: sh("2025-11-14T23:30"))
        let early = schedule(title: "Early", nextDueAt: sh("2025-11-15T00:30"))
        XCTAssertEqual(names(ScheduleDisplay.timeline(schedules: [early, late], now: Self.now, timezone: Self.tz)),
                       ["Today|Fri, Nov 14|Late", "Tomorrow|Sat, Nov 15|Early"])
    }

    func testReadsDaysInTheViewersZone() {
        let late = schedule(title: "Late", nextDueAt: sh("2025-11-14T23:30"))
        let early = schedule(title: "Early", nextDueAt: sh("2025-11-15T00:30"))
        let groups = ScheduleDisplay.timeline(schedules: [early, late], now: Self.now, timezone: "America/Los_Angeles")
        XCTAssertEqual(names(groups), ["Tomorrow|Fri, Nov 14|Late,Early"])
    }

    func testMidnightEdges() {
        let s = schedule(title: "Midnight", nextDueAt: sh("2025-11-15T00:00"))
        let before = ScheduleDisplay.timeline(schedules: [s], now: ScheduleDisplay.parse(sh("2025-11-14T23:59"))!,
                                              timezone: Self.tz)
        XCTAssertEqual(before.map(\.title), ["Tomorrow"])
        let after = ScheduleDisplay.timeline(schedules: [s], now: ScheduleDisplay.parse(sh("2025-11-15T00:00"))!,
                                             timezone: Self.tz)
        XCTAssertEqual(names(after), ["Today|Sat, Nov 15|Midnight"])
    }

    func testTheComingWeekThenLater() {
        let at = { (d: String) in self.schedule(title: d, nextDueAt: self.sh("\(d)T09:00")) }
        let groups = ScheduleDisplay.timeline(
            schedules: [at("2025-11-16"), at("2025-11-17"), at("2025-11-20"), at("2025-11-21"), at("2025-12-01")],
            now: Self.now, timezone: Self.tz)
        XCTAssertEqual(names(groups), [
            "Sunday|Nov 16|2025-11-16", "Monday|Nov 17|2025-11-17", "Thursday|Nov 20|2025-11-20",
            "Later|nil|2025-11-21,2025-12-01",
        ])
    }

    func testOnASundayMondayIsTomorrow() {
        let sunday = ScheduleDisplay.parse(sh("2025-11-16T20:00"))!
        let mon = schedule(title: "Mon", nextDueAt: sh("2025-11-17T09:00"))
        let sat = schedule(title: "Sat", nextDueAt: sh("2025-11-22T09:00"))
        let sun = schedule(title: "Sun", nextDueAt: sh("2025-11-23T09:00"))
        XCTAssertEqual(names(ScheduleDisplay.timeline(schedules: [sun, sat, mon], now: sunday, timezone: Self.tz)),
                       ["Tomorrow|Mon, Nov 17|Mon", "Saturday|Nov 22|Sat", "Later|nil|Sun"])
    }

    func testAcrossAYearEnd() {
        let s = schedule(title: "New year", nextDueAt: sh("2026-01-01T09:00"))
        let groups = ScheduleDisplay.timeline(schedules: [s], now: ScheduleDisplay.parse(sh("2025-12-31T22:00"))!,
                                              timezone: Self.tz)
        XCTAssertEqual(groups.map { "\($0.title)|\($0.subtitle ?? "")" }, ["Tomorrow|Thu, Jan 1"])
    }

    func testASlotAlreadyDueIsToday() {
        let s = schedule(title: "Due", nextDueAt: sh("2025-11-13T09:00"))
        XCTAssertEqual(ScheduleDisplay.timeline(schedules: [s], now: Self.now, timezone: Self.tz).map(\.title), ["Today"])
    }

    func testPastRunsOnlyWithShowPastRunsAndOnlyToday() {
        let s = schedule(title: "Codex stable check", nextDueAt: sh("2025-11-15T09:00"))
        let runs = [run(s, "CHANGED", sh("2025-11-14T10:00")), run(s, "NO_CHANGE", sh("2025-11-13T10:00"))]
        XCTAssertEqual(ScheduleDisplay.timeline(schedules: [s], runs: runs, now: Self.now, timezone: Self.tz).map(\.title),
                       ["Tomorrow"])
        let shown = ScheduleDisplay.timeline(schedules: [s], runs: runs, showPastRuns: true, now: Self.now,
                                             timezone: Self.tz)
        XCTAssertEqual(names(shown), ["Today|Fri, Nov 14|Codex stable check", "Tomorrow|Sat, Nov 15|Codex stable check"])
        guard case .run(_, let r, _) = shown[0].items[0] else { return XCTFail("a run") }
        XCTAssertEqual(r.state, "CHANGED")
    }

    func testADraftOnTheDayOfItsFirstRun() {
        let card = ScheduleCard(id: "c1", kind: "CREATE", title: "Weekday issue summary",
                                when: ScheduleCardWhen(rule: .weekly(time: "09:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"]),
                                                       timezone: Self.tz, firstRunAt: sh("2025-11-17T09:00")))
        let cost = schedule(title: "Weekly cost report", nextDueAt: sh("2025-11-17T10:00"))
        XCTAssertEqual(names(ScheduleDisplay.timeline(schedules: [cost], drafts: [card], now: Self.now, timezone: Self.tz)),
                       ["Monday|Nov 17|Weekday issue summary,Weekly cost report"])
    }

    // MARK: circles

    func testEveryRunStateHasACircle() {
        let expected: [String: (ScheduleDisplay.Circle, ScheduleDisplay.Mark?, String?)] = [
            "QUEUED": (.open, .clock, nil), "RUNNING": (.running, nil, nil),
            "AWAITING_APPROVAL": (.held, .alert, "Waiting for you"), "NO_CHANGE": (.done, .check, "No change"),
            "CHANGED": (.done, .check, "Known"), "FAILED": (.failed, .alert, "Failed"),
            "SKIPPED": (.muted, .check, "Skipped"), "MISSED": (.muted, .check, "Missed"),
            "HELD": (.held, .alert, "Held"), "CANCELLED": (.muted, .check, "Cancelled"),
        ]
        for (state, want) in expected {
            let v = ScheduleDisplay.runCircle(state: state)
            XCTAssertEqual(v.circle, want.0, state)
            XCTAssertEqual(v.mark, want.1, state)
            XCTAssertEqual(v.tag?.text, want.2, state)
        }
        XCTAssertEqual(ScheduleDisplay.runCircle(state: "CHANGED", newFinding: true),
                       .init(.new, .check, .init(tone: .new, text: "New")))
    }

    func testEveryScheduleStateHasACircle() {
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "ACTIVE", consecutiveFailures: 0).circle, .open)
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "ACTIVE", consecutiveFailures: 3),
                       .init(.failed, .alert, .init(tone: .fail, text: "Failed 3 in a row")))
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "ACTIVE", consecutiveFailures: 1).tag?.text, "Failed")
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "HELD", consecutiveFailures: 0).tag,
                       .init(tone: .held, text: "Held"))
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "PAUSED", consecutiveFailures: 0).circle, .paused)
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "ENDED", consecutiveFailures: 0).circle, .muted)
        XCTAssertEqual(ScheduleDisplay.scheduleCircle(state: "ACTIVE", consecutiveFailures: 0, draft: true).circle, .draft)
        XCTAssertFalse(ScheduleDisplay.needsYou(state: "PAUSED", consecutiveFailures: 2))
        // The drawer's number: failing or held, nothing else.
        XCTAssertEqual(ScheduleDisplay.needsYouCount([
            schedule(consecutiveFailures: 2), schedule(state: "HELD"), schedule(state: "PAUSED"), schedule(),
        ]), 2)
    }

    // MARK: lines

    func testRowLinesReadLikeBoardOne() {
        func line(_ s: ScheduleView, agent: String? = nil, pausedAt: String? = nil, running: Int? = nil,
                  draft: Bool = false) -> String {
            ScheduleDisplay.rowLine(rule: s.rule, workspaceName: s.workspaceName, accessLevel: s.accessLevel,
                                    state: s.state, heldReason: s.heldReason, agentName: agent,
                                    pausedAt: pausedAt.flatMap(ScheduleDisplay.parse), timezone: Self.tz,
                                    runningMinutes: running, draft: draft)
        }
        XCTAssertEqual(line(schedule(rule: .daily(time: "02:00"))), "Every day at 02:00 · apiserver · Check only")
        XCTAssertEqual(line(schedule(rule: .weekly(time: "17:00", weekdays: ["FRI"]), workspaceName: "Orbit baseline",
                                     accessLevel: "OPEN_PR")),
                       "Every Friday at 17:00 · Orbit baseline · Open a PR")
        XCTAssertEqual(line(schedule(rule: .once(at: "2025-11-14T18:00"))), "Once · apiserver · Check only")
        XCTAssertEqual(line(schedule(rule: .weekly(time: "09:00", weekdays: ["MON"]), workspaceName: "web",
                                     state: "HELD", heldReason: "AGENT_DISABLED"), agent: "auditor"),
                       "Every Monday at 09:00 · web · the agent \"auditor\" is disabled")
        XCTAssertEqual(line(schedule(rule: .daily(time: "12:00"), workspaceName: "web"), running: 21),
                       "Every day at 12:00 · web · Check only · running for 21 min")
        XCTAssertEqual(line(schedule(rule: .daily(time: "08:00"), workspaceName: "web", state: "PAUSED"),
                            pausedAt: sh("2025-11-07T15:00")),
                       "Every day at 08:00 · web · paused Nov 7")
        XCTAssertEqual(line(schedule(rule: .weekly(time: "09:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"])), draft: true),
                       "Weekdays at 09:00 · apiserver · Check only · draft, waiting for you")
    }

    func testLandMayCopy() {
        XCTAssertEqual(ScheduleDisplay.mayText("LAND"), "Edit and land on main · edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.")
        XCTAssertEqual(ScheduleDisplay.accessOrder["LAND"], 2)
    }

    func testPastRunLines() {
        XCTAssertEqual(ScheduleDisplay.runLine(state: "FAILED", summary: nil, failureReason: "NO_REPORT", reasonText: nil),
                       "Ended without a report")
        XCTAssertEqual(ScheduleDisplay.runLine(state: "CHANGED", summary: "2.1.310 is out", failureReason: nil,
                                               reasonText: nil, notified: true),
                       "2.1.310 is out · you were notified")
        XCTAssertEqual(ScheduleDisplay.runLine(state: "CHANGED", summary: "0.49.0 again · linked PR #831",
                                               failureReason: nil, reasonText: nil),
                       "0.49.0 again · linked PR #831 · not notified")
        XCTAssertEqual(ScheduleDisplay.runLine(state: "MISSED", summary: nil, failureReason: "OVER_BUDGET",
                                               reasonText: "Over budget: 7 of 7 runs this week"),
                       "Over budget: 7 of 7 runs this week")
        // A reported failure says what the run reported, as its Waiting card and push do (W3, schedule.spec.ts).
        XCTAssertEqual(ScheduleDisplay.runLine(state: "FAILED", summary: "The releases page returned 503.",
                                               failureReason: "REPORTED_FAILED", reasonText: nil),
                       "Reported a failure: The releases page returned 503")
        XCTAssertEqual(ScheduleDisplay.runLine(state: "FAILED", summary: nil, failureReason: "REPORTED_FAILED",
                                               reasonText: nil),
                       "Reported a failure")
    }

    func testWhen() {
        func when(_ local: String) -> String {
            ScheduleDisplay.whenText(ScheduleDisplay.parse(sh(local))!, now: Self.now, timezone: Self.tz)
        }
        XCTAssertEqual(when("2025-11-14T02:00"), "Today 02:00")
        XCTAssertEqual(when("2025-11-15T09:00"), "Tomorrow 09:00")
        XCTAssertEqual(when("2025-11-17T09:00"), "Monday 09:00")
        XCTAssertEqual(when("2025-11-24T09:00"), "Nov 24 09:00")
    }

    // MARK: cards

    func testCreateCardWhen() {
        let when = ScheduleDisplay.createWhen(ScheduleCardWhen(rule: .daily(time: "10:00"), timezone: Self.tz,
                                                               firstRunAt: sh("2025-11-15T10:00")),
                                              now: Self.now, viewerTimezone: Self.tz)
        XCTAssertEqual(when.text, "Daily 10:00 · Asia/Shanghai · first run tomorrow")
        let draft = ScheduleDisplay.createWhen(ScheduleCardWhen(rule: .weekly(time: "09:00", weekdays: ["MON", "TUE", "WED", "THU", "FRI"]),
                                                                timezone: Self.tz, firstRunAt: sh("2025-11-17T09:00")),
                                               now: Self.now, viewerTimezone: Self.tz)
        XCTAssertEqual("\(draft.rule) · \(draft.zone)", "Weekdays at 09:00 · Asia/Shanghai")
        XCTAssertEqual(draft.firstRun, "First run Monday")
        let noZone = ScheduleDisplay.createWhen(ScheduleCardWhen(rule: .daily(time: "10:00"), timezone: nil, firstRunAt: nil),
                                                now: Self.now, viewerTimezone: Self.tz)
        XCTAssertEqual(noZone.text, "Daily 10:00 · your time zone")
    }

    func testWaitingOnYouCards() {
        XCTAssertEqual(ScheduleDisplay.failedWaiting(title: "Nightly pg spec sweep", consecutiveFailures: 3,
                                                     failureReason: "NO_REPORT", reasonText: nil,
                                                     plannedAt: sh("2025-11-14T02:00"), timezone: Self.tz),
                       .init(title: "Nightly pg spec sweep failed 3 runs in a row", kind: "Scheduled",
                             body: "The last run ended without a report (Nov 14, 02:00). It keeps running on schedule "
                                + "until you pause it. Open the run to see where it stopped, or ask a session to fix the prompt.",
                             actions: ["Open run", "Pause schedule"]))
        XCTAssertEqual(ScheduleDisplay.heldWaiting(title: "Weekly dependency audit", heldReason: "AGENT_DISABLED",
                                                   plannedAt: sh("2025-11-10T09:00"), agentName: "auditor",
                                                   workspaceName: "web",
                                                   now: ScheduleDisplay.parse(sh("2025-11-10T09:01"))!, timezone: Self.tz),
                       .init(title: "Weekly dependency audit is held", kind: "Scheduled",
                             body: "It could not start on Monday 09:00: the agent \"auditor\" in workspace web is disabled. "
                                + "Nothing runs until it is enabled and you resume.",
                             actions: ["Open agent settings", "Resume"]))
        XCTAssertEqual(ScheduleDisplay.approvalWaiting(title: "Nightly pg spec sweep", deadline: sh("2025-11-14T04:00"),
                                                       nextAt: sh("2025-11-15T02:00"), pattern: "psql:*",
                                                       workspaceName: "apiserver",
                                                       now: ScheduleDisplay.parse(sh("2025-11-14T02:03"))!, timezone: Self.tz),
                       .init(title: "Nightly pg spec sweep wants to run a command", kind: "Scheduled run",
                             body: "If nobody answers by 04:00 this run fails; the next one starts tomorrow.",
                             actions: ["Always allow", "Allow once", "Deny"],
                             alwaysAllow: "Always allow covers psql:* in apiserver: later runs won't ask for this."))
        let held = ScheduleDisplay.heldWaiting(title: "Audit", heldReason: "AGENT_DISABLED",
                                               plannedAt: sh("2025-10-27T09:00"), now: Self.now, timezone: Self.tz)
        XCTAssertEqual(held.body, "It could not start on Oct 27, 09:00: its agent is disabled. Nothing runs until it is "
                          + "enabled and you resume.")
    }

    /// S5's pushes, the reported failure's own words and the create card's last line (scheduleContract.spec.ts).
    func testThePushesTheReportedFailureAndTheNotice() {
        let push = ScheduleDisplay.failedPush(title: "Nightly pg spec sweep", consecutiveFailures: 3,
                                              failureReason: "NO_REPORT", reasonText: nil,
                                              plannedAt: "2026-11-13T18:00:00.000Z", timezone: Self.tz)
        XCTAssertEqual(push.title, "Nightly pg spec sweep failed 3 runs in a row")
        XCTAssertEqual(push.body, "The last run ended without a report. It keeps running until you pause it.")
        XCTAssertEqual(ScheduleDisplay.failedPush(title: "Codex stable check", consecutiveFailures: 1,
                                                  failureReason: "REPORTED_FAILED", reasonText: nil,
                                                  summary: "The releases page returned 503.",
                                                  plannedAt: "2026-11-14T02:00:00.000Z", timezone: Self.tz).body,
                       "The last run reported a failure: The releases page returned 503. It keeps running until you pause it.")
        XCTAssertTrue(ScheduleDisplay.failedWaiting(title: "Codex stable check", consecutiveFailures: 1,
                                                    failureReason: "REPORTED_FAILED", reasonText: nil,
                                                    summary: "The releases page returned 503.",
                                                    plannedAt: "2026-11-14T02:00:00.000Z", timezone: Self.tz)
            .body.hasPrefix("The last run reported a failure: The releases page returned 503 ("))
        XCTAssertEqual(ScheduleDisplay.goalReachedPushTitle("Release 2.0 freeze watch"), "Release 2.0 freeze watch ended itself")
        XCTAssertEqual(ScheduleDisplay.createNotice(findings: "versions"), "You'll hear about new versions and failures only.")
        XCTAssertEqual(ScheduleDisplay.createNotice(findings: "issues"), "You'll hear about new issues and failures only.")
        XCTAssertEqual(ScheduleDisplay.createNotice(findings: nil), ScheduleCopy.CreateCard.notice)
        XCTAssertEqual(ScheduleDisplay.createNotice(findings: "findings"), ScheduleCopy.CreateCard.notice)
    }

    /// S5's schedule names the agent and engine it uses in its workspace.
    func testTheScheduleNamesItsAgentAndEngine() throws {
        let row = """
        {"id":"a","title":"Weekly dependency audit","rule":{"kind":"WEEKLY","time":"09:00","weekdays":["MON"]},
         "timezone":"UTC","workspaceId":"w","workspaceName":"web","state":"HELD","heldReason":"AGENT_DISABLED",
         "agentName":"auditor","engine":"codex"}
        """
        let s = try JSONDecoder().decode(ScheduleView.self, from: Data(row.utf8))
        XCTAssertEqual(s.agentName, "auditor")
        XCTAssertEqual(ScheduleDisplay.heldWaiting(title: s.title, heldReason: s.heldReason,
                                                   plannedAt: sh("2025-11-10T09:00"), agentName: s.agentName,
                                                   workspaceName: s.workspaceName,
                                                   now: ScheduleDisplay.parse(sh("2025-11-10T09:01"))!, timezone: Self.tz).body,
                       "It could not start on Monday 09:00: the agent \"auditor\" in workspace web is disabled. "
                        + "Nothing runs until it is enabled and you resume.")
        XCTAssertEqual(s.engine, "codex")
        let card = try JSONDecoder().decode(ScheduleCard.self, from: Data(
            #"{"id":"c","kind":"CREATE","notice":"You'll hear about new versions and failures only."}"#.utf8))
        XCTAssertEqual(card.notice, "You'll hear about new versions and failures only.")
    }

    /// A failed press says what went wrong: only a dropped connection reads "Couldn't reach Orbit".
    func testAFailedPressSaysWhatWentWrong() throws {
        XCTAssertEqual(ScheduleDisplay.pressFailure(URLError(.notConnectedToInternet)), "Couldn't reach Orbit. Try again.")
        let unreadable: Error
        do { _ = try JSONDecoder().decode(ScheduleRule.self, from: Data(#"{"kind":"DAILY"}"#.utf8)); return XCTFail() }
        catch { unreadable = error }
        XCTAssertEqual(ScheduleDisplay.pressFailure(unreadable),
                       "Orbit answered, but this version of the app couldn't read the reply. "
                        + "Update the app; the card shows what Orbit did.")
        XCTAssertEqual(ScheduleDisplay.pressFailure(APIError.invalidResponse), ScheduleDisplay.PressFailure.unreadable)
        XCTAssertEqual(ScheduleDisplay.pressFailure(APIError.http(status: 409, body: #"{"message":"Already decided."}"#)),
                       "Already decided.")
        XCTAssertEqual(ScheduleDisplay.pressFailure(APIError.http(status: 502, body: "<html>")),
                       "Orbit couldn't do this (error 502). Try again.")
        XCTAssertEqual(ScheduleDisplay.pressFailure(APIError.unauthorized), "You're signed out. Sign in and try again.")
    }

    func testTheRunsSession() {
        XCTAssertEqual(ScheduleDisplay.runStripText(plannedAt: sh("2025-11-13T10:00"), startedAt: sh("2025-11-13T10:01"),
                                                    accessLevel: "CHECK_ONLY", timezone: Self.tz),
                       "Scheduled run · planned 10:00, started 10:01 · access Check only")
        XCTAssertEqual(ScheduleDisplay.runOfText(plannedAt: sh("2025-11-13T10:00"), timezone: Self.tz), "run of Nov 13")
        XCTAssertEqual(ScheduleDisplay.reportedText(state: "CHANGED", key: "codex@0.49.0", notified: true),
                       "Reported: Changed · codex@0.49.0 · you were notified")
        XCTAssertEqual(ScheduleDisplay.reportedText(state: "NO_CHANGE", key: nil), "Reported: No change")
    }

    func testDeleteTitle() {
        XCTAssertEqual(ScheduleDisplay.deleteTitle("Codex stable check"), "Delete “Codex stable check”?")
    }

    func testSessionDecodesScheduleRunID() throws {
        let json = """
        {"id":"R9","title":"Codex stable check","status":"AWAITING_INPUT","engine":"codex","lifecycleState":"OPEN",
         "scheduleRunId":"SR9"}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.scheduleRunId, "SR9")
    }

    /// The list's own timeline runs (W2) and a run's session's `run` decode, with the facts the list worked out.
    func testTheListsRunsAndTheSessionsRunDecode() throws {
        let list = """
        {"schedules":[{"id":"a","title":"A","rule":{"kind":"DAILY","time":"09:00"},"timezone":"UTC","workspaceId":"w",
          "state":"PAUSED","pausedAt":"2025-11-07T07:00:00.000Z"}],
         "runs":[{"id":"r","scheduleId":"a","plannedAt":"2025-11-14T02:00:00.000Z","state":"CHANGED","key":"k",
          "newFinding":true,"notified":true}]}
        """
        let read = try JSONDecoder().decode(ScheduleListResponse.self, from: Data(list.utf8))
        XCTAssertEqual(read.schedules.first?.pausedAt, "2025-11-07T07:00:00.000Z")
        let run = try XCTUnwrap(read.runs?.first)
        let facts = ScheduleDisplay.runFindingFacts(run, findings: [])
        XCTAssertTrue(facts.newFinding && facts.notified)
        XCTAssertNil(try JSONDecoder().decode(ScheduleListResponse.self, from: Data(#"{"schedules":[]}"#.utf8)).runs)
        let cards = """
        {"run":{"id":"r","scheduleId":"a","plannedAt":"2025-11-13T02:00:00.000Z","state":"RUNNING"},"cards":[],"records":[]}
        """
        XCTAssertEqual(try JSONDecoder().decode(SessionScheduleCardsResponse.self, from: Data(cards.utf8)).run?.id, "r")
    }

    func testFillLeavesAMissingPlaceholderShowing() {
        XCTAssertEqual(ScheduleDisplay.fill("{a} and {b}", ["a": "x"]), "x and {b}")
        XCTAssertEqual(ScheduleDisplay.fill("no { brace", [:]), "no { brace")
    }

    // MARK: decoding

    /// A create card and a list row as the server writes them (schedule-views.ts) decode with every field the
    /// cards draw; an unknown state or reason costs nothing.
    func testTheDoorsAnswersDecode() throws {
        let card = """
        {"id":"r1","kind":"CREATE","state":"PENDING","askedBy":"SESSION","askedBySessionId":"s1","scheduleId":null,
         "createdAt":"2025-11-14T02:00:00.000Z","decidedAt":null,"resultRevision":null,
         "decision":{"allow":"/api/schedule-requests/r1/allow","decline":"/api/schedule-requests/r1/decline"},
         "title":"Codex stable check","readBack":"Every day at 10:00…","intent":"every day at 10",
         "when":{"rule":{"kind":"DAILY","time":"10:00"},"timezone":null,"firstRunAt":null,"text":"Daily 10:00 · your time zone"},
         "runsIn":{"workspaceId":"w1","workspaceName":"apiserver","engine":"codex","text":"apiserver · Codex agent"},
         "may":{"accessLevel":"CHECK_ONLY","text":"Check only"},"costs":{"runsPerWeek":7,"runLimitMinutes":30,"text":"x"},
         "today":{"key":"codex@0.48.0","summary":"Codex 0.48.0, same as pinned.","text":"x"},"notice":"n","envelope":null}
        """
        let decoded = try JSONDecoder().decode(ScheduleCard.self, from: Data(card.utf8))
        XCTAssertTrue(decoded.isCreate && decoded.isPending)
        XCTAssertNil(decoded.when?.timezone)
        XCTAssertEqual(decoded.runsIn?.engine, "codex")
        XCTAssertEqual(decoded.costs?.runsPerWeek, 7)
        let list = """
        {"schedules":[{"id":"a","title":"A","rule":{"kind":"WEEKLY","time":"09:00","weekdays":["MON"]},"timezone":"UTC",
          "workspaceId":"w","state":"SOMETHING_NEW","consecutiveFailures":0,"lastRun":{"id":"r","scheduleId":"a",
          "plannedAt":"2025-11-14T02:00:00.000Z","state":"FAILED","failureReason":"A_NEW_REASON"}},
         {"id":"broken"}]}
        """
        let rows = try JSONDecoder().decode(ScheduleListResponse.self, from: Data(list.utf8)).schedules
        XCTAssertEqual(rows.map(\.id), ["a"], "a row this build cannot read is dropped, not the list")
        XCTAssertEqual(rows[0].rule, .weekly(time: "09:00", weekdays: ["MON"]))
        XCTAssertEqual(rows[0].lastRun?.failureReason, "A_NEW_REASON")
        XCTAssertNil(ScheduleDisplay.failureClause(failureReason: "A_NEW_REASON", reasonText: nil))
    }

    /// The four Waiting on you kinds ride the owner-request list beside the kinds `OwnerRequest` reads; neither
    /// read drops the other's rows, and an unknown kind is still dropped by both.
    func testScheduleItemsRideTheOwnerRequestList() throws {
        let json = """
        {"requests":[
          {"id":"o1","kind":"SCHEDULE_FAILED","state":"PENDING","title":"t","why":"w","scheduleId":"S1",
           "scheduleRunId":"R1","askedBySessionId":"s","createdAt":"2025-11-14T02:41:00.000Z"},
          {"id":"o2","kind":"DECISION","state":"PENDING","title":"t","why":"w","askedBySessionId":"s",
           "createdAt":"2025-11-14T02:41:00.000Z","blocksTaskIds":[]},
          {"id":"o3","kind":"SOMETHING_ELSE","state":"PENDING","title":"t","why":"w","askedBySessionId":"s",
           "createdAt":"2025-11-14T02:41:00.000Z"}]}
        """
        let list = try JSONDecoder().decode(OwnerRequestList.self, from: Data(json.utf8))
        XCTAssertEqual(list.requests.map(\.id), ["o2"])
        XCTAssertEqual(list.scheduleItems.map(\.id), ["o1"])
        XCTAssertEqual(list.scheduleItems.first?.scheduleRunId, "R1")
    }

    /// A schedule's push opens the run's session when it names one, else the schedule — whatever item it names.
    func testASchedulePushOpensTheRunOrTheSchedule() {
        let tap = "com.apple.UNNotificationDefaultActionIdentifier"
        XCTAssertEqual(Notifications.intent(actionId: tap, userInfo: ["kind": "schedule", "scheduleID": "S1",
                                                                      "sessionID": "X1", "ownerRequestID": "O1"]),
                       .openSchedule(scheduleID: "S1", sessionID: "X1"))
        XCTAssertEqual(Notifications.intent(actionId: tap, userInfo: ["kind": "schedule", "scheduleID": "S1"]),
                       .openSchedule(scheduleID: "S1", sessionID: nil))
    }

    func testTheDrawerPutsScheduledUnderTasks() {
        // No Waiting on you row (docs/mocks/waiting-on-you-removal; the owner, 2026-11-16): Scheduled keeps its own.
        XCTAssertEqual(DrawerWorkLogic.rows(AppSection.workSections, wiki: true, scheduled: true),
                       [.projects, .section(.tasks), .scheduled, .wiki, .workspacesHeader, .agents,
                        .openProjects, .sharedWithMe])
        XCTAssertFalse(DrawerWorkLogic.rows(AppSection.workSections, wiki: true).contains(.scheduled),
                       "the Mac's source list and an old call leave it out until they draw it")
        XCTAssertEqual(AppSection.scheduled.title, "Scheduled")
    }
}
