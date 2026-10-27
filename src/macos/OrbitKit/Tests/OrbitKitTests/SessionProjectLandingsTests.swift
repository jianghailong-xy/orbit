import Foundation
import XCTest
@testable import OrbitKit

/// The project's Landings window and its one row on the sessions page (owner 2026-10-27,
/// docs/mocks/landings-one-window; contract §2.9 LS6, revision 28). Held to
/// `src/web/src/lib/sessionProjects.test.ts`. Every instant is built in the reader's own calendar, so
/// the day sections and today's counts read the same in any zone.
final class SessionProjectLandingsTests: XCTestCase {
    private let calendar = Calendar.current
    /// Tuesday 2026-10-27, 10:20 — the board's moment.
    private var now: Date { local(27, 10, 20) }

    private func local(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    private func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    private func row(_ id: String, title: String? = nil, subject: String = "TASK", state: String,
                     settledAs: String? = nil, settledAt: Date? = nil, createdAt: Date? = nil) -> Session {
        Session(id: id, title: title ?? "Land · \(id)", status: .succeeded, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil,
                createdAt: iso(createdAt ?? local(27, 8)),
                landing: SessionLandingView(subject: subject, settledAt: settledAt.map(iso),
                                            settledAs: settledAs, state: state))
    }

    private func merged(_ id: String, at: Date, session: String?, automatic: Bool = true) -> ProjectPromotionView {
        ProjectPromotionView(promotionId: id, state: .merged, sourceRef: "refs/heads/project/p1", sourceSha: "a",
                             upstreamRef: "refs/heads/main", taskIds: ["t1", "t2"],
                             merged: .init(sha: "3f1c2a9000000000000000000000000000000000", at: iso(at),
                                           automatic: automatic),
                             landingSessionId: session)
    }

    private func clock(_ date: Date) -> String { ProjectPage.landingClockTime(date) }

    func testGroupsTheSettledOnesByTheSessionListsDaysOldestFirstAndKeepsEveryOne() {
        let window = SessionProjectLandings.window([
            row("Fix the deep link", state: "SETTLED", settledAs: "NOTHING_TO_LAND", settledAt: local(27, 8, 30)),
            row("Ledger migration order", state: "SETTLED", settledAs: "LANDED", settledAt: local(26, 17, 42)),
            row("Runner model order", state: "SETTLED", settledAs: "LANDED", settledAt: local(27, 10, 2)),
            row("Month-old fix", state: "SETTLED", settledAs: "CANCELLED", settledAt: local(1, 9)),
            row("Wiki review link", state: "SETTLED", settledAs: "ALREADY_LANDED", settledAt: local(27, 9, 5)),
        ], merges: [], now: now, calendar: calendar)
        XCTAssertEqual(window.days.map(\.title), ["8–30 days ago", "Yesterday", "Today"])
        XCTAssertEqual(window.days[2].rows.map(\.title), ["Fix the deep link", "Wiki review link", "Runner model order"])
        XCTAssertEqual(window.days[2].rows.map { "\($0.time) \($0.detail) \($0.tone.rawValue)" }, [
            "\(clock(local(27, 8, 30))) Nothing to land quiet",
            "\(clock(local(27, 9, 5))) Already landed ok",
            "\(clock(local(27, 10, 2))) Landed ok",
        ])
        XCTAssertEqual(window.days[0].rows[0].detail, "Cancelled")
        XCTAssertEqual(window.now, [])
    }

    func testPutsWhatIsInHandUnderNowInTheOrderItStarted() {
        let window = SessionProjectLandings.window([
            row("Checks failed", state: "AWAITING_DECISION", createdAt: local(27, 10, 1)),
            row("Still landing", state: "IN_FLIGHT", createdAt: local(27, 9, 40)),
            row("round", title: "Merge project/p1 → main · #12", subject: "PROMOTION", state: "IN_FLIGHT",
                createdAt: local(27, 10, 5)),
        ], merges: [], now: now, calendar: calendar)
        XCTAssertEqual(window.days, [])
        XCTAssertEqual(window.now.map { "\($0.title)|\($0.state)|\($0.subject)" }, [
            "Still landing|IN_FLIGHT|TASK",
            "Checks failed|AWAITING_DECISION|TASK",
            "Merge project/p1 → main · #12|IN_FLIGHT|PROMOTION",
        ])
    }

    func testJoinsAMergeIntoMainWithItsRoundsLandingSessionByLandingSessionIdOneRow() {
        let window = SessionProjectLandings.window([
            row("S-12", title: "Merge project/p1 → main · #12", subject: "PROMOTION", state: "SETTLED",
                settledAs: "MERGED", settledAt: local(27, 9, 52)),
        ], merges: [merged("P-12", at: local(27, 9, 51), session: "S-12")], now: now, calendar: calendar)
        XCTAssertEqual(window.days.count, 1)
        XCTAssertEqual(window.days[0].rows.count, 1)
        let row = window.days[0].rows[0]
        XCTAssertEqual(row.key, "S-12")
        XCTAssertEqual(row.sessionId, "S-12")
        XCTAssertEqual(row.title, "Merged into main")
        XCTAssertEqual(row.detail, "3f1c2a9 · 2 tasks · automatically")
        XCTAssertEqual(row.tone, .merge)
        XCTAssertEqual(row.time, clock(local(27, 9, 51)))
        XCTAssertEqual(row.promotion?.promotionId, "P-12")
    }

    func testKeepsAMergeOlderThanLandingSessionsAndARoundPastTheTwentyRecords() {
        let window = SessionProjectLandings.window([
            row("S-3", title: "Merge project/p1 → main · #3", subject: "PROMOTION", state: "SETTLED",
                settledAs: "MERGED", settledAt: local(25, 15)),
        ], merges: [merged("P-1", at: local(26, 11, 30), session: nil, automatic: false)], now: now, calendar: calendar)
        XCTAssertEqual(window.days.map(\.title), ["2–7 days ago", "Yesterday"])
        let round = window.days[0].rows[0]
        XCTAssertEqual(round.key, "S-3")
        XCTAssertEqual(round.title, "Merged into main")
        XCTAssertEqual(round.detail, "Merge project/p1 → main · #3")
        XCTAssertNil(round.promotion)
        let old = window.days[1].rows[0]
        XCTAssertEqual(old.key, "merge:P-1")
        XCTAssertNil(old.sessionId)
        XCTAssertEqual(old.detail, "3f1c2a9 · 2 tasks · by you")
        XCTAssertEqual(old.time, clock(local(26, 11, 30)))
    }

    func testNamesATaskSegmentByItsTaskAndARoundThatDidNotMergeByItsOwnTitle() {
        XCTAssertEqual(SessionProjectLandings.taskName("Land · Ledger migration order"), "Ledger migration order")
        XCTAssertEqual(SessionProjectLandings.taskName("Land · Ledger migration order (#2)"),
                       "Ledger migration order (#2)")
        XCTAssertEqual(SessionProjectLandings.taskName("Something else"), "Something else")
        let window = SessionProjectLandings.window([
            row("declined", title: "Merge project/p1 → main · #4", subject: "PROMOTION", state: "SETTLED",
                settledAs: "DECLINED", settledAt: local(27, 9)),
        ], merges: [], now: now, calendar: calendar)
        XCTAssertEqual(window.days[0].rows[0].title, "Merge project/p1 → main · #4")
        XCTAssertEqual(window.days[0].rows[0].detail, "Declined")
    }

    func testCountsTheRowAZeroIsLeftOutTodaysTwoShareOneTodayAndAllZeroIsNothingLandedToday() {
        XCTAssertEqual(SessionProjectLandings.countLine(waiting: 1, inFlight: 1, landed: 3, merged: 1),
                       "1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today")
        XCTAssertEqual(SessionProjectLandings.countLine(waiting: 0, inFlight: 2, landed: 0, merged: 0), "2 in flight")
        XCTAssertEqual(SessionProjectLandings.countLine(waiting: 0, inFlight: 0, landed: 2, merged: 0), "2 landed today")
        XCTAssertEqual(SessionProjectLandings.countLine(waiting: 0, inFlight: 0, landed: 0, merged: 1, main: "master"),
                       "1 merged into master today")
        XCTAssertEqual(SessionProjectLandings.countLine(waiting: 2, inFlight: 0, landed: 0, merged: 0),
                       "2 waiting for a decision")
        XCTAssertEqual(SessionProjectLandings.countLine(waiting: 0, inFlight: 0, landed: 0, merged: 0),
                       "Nothing landed today")
    }

    func testMarksTheRowByTheMostUrgentLandingAndTimesTheLongestWait() {
        let rows = [
            row("Checks failed", state: "AWAITING_DECISION", createdAt: now.addingTimeInterval(-18 * 60)),
            row("Still landing", state: "IN_FLIGHT"),
            row("a", state: "SETTLED", settledAs: "LANDED", settledAt: local(27, 9)),
            row("b", state: "SETTLED", settledAs: "LANDED", settledAt: local(27, 9, 30)),
            row("c", state: "SETTLED", settledAs: "ALREADY_LANDED", settledAt: local(27, 10)),
            row("yesterday", state: "SETTLED", settledAs: "LANDED", settledAt: local(26, 22)),
            row("nothing", state: "SETTLED", settledAs: "NOTHING_TO_LAND", settledAt: local(27, 8)),
        ]
        XCTAssertEqual(SessionProjectLandings.rowSummary(rows, merges: [merged("P-1", at: local(27, 9, 51), session: nil)],
                                                         now: now, calendar: calendar),
                       LandingsRowSummary(mark: .fail, time: "18m",
                                          line: "1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today"))
        XCTAssertEqual(SessionProjectLandings.rowSummary(Array(rows.dropFirst()), merges: [], now: now, calendar: calendar),
                       LandingsRowSummary(mark: .running, time: "20m", line: "1 in flight · 3 landed today"))
        XCTAssertEqual(SessionProjectLandings.rowSummary(Array(rows.dropFirst(2)), merges: [], now: now,
                                                         calendar: calendar)?.mark, .ok)
    }

    func testSaysNothingLandedTodayOverAQuietDayAndIsNoRowForAProjectThatNeverHadALanding() {
        XCTAssertEqual(SessionProjectLandings.rowSummary([
            row("yesterday", state: "SETTLED", settledAs: "LANDED", settledAt: local(26, 22)),
        ], merges: [], now: now, calendar: calendar),
                       LandingsRowSummary(mark: .ok, time: "12h", line: "Nothing landed today"))
        // A merge older than landing sessions is a landing the project had.
        XCTAssertEqual(SessionProjectLandings.rowSummary([], merges: [merged("P-1", at: local(20, 9), session: nil)],
                                                         now: now, calendar: calendar)?.line, "Nothing landed today")
        XCTAssertNil(SessionProjectLandings.rowSummary([], merges: [], now: now, calendar: calendar))
        // A conversation carries no landing summary and is no landing.
        let chat = Session(id: "chat", title: "chat", status: .succeeded, agentId: nil,
                           assignedRunnerId: nil, pendingApprovals: nil, branch: nil,
                           updatedAt: nil, createdAt: iso(local(27, 9)))
        XCTAssertNil(SessionProjectLandings.rowSummary([chat], merges: [], now: now, calendar: calendar))
    }

    // MARK: - the source session's derived label

    private func source(_ over: (inout SourceBuilder) -> Void = { _ in }) -> SessionSourceLanding {
        var b = SourceBuilder()
        over(&b)
        return SessionSourceLanding(landingSessionId: "S1", subject: b.subject, state: b.state,
                                    phase: b.phase, settledAs: b.settledAs,
                                    targetRef: b.targetRef)
    }

    private struct SourceBuilder {
        var subject = "TASK"
        var state = "RUNNING"
        var phase: String? = "CHECK"
        var settledAs: String? = nil
        var targetRef = "refs/heads/project/p1"
    }

    func testTheSourceLabelSaysCheckingWhileItMovesTheBranchOnceItLandedAndWhatStoppedIt() {
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source()),
                       SourceLandingLabel(text: "Landing · checking", tone: "run"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source { $0.phase = "REBASE" }),
                       SourceLandingLabel(text: "Landing · rebasing", tone: "run"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source { $0.state = "QUEUED"; $0.phase = nil }),
                       SourceLandingLabel(text: "Landing · queued", tone: "run"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source { $0.settledAs = "LANDED" }),
                       SourceLandingLabel(text: "On project/p1 ✓", tone: "landed"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source {
            $0.state = "CHECK_FAILED"; $0.settledAs = nil
        }), SourceLandingLabel(text: "Landing · checks failed", tone: "failed"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source { $0.state = "CONFLICT" })?.tone,
                       "failed")
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source { $0.state = "ERROR" })?.text,
                       "Landing · error")
    }

    func testTheSourceLabelSaysWhereAMergeRoundPutTheWorkByTheProjectsMainBranch() {
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source {
            $0.subject = "PROMOTION"; $0.settledAs = "MERGED"
        }), SourceLandingLabel(text: "On main ✓", tone: "landed"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source {
            $0.subject = "PROMOTION"; $0.settledAs = "MERGED"
        }, main: "master"), SourceLandingLabel(text: "On master ✓", tone: "landed"))
        XCTAssertEqual(SessionProjectLandings.sourceLabel(source { $0.settledAs = "NOTHING_TO_LAND" }),
                       SourceLandingLabel(text: "Nothing to land", tone: "quiet"))
    }

    func testTheSourceLabelIsNothingAtAllForAConversationThatFedNoLanding() {
        XCTAssertNil(SessionProjectLandings.sourceLabel(nil))
    }
}

/// The X-E5 owner card (§4.6 revision 23, board v4 06): its heading counts the claim's silence, its
/// lead is the server's own ABANDON, and its consequence follows J12's two facts.
final class LandingOpenItemDoorTests: XCTestCase {
    private func lease(protocol progressProtocol: String? = "v2",
                       jobKind: String? = "LAND_TASK",
                       pushReported: Bool = false,
                       round: Int = 1, checkCount: Int? = 3) -> ProjectOpenItemRow.OpenItemLease {
        ProjectOpenItemRow.OpenItemLease(
            lastReportAt: "2026-09-25T06:30:00.000Z",
            leaseExpiredAt: "2026-09-25T06:40:00.000Z",
            jobKind: jobKind, generation: 3, phase: "CHECK",
            claimGeneration: 1, round: round, checkCount: checkCount, runner: "wikova",
            progressProtocol: progressProtocol, pushReported: pushReported)
    }

    private func row(_ lease: ProjectOpenItemRow.OpenItemLease? = nil,
                     actions: [ProjectOpenItemAction] = [.abandon, .openLanding],
                     primaryAction: ProjectOpenItemAction? = .abandon,
                     facts: OpenItemFacts? = nil) -> ProjectOpenItemRow {
        ProjectOpenItemRow(
            itemId: "item-1", kind: .landingLeaseExpired,
            title: "A landing stopped reporting",
            waitingSince: "2026-09-25T06:30:00.000Z", assignee: .owner,
            assigneeReason: .escalated, escalatedAt: "2026-09-25T06:57:00.000Z",
            taskId: "t1", sessionId: nil, promotionId: nil,
            landingSessionId: "landing-1", integrationJobId: "job-1",
            lease: lease, actions: actions, primaryAction: primaryAction, facts: facts)
    }

    /// The board's three lease rows (06 c), replacing the item's own sentence.
    func testTheXE5CardDrawsTheClaimsThreeRows() throws {
        let item = row(lease(jobKind: "CHECK_PROMOTION"),
                       facts: OpenItemFacts(task: .init(id: "T1", title: "Ledger migration order")))
        guard case .rows(let block) = ExceptionCards.facts(item) else {
            return XCTFail("X-E5 draws the lease's rows, not the item's sentence")
        }
        XCTAssertEqual(block.rows.map(\.label),
                       ["Landing", "Runner", "Step"])
        XCTAssertEqual(block.rows[0].value, "Ledger migration order · generation 3")
        let reported = ProjectPage.landingClockTime(RelativeTime.parse("2026-09-25T06:30:00.000Z")!)
        let expired = ProjectPage.landingClockTime(RelativeTime.parse("2026-09-25T06:40:00.000Z")!)
        XCTAssertEqual(block.rows[1].value,
                       "wikova · last report \(reported) · lease expired \(expired)")
        // A merge check has one round per claim: no M, whatever its `checkCount` (3) says (§7.2 V6).
        XCTAssertEqual(block.rows[2].value, "checking · claim 1 · round 1")
        // An item that predates the lease facts keeps the sentence it always drew.
        guard case .detailLine = ExceptionCards.facts(row(nil)) else {
            return XCTFail("a row with no lease keeps its detail line")
        }
    }

    /// The Step row's M is the job kind's most rounds per claim, never `checkCount`.
    func testTheXE5StepRowTakesTheRoundsMFromTheJobKind() {
        func step(_ lease: ProjectOpenItemRow.OpenItemLease) -> String? {
            guard case .rows(let block) = ExceptionCards.facts(row(lease)) else { return nil }
            return block.rows.first { $0.label == ExceptionCards.stepFactLabel }?.value
        }
        XCTAssertEqual(step(lease(round: 2, checkCount: 2)), "checking · claim 1 · round 2 of 3")
        XCTAssertEqual(step(lease(checkCount: nil)), "checking · claim 1 · round 1 of 3")
        XCTAssertEqual(step(lease(jobKind: "CHECK_PROMOTION", round: 2)), "checking · claim 1 · round 2")
        XCTAssertEqual(step(lease(jobKind: "LAND_PROMOTION", checkCount: 1)), "checking · claim 1 · round 1")
        XCTAssertEqual(step(lease(jobKind: nil)), "checking · claim 1 · round 1")
    }

    /// X-E5 is escalated at birth, so the footer says the wait alone; and its cell is hand-closable.
    func testTheXE5FooterSaysTheWaitAloneAndTheCardCanBeClosedByHand() {
        let item = row(lease())
        let line = ExceptionCards.ownerLine(item)
        XCTAssertTrue(line.hasPrefix("Owner: you · waiting "), line)
        XCTAssertFalse(line.contains("came to the owner at"),
                       "an item escalated at birth has no window to name")
        XCTAssertTrue(ExceptionCards.markable(item),
                      "the server's X-E5 cell takes the owner's own ending")
    }

    func testTheXE5HeadingCountsTheClaimsSilence() {
        XCTAssertEqual(ExceptionCards.heading(row(lease())),
                       "Now yours — no report from the runner for 27m")
        // A row that predates the claim facts leaves the number out rather than inventing one.
        XCTAssertEqual(ExceptionCards.heading(row(nil)),
                       "Now yours — no report from the runner")
    }

    func testTheXE5CardLeadsWithTheServersAbandonAndDrawsBothDoors() {
        let item = row(lease())
        let presses = ExceptionCards.presses(item)
        XCTAssertEqual(presses.first?.action, .abandon)
        XCTAssertEqual(presses.first?.tier, .primary)
        XCTAssertEqual(presses.map(\.action), [.abandon, .openLanding])
        XCTAssertEqual(presses.last?.label, "Open landing")
        XCTAssertEqual(presses.last?.consequence,
                       "Open the landing: every attempt, step by step.")
    }

    func testAnOlderServerWithoutAPrimaryActionStillLeadsWithAbandon() {
        let item = row(lease(), actions: [.openLanding, .abandon], primaryAction: nil)
        XCTAssertEqual(ExceptionCards.presses(item).first?.action, .abandon)
    }

    func testJ12DecidesTheAbandonsPushHalf() {
        // A check never pushes: nothing was pushed.
        XCTAssertEqual(ExceptionCards.actionConsequence(
            row(lease(jobKind: "CHECK_PROMOTION")), .abandon),
            "Ends this attempt. Nothing was pushed, and nothing is queued again.")
        // A v2 claim that never recorded a PUSH proves none happened.
        XCTAssertEqual(ExceptionCards.actionConsequence(row(lease()), .abandon),
                       "Ends this attempt. Nothing was pushed, and nothing is queued again.")
        // Everything else may have been pushed, and the card says so.
        XCTAssertEqual(ExceptionCards.actionConsequence(
            row(lease(protocol: nil)), .abandon),
            "Ends this attempt. It may have been pushed, and nothing is queued again.")
    }

    func testTheDoorsAreDrawnOnlyWhereTheirAddressIsPresent() {
        // A row an older build opened names no landing: OPEN_LANDING is not drawn.
        let noLanding = ProjectOpenItemRow(
            itemId: "i", kind: .integrationCheckFailed, title: "Checks failed",
            waitingSince: "2026-09-25T06:30:00.000Z", sessionId: "s-1",
            landingSessionId: nil, integrationJobId: nil,
            actions: [.openTaskSession, .openLanding, .abandon])
        XCTAssertEqual(ExceptionCards.drawn(noLanding).filter { $0 == .openLanding }, [])
        XCTAssertEqual(ExceptionCards.drawn(noLanding).filter { $0 == .abandon }, [])
        // With both ids the doors are drawn, in the server's own order.
        let full = ProjectOpenItemRow(
            itemId: "i", kind: .landingLeaseExpired, title: "A landing stopped reporting",
            waitingSince: "2026-09-25T06:30:00.000Z",
            landingSessionId: "landing-1", integrationJobId: "job-1",
            actions: [.abandon, .openLanding])
        XCTAssertEqual(ExceptionCards.drawn(full), [.abandon, .openLanding])
    }
}
