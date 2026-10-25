import Foundation
import XCTest
@testable import OrbitKit

/// The Landings group (contract §2.9 LS6, board v4 04 c1): what waits on a decision, what settled in
/// the last day, one folded line for everything older — and never a landing still in flight, nor a
/// round of merging that already merged. Held to `src/web/src/lib/sessionProjects.test.ts`.
final class SessionProjectLandingsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func ago(_ minutes: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: now.addingTimeInterval(-minutes * 60))
    }

    private func row(_ id: String,
                     subject: String = "TASK",
                     state: String,
                     settledAs: String? = nil,
                     settledAt: String? = nil,
                     createdAt: String? = nil) -> Session {
        Session(id: id, title: id, status: .succeeded, agentId: nil, assignedRunnerId: nil,
                pendingApprovals: nil, branch: nil, updatedAt: nil,
                createdAt: createdAt ?? ago(15),
                landing: SessionLandingView(subject: subject, settledAt: settledAt,
                                            settledAs: settledAs, state: state))
    }

    func testListsWhatWaitsAndWhatSettledWithinTheDayWaitingFirstAndNeverWhatMoves() throws {
        let group = try XCTUnwrap(SessionProjectLandings.group([
            row("in-flight", state: "IN_FLIGHT"),
            row("waiting", state: "AWAITING_DECISION"),
            row("landed-now", state: "SETTLED", settledAs: "LANDED", settledAt: ago(60)),
            row("nothing-now", state: "SETTLED", settledAs: "NOTHING_TO_LAND", settledAt: ago(120)),
        ], now: now))
        XCTAssertEqual(group.waiting.map(\.id), ["waiting"])
        XCTAssertEqual(group.settled.map(\.id), ["landed-now", "nothing-now"])
        XCTAssertNil(group.earlier)
        XCTAssertEqual(group.waiting[0].detail, "Waiting for a decision")
        XCTAssertEqual(group.waiting[0].time, "15m")
        XCTAssertEqual(group.waiting[0].tone, .quiet)
        XCTAssertEqual(group.settled.map(\.detail), ["Landed", "Nothing to land"])
        XCTAssertEqual(group.settled[0].tone, .ok)
        XCTAssertEqual(group.settled[1].tone, .quiet)
    }

    func testSaysWhichSideHoldsAWaitingLandingInTheOpenItemsOwnWords() throws {
        let holders = [
            "waiting": LandingHolder(reason: "Checks failed", assignee: "COORDINATOR"),
            "mine": LandingHolder(reason: "Merge conflict", assignee: "OWNER"),
        ]
        let group = try XCTUnwrap(SessionProjectLandings.group([
            row("waiting", state: "AWAITING_DECISION"),
            row("mine", state: "AWAITING_DECISION", createdAt: ago(40)),
            row("bare", state: "AWAITING_DECISION", createdAt: ago(5)),
        ], now: now, holders: holders))
        // Longest wait first: this group answers "what is stuck".
        XCTAssertEqual(group.waiting.map(\.id), ["mine", "waiting", "bare"])
        XCTAssertEqual(group.waiting.map(\.detail), [
            "Merge conflict · with you", "Checks failed · with the coordinator",
            "Waiting for a decision",
        ])
        XCTAssertEqual(group.waiting.map(\.tone), [.fail, .fail, .quiet])
    }

    func testFoldsEverythingOlderThanTheDayIntoOneLineAndKeepsItToOpen() throws {
        let group = try XCTUnwrap(SessionProjectLandings.group([
            row("recent", state: "SETTLED", settledAs: "LANDED", settledAt: ago(60)),
            row("old-landed", state: "SETTLED", settledAs: "ALREADY_LANDED", settledAt: ago(26 * 60)),
            row("old-nothing", state: "SETTLED", settledAs: "NOTHING_TO_LAND", settledAt: ago(30 * 60)),
            row("older-still", state: "SETTLED", settledAs: "LANDED", settledAt: ago(50 * 60)),
        ], now: now))
        XCTAssertEqual(group.settled.map(\.id), ["recent"])
        XCTAssertEqual(group.earlier, LandingEarlier(landed: 2, nothing: 1))
        XCTAssertEqual(SessionProjectLandings.earlierLine(landed: 2, nothing: 1),
                       "Earlier · 2 landed · 1 nothing to land")
        XCTAssertEqual(group.older.map(\.id), ["old-landed", "old-nothing", "older-still"])
    }

    func testLeavesASegmentWhoseCountIsZeroOutOfTheFoldsLine() throws {
        XCTAssertEqual(SessionProjectLandings.earlierLine(landed: 2, nothing: 0), "Earlier · 2 landed")
        XCTAssertEqual(SessionProjectLandings.earlierLine(landed: 0, nothing: 1),
                       "Earlier · 1 nothing to land")
        // Only landed: the fold says so, and still opens to every older row, the cancelled one too.
        let landedOnly = try XCTUnwrap(SessionProjectLandings.group([
            row("old-landed", state: "SETTLED", settledAs: "LANDED", settledAt: ago(26 * 60)),
            row("old-again", state: "SETTLED", settledAs: "ALREADY_LANDED", settledAt: ago(28 * 60)),
            row("old-cancelled", state: "SETTLED", settledAs: "CANCELLED", settledAt: ago(30 * 60)),
        ], now: now))
        XCTAssertEqual(landedOnly.earlier, LandingEarlier(landed: 2, nothing: 0))
        XCTAssertEqual(landedOnly.older.map(\.id), ["old-landed", "old-again", "old-cancelled"])
        let nothingOnly = try XCTUnwrap(SessionProjectLandings.group([
            row("old-nothing", state: "SETTLED", settledAs: "NOTHING_TO_LAND", settledAt: ago(26 * 60)),
        ], now: now))
        XCTAssertEqual(nothingOnly.earlier, LandingEarlier(landed: 0, nothing: 1))
    }

    func testFoldsOlderLandingsNeitherCountNamesUnderABareEarlierAndOpensToThem() throws {
        XCTAssertEqual(SessionProjectLandings.earlierLine(landed: 0, nothing: 0), "Earlier")
        let old = [
            row("old-cancelled", state: "SETTLED", settledAs: "CANCELLED", settledAt: ago(26 * 60)),
            row("old-handled", state: "SETTLED", settledAs: "HANDLED", settledAt: ago(30 * 60)),
            row("old-declined", state: "SETTLED", settledAs: "DECLINED", settledAt: ago(32 * 60)),
            row("no-instant", state: "SETTLED", settledAs: "CANCELLED"),
        ]
        let group = try XCTUnwrap(SessionProjectLandings.group(
            [row("waiting", state: "AWAITING_DECISION")] + old, now: now))
        XCTAssertEqual(group.waiting.map(\.id), ["waiting"])
        let earlier = try XCTUnwrap(group.earlier)
        XCTAssertEqual(earlier, LandingEarlier(landed: 0, nothing: 0))
        XCTAssertEqual(SessionProjectLandings.earlierLine(landed: earlier.landed, nothing: earlier.nothing),
                       "Earlier")
        XCTAssertEqual(group.older.map(\.id), ["old-cancelled", "old-handled", "old-declined", "no-instant"])
        XCTAssertEqual(group.older.map(\.detail), ["Cancelled", "Handled", "Declined", "Cancelled"])
        // …and with nothing else to list, the group is still there: the fold is its one row.
        let alone = try XCTUnwrap(SessionProjectLandings.group(old, now: now))
        XCTAssertTrue(alone.waiting.isEmpty)
        XCTAssertTrue(alone.settled.isEmpty)
        XCTAssertEqual(alone.earlier, LandingEarlier(landed: 0, nothing: 0))
        XCTAssertEqual(alone.older.map(\.id), ["old-cancelled", "old-handled", "old-declined", "no-instant"])
        XCTAssertFalse(alone.isEmpty)
    }

    func testHasNoFoldWithNothingOlderAndIsNoGroupWithNothingElseToList() throws {
        let group = try XCTUnwrap(SessionProjectLandings.group([
            row("waiting", state: "AWAITING_DECISION"),
            row("cancelled-now", state: "SETTLED", settledAs: "CANCELLED", settledAt: ago(60)),
            // A round of merging that merged is never an older row, however old.
            row("old-round", subject: "PROMOTION", state: "SETTLED", settledAs: "MERGED",
                settledAt: ago(30 * 60)),
        ], now: now))
        XCTAssertEqual(group.waiting.map(\.id), ["waiting"])
        XCTAssertEqual(group.settled.map(\.id), ["cancelled-now"])
        XCTAssertNil(group.earlier)
        XCTAssertTrue(group.older.isEmpty)
        XCTAssertNil(SessionProjectLandings.group([
            row("moving", state: "IN_FLIGHT"),
            row("old-round", subject: "PROMOTION", state: "SETTLED", settledAs: "MERGED",
                settledAt: ago(30 * 60)),
        ], now: now))
    }

    func testNeverListsARoundOfMergingThatMerged() throws {
        let group = try XCTUnwrap(SessionProjectLandings.group([
            row("round", subject: "PROMOTION", state: "SETTLED", settledAs: "MERGED",
                settledAt: ago(30)),
            row("waiting", state: "AWAITING_DECISION"),
        ], now: now))
        XCTAssertTrue(group.settled.isEmpty)
        XCTAssertNil(group.earlier)
        // …and a project with nothing but that round has no group at all.
        XCTAssertNil(SessionProjectLandings.group([
            row("round-only", subject: "PROMOTION", state: "SETTLED", settledAs: "MERGED",
                settledAt: ago(30)),
            row("moving", state: "IN_FLIGHT"),
        ], now: now))
    }

    func testIsNoGroupAtAllWhenThereIsNothingToList() {
        XCTAssertNil(SessionProjectLandings.group([], now: now))
        XCTAssertNil(SessionProjectLandings.group([row("moving", state: "IN_FLIGHT")], now: now))
        // A conversation row carries no landing summary and is skipped, not drawn as a blank landing.
        let chat = Session(id: "chat", title: "chat", status: .succeeded, agentId: nil,
                           assignedRunnerId: nil, pendingApprovals: nil, branch: nil,
                           updatedAt: nil, createdAt: ago(5))
        XCTAssertNil(SessionProjectLandings.group([chat], now: now))
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

    // MARK: - the group's item reasons

    func testAnOpenItemsKindNamesTheGroupsOutcome() {
        XCTAssertEqual(SessionProjectLandings.itemReason(.integrationConflict), "Merge conflict")
        XCTAssertEqual(SessionProjectLandings.itemReason(.integrationCheckFailed), "Checks failed")
        XCTAssertEqual(SessionProjectLandings.itemReason(.integrationError), "Integration error")
        XCTAssertEqual(SessionProjectLandings.itemReason(.taskFailed), "Task failed")
        XCTAssertEqual(SessionProjectLandings.itemReason(.deliveryReview), "Delivery review")
        XCTAssertEqual(SessionProjectLandings.itemReason(.landingLeaseExpired),
                       "No report from the runner")
        XCTAssertNil(SessionProjectLandings.itemReason(.coordinatorQuestion))
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
